import { type UIEventHandler, useEffect, useMemo, useRef, useState } from 'react'
import { DropzoneOverlay } from '../components/DropzoneOverlay'
import { ImportProgressPopup } from '../components/ImportProgressPopup'
import { LibraryGrid } from '../components/LibraryGrid'
import { Sidebar } from '../components/Sidebar'
import { Topbar } from '../components/Topbar'
import { useLibraryContext } from '../context/LibraryContext'
import { exportAllDocumentsAsZip, type ExportProgress } from '../lib/exportAllDocumentsZip'
import type { BackupImportKind, CollectionFilter, DocumentRecord } from '../types'

const LIBRARY_COLLECTION_KEY = 'flexcil-library-selected-collection-v1'
const LIBRARY_QUERY_KEY = 'flexcil-library-query-v1'
const LIBRARY_SCROLL_TOP_KEY = 'flexcil-library-scroll-top-v1'
const LIBRARY_PREVIEW_MODE_KEY = 'flexcil-library-preview-mode-v1'
const LIBRARY_GRID_SIZE_KEY = 'flexcil-library-grid-size-v1'

type LibraryPreviewMode = 'default' | 'a4' | 'original'
type LibraryGridSize = 'compact' | 'comfortable' | 'large'

function isCollectionFilter(value: unknown): value is CollectionFilter {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return false
  }

  const type = (value as { type?: unknown }).type
  if (type === 'all' || type === 'recent') {
    return true
  }

  if ((type === 'source' || type === 'folder') && 'value' in value) {
    return typeof (value as { value?: unknown }).value === 'string'
  }

  return false
}

function loadStoredCollection(): CollectionFilter {
  try {
    const value = localStorage.getItem(LIBRARY_COLLECTION_KEY)
    if (!value) {
      return { type: 'all' }
    }
    const parsed: unknown = JSON.parse(value)
    return isCollectionFilter(parsed) ? parsed : { type: 'all' }
  } catch {
    return { type: 'all' }
  }
}

function loadStoredQuery(): string {
  try {
    return localStorage.getItem(LIBRARY_QUERY_KEY) ?? ''
  } catch {
    return ''
  }
}

function loadStoredScrollTop(): number {
  try {
    const value = localStorage.getItem(LIBRARY_SCROLL_TOP_KEY)
    if (!value) {
      return 0
    }
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
  } catch {
    return 0
  }
}

function loadStoredPreviewMode(): LibraryPreviewMode {
  try {
    const value = localStorage.getItem(LIBRARY_PREVIEW_MODE_KEY)
    if (value === 'a4' || value === 'original') {
      return value
    }
    return 'default'
  } catch {
    return 'default'
  }
}

function loadStoredGridSize(): LibraryGridSize {
  try {
    const value = localStorage.getItem(LIBRARY_GRID_SIZE_KEY)
    if (value === 'compact' || value === 'large') {
      return value
    }
    return 'comfortable'
  } catch {
    return 'comfortable'
  }
}

const META_FOLDER_KEYS = new Set([
  'folder',
  'notebook',
  'path',
  'category',
  'collection',
  'group',
  'originkey',
  'originpath',
  'folderkey',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function findFolderValueFromMeta(meta: unknown): string | undefined {
  if (!isRecord(meta)) {
    return undefined
  }

  for (const [key, value] of Object.entries(meta)) {
    if (META_FOLDER_KEYS.has(key.toLowerCase()) && typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }

  for (const value of Object.values(meta)) {
    const nested = findFolderValueFromMeta(value)
    if (nested) {
      return nested
    }
  }

  return undefined
}

function getDocumentFolderValue(document: DocumentRecord): string | undefined {
  const fromPath = (document.folderPath ?? []).join('/').trim()
  if (fromPath.length > 0) {
    return fromPath
  }

  return findFolderValueFromMeta(document.meta)
}

function documentMatchesQuery(document: DocumentRecord, query: string): boolean {
  if (!query.trim()) {
    return true
  }
  const normalized = query.toLowerCase()
  return (
    document.title.toLowerCase().includes(normalized) ||
    document.id.toLowerCase().includes(normalized) ||
    document.sourceFileName.toLowerCase().includes(normalized) ||
    (document.fullText ?? '').toLowerCase().includes(normalized)
  )
}

function documentMatchesCollection(document: DocumentRecord, collection: CollectionFilter): boolean {
  if (collection.type === 'all') {
    return true
  }
  if (collection.type === 'recent') {
    return true
  }
  if (collection.type === 'source') {
    return document.sourceFileName === collection.value
  }
  if (collection.type === 'folder') {
    const folder = getDocumentFolderValue(document)
    return folder === collection.value || folder?.startsWith(`${collection.value}/`) === true
  }
  return true
}

export function LibraryPage() {
  const { documents, loading, importFlxFiles, isImporting, importProgress } = useLibraryContext()

  const importInputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState(() => loadStoredQuery())
  const [collection, setCollection] = useState<CollectionFilter>(() => loadStoredCollection())
  const mainScrollRef = useRef<HTMLElement | null>(null)
  const hasRestoredScrollRef = useRef(false)
  const [dragging, setDragging] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [pendingImportFiles, setPendingImportFiles] = useState<File[] | null>(null)
  const [previewMode, setPreviewMode] = useState<LibraryPreviewMode>(() => loadStoredPreviewMode())
  const [gridSize, setGridSize] = useState<LibraryGridSize>(() => loadStoredGridSize())
  const [isExportingZip, setIsExportingZip] = useState(false)
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null)
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const saved = localStorage.getItem('theme')
    return saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDarkMode)
    localStorage.setItem('theme', isDarkMode ? 'dark' : 'light')
  }, [isDarkMode])

  const folderGroups = useMemo(
    () =>
      Array.from(
        new Set(
          documents
            .map((document) => getDocumentFolderValue(document))
            .filter((folder): folder is string => Boolean(folder)),
        ),
      ).sort((left, right) => left.localeCompare(right, 'de')),
    [documents],
  )

  const recentDocuments = useMemo(
    () =>
      [...documents]
        .sort((left, right) => {
          const leftDate = Number.isFinite(left.createdAt) && left.createdAt > 0 ? left.createdAt : left.addedAt
          const rightDate = Number.isFinite(right.createdAt) && right.createdAt > 0 ? right.createdAt : right.addedAt
          return rightDate - leftDate
        })
        .slice(0, 8),
    [documents],
  )

  const filteredDocuments = useMemo(() => {
    const base = documents
      .filter((document) => documentMatchesCollection(document, collection))
      .filter((document) => documentMatchesQuery(document, query))
      .sort((left, right) => right.addedAt - left.addedAt)

    if (collection.type === 'recent') {
      return base.slice(0, 20)
    }

    return base
  }, [collection, documents, query])

  const totalDocumentsCount = documents.length
  const filteredDocumentsCount = filteredDocuments.length
  const hasActiveFilter = query.trim().length > 0 || collection.type !== 'all'

  useEffect(() => {
    try {
      localStorage.setItem(LIBRARY_COLLECTION_KEY, JSON.stringify(collection))
    } catch {
    }
  }, [collection])

  useEffect(() => {
    try {
      localStorage.setItem(LIBRARY_QUERY_KEY, query)
    } catch {
    }
  }, [query])

  useEffect(() => {
    try {
      localStorage.setItem(LIBRARY_PREVIEW_MODE_KEY, previewMode)
    } catch {
    }
  }, [previewMode])

  useEffect(() => {
    try {
      localStorage.setItem(LIBRARY_GRID_SIZE_KEY, gridSize)
    } catch {
    }
  }, [gridSize])

  useEffect(() => {
    if (loading || hasRestoredScrollRef.current) {
      return
    }

    const targetScrollTop = loadStoredScrollTop()
    hasRestoredScrollRef.current = true
    if (targetScrollTop <= 0) {
      return
    }

    const restoreId = window.requestAnimationFrame(() => {
      if (mainScrollRef.current) {
        mainScrollRef.current.scrollTop = targetScrollTop
      }
    })

    return () => {
      window.cancelAnimationFrame(restoreId)
    }
  }, [loading, filteredDocuments.length])

  const handleMainScroll: UIEventHandler<HTMLElement> = (event) => {
    try {
      localStorage.setItem(LIBRARY_SCROLL_TOP_KEY, String(event.currentTarget.scrollTop))
    } catch {
    }
  }

  const openImportDialog = () => {
    importInputRef.current?.click()
  }

  const resetFilters = () => {
    setCollection({ type: 'all' })
    setQuery('')
  }

  const showSummaryToast = (added: number, updated: number, skipped: number) => {
    setToast(`${added} added, ${updated} updated, ${skipped} skipped`)
    window.setTimeout(() => setToast(null), 3000)
  }

  const handleImportFiles = async (files: FileList | File[], backupKind: BackupImportKind) => {
    try {
      const result = await importFlxFiles(files, backupKind)
      showSummaryToast(result.added, result.updated, result.skipped)
    } catch {
      setToast('Import failed. Please select files again.')
      window.setTimeout(() => setToast(null), 3500)
    }
  }

  const requestBackupTypeSelection = (files: FileList | File[]) => {
    if (isImporting) {
      return
    }

    const list = Array.from(files)
    if (list.length === 0) {
      return
    }

    setPendingImportFiles(list)
  }

  const closeBackupTypeSelection = () => {
    setPendingImportFiles(null)
  }

  const confirmBackupTypeSelection = (backupKind: BackupImportKind) => {
    if (!pendingImportFiles) {
      return
    }

    const files = pendingImportFiles
    setPendingImportFiles(null)
    void handleImportFiles(files, backupKind)
  }

  const handleExportAllAsZip = async () => {
    if (isExportingZip || documents.length === 0) {
      return
    }

    setIsExportingZip(true)
    setExportProgress({ stage: 'Preparing export...', percent: 0 })

    try {
      const fileName = await exportAllDocumentsAsZip(documents, (progress) => {
        setExportProgress(progress)
      })
      setToast(`Export ready: ${fileName}`)
      window.setTimeout(() => setToast(null), 4000)
    } catch {
      setToast('Export failed. Please try again.')
      window.setTimeout(() => setToast(null), 4000)
    } finally {
      setIsExportingZip(false)
      setExportProgress(null)
    }
  }

  return (
    <div
      className="relative flex h-screen flex-col"
      onDragEnter={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragOver={(event) => {
        event.preventDefault()
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDragging(false)
        }
      }}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        requestBackupTypeSelection(event.dataTransfer.files)
      }}
      id="library-root"
    >
      <Topbar
        query={query}
        onQueryChange={setQuery}
        onBackupSelect={openImportDialog}
        onBackupDrop={(files) => {
          requestBackupTypeSelection(files)
        }}
        onToggleTheme={() => setIsDarkMode((previous) => !previous)}
        isDarkMode={isDarkMode}
        isImporting={isImporting}
      />

      <div className="min-h-0 flex-1 md:flex">
        <Sidebar
          selected={collection}
          onSelect={setCollection}
          folderGroups={folderGroups}
          recentDocuments={recentDocuments}
        />

        <main
          ref={mainScrollRef}
          onScroll={handleMainScroll}
          className="relative min-h-0 flex-1 overflow-auto p-4 md:p-6"
        >
          <div className="mb-4 flex items-center justify-between rounded-xl border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <span>
                {hasActiveFilter
                  ? `${filteredDocumentsCount} of ${totalDocumentsCount} documents visible`
                  : `${totalDocumentsCount} documents`}
              </span>
              {hasActiveFilter && (
                <button
                  type="button"
                  onClick={resetFilters}
                  className="rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-foreground transition hover:bg-muted"
                >
                  Reset filters
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  void handleExportAllAsZip()
                }}
                disabled={isExportingZip || loading || documents.length === 0}
                className="rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isExportingZip
                  ? `Exporting... ${Math.round(exportProgress?.percent ?? 0)}%`
                  : 'Download all as ZIP'}
              </button>
              <label htmlFor="library-view-mode" className="text-xs text-muted-foreground">
                View
              </label>
              <select
                id="library-view-mode"
                value={previewMode}
                onChange={(event) => {
                  const value = event.target.value
                  setPreviewMode(value === 'a4' || value === 'original' ? value : 'default')
                }}
                className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none ring-accent/40 transition focus:ring-2"
              >
                <option value="default">Default</option>
                <option value="a4">A4 Preview</option>
                <option value="original">Original</option>
              </select>
              <label htmlFor="library-grid-size" className="text-xs text-muted-foreground">
                Grid
              </label>
              <select
                id="library-grid-size"
                value={gridSize}
                onChange={(event) => {
                  const value = event.target.value
                  setGridSize(value === 'compact' || value === 'large' ? value : 'comfortable')
                }}
                className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none ring-accent/40 transition focus:ring-2"
              >
                <option value="compact">Compact</option>
                <option value="comfortable">Comfortable</option>
                <option value="large">Large</option>
              </select>
            </div>
          </div>

          {loading ? (
            <p className="text-sm text-muted-foreground">Loading library...</p>
          ) : (
            <LibraryGrid documents={filteredDocuments} previewMode={previewMode} gridSize={gridSize} />
          )}

          <DropzoneOverlay active={dragging} />
        </main>
      </div>

      <input
        ref={importInputRef}
        type="file"
        multiple
        accept=".flx,.list,.zip,.flex"
        className="hidden"
        onChange={(event) => {
          if (event.target.files) {
            requestBackupTypeSelection(event.target.files)
            event.target.value = ''
          }
        }}
      />

      {pendingImportFiles && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-2xl">
            <h2 className="text-base font-semibold text-foreground">Choose Backup Type</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Select which Flexcil backup format you want to import.
            </p>
            <div className="mt-4 grid gap-3">
              <button
                type="button"
                onClick={() => confirmBackupTypeSelection('drive')}
                className="rounded-xl border border-border bg-background px-4 py-3 text-left transition hover:bg-muted"
              >
                <div className="text-sm font-medium text-foreground">Google Drive Backup</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Structure with ID-style filenames and documents.list mapping.
                </div>
              </button>
              <button
                type="button"
                onClick={() => confirmBackupTypeSelection('manual')}
                className="rounded-xl border border-border bg-background px-4 py-3 text-left transition hover:bg-muted"
              >
                <div className="text-sm font-medium text-foreground">Manual Backup</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Structure from Documents folders with document names as .flx files.
                </div>
              </button>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={closeBackupTypeSelection}
                className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-muted"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <ImportProgressPopup
        active={importProgress.active}
        stage={importProgress.stage}
        percent={importProgress.percent}
      />

      {isExportingZip && exportProgress && (
        <div className="fixed bottom-6 left-1/2 z-50 w-[min(92vw,420px)] -translate-x-1/2 rounded-2xl border border-border bg-card p-4 shadow-xl">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <span>Export in progress...</span>
          </div>

          <p className="mb-3 text-sm text-muted-foreground">{exportProgress.stage}</p>

          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-accent transition-all duration-300"
              style={{ width: `${Math.max(0, Math.min(100, exportProgress.percent))}%` }}
            />
          </div>

          <p className="mt-2 text-right text-xs text-muted-foreground">{Math.round(exportProgress.percent)}%</p>
        </div>
      )}

      {toast && (
        <div className="pointer-events-none fixed bottom-6 right-6 rounded-xl border border-border bg-card px-4 py-3 text-sm shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}
