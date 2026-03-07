import { type UIEventHandler, useEffect, useMemo, useRef, useState } from 'react'
import { DropzoneOverlay } from '../components/DropzoneOverlay'
import { ImportProgressPopup } from '../components/ImportProgressPopup'
import { LibraryGrid } from '../components/LibraryGrid'
import { Sidebar } from '../components/Sidebar'
import { Topbar } from '../components/Topbar'
import { useLibraryContext } from '../context/LibraryContext'
import type { CollectionFilter, DocumentRecord } from '../types'

const LIBRARY_COLLECTION_KEY = 'flexcil-library-selected-collection-v1'
const LIBRARY_QUERY_KEY = 'flexcil-library-query-v1'
const LIBRARY_SCROLL_TOP_KEY = 'flexcil-library-scroll-top-v1'

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

  const handleImportFiles = async (files: FileList | File[]) => {
    try {
      const result = await importFlxFiles(files)
      showSummaryToast(result.added, result.updated, result.skipped)
    } catch {
      setToast('Import failed. Please select files again.')
      window.setTimeout(() => setToast(null), 3500)
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
        void handleImportFiles(event.dataTransfer.files)
      }}
      id="library-root"
    >
      <Topbar
        query={query}
        onQueryChange={setQuery}
        onBackupSelect={openImportDialog}
        onBackupDrop={(files) => {
          void handleImportFiles(files)
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
        />

        <main
          ref={mainScrollRef}
          onScroll={handleMainScroll}
          className="relative min-h-0 flex-1 overflow-auto p-4 md:p-6"
        >
          <div className="mb-4 flex items-center justify-between rounded-xl border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
            <span>
              {hasActiveFilter
                ? `${filteredDocumentsCount} von ${totalDocumentsCount} Dokumenten sichtbar`
                : `${totalDocumentsCount} Dokumente`}
            </span>
            {hasActiveFilter && (
              <button
                type="button"
                onClick={resetFilters}
                className="rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-foreground transition hover:bg-muted"
              >
                Filter zurücksetzen
              </button>
            )}
          </div>

          {loading ? (
            <p className="text-sm text-muted-foreground">Loading library...</p>
          ) : (
            <LibraryGrid documents={filteredDocuments} />
          )}

          <DropzoneOverlay active={dragging} />
        </main>
      </div>

      <input
        ref={importInputRef}
        type="file"
        multiple
        accept=".flx,.list,.zip"
        className="hidden"
        onChange={(event) => {
          if (event.target.files) {
            void handleImportFiles(event.target.files)
            event.target.value = ''
          }
        }}
      />

      <ImportProgressPopup
        active={importProgress.active}
        stage={importProgress.stage}
        percent={importProgress.percent}
      />

      {toast && (
        <div className="pointer-events-none fixed bottom-6 right-6 rounded-xl border border-border bg-card px-4 py-3 text-sm shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}
