import { useEffect, useMemo, useRef, useState } from 'react'
import { DropzoneOverlay } from '../components/DropzoneOverlay'
import { ImportProgressPopup } from '../components/ImportProgressPopup'
import { LibraryGrid } from '../components/LibraryGrid'
import { Sidebar } from '../components/Sidebar'
import { Topbar } from '../components/Topbar'
import { useLibraryContext } from '../context/LibraryContext'
import type { CollectionFilter, DocumentRecord } from '../types'

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

  const inputRef = useRef<HTMLInputElement>(null)
  const listInputRef = useRef<HTMLInputElement>(null)
  const backupZipInputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [collection, setCollection] = useState<CollectionFilter>({ type: 'all' })
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

  const openImportDialog = () => {
    inputRef.current?.click()
  }

  const openFolderSyncDialog = () => {
    listInputRef.current?.click()
  }

  const openBackupZipDialog = () => {
    backupZipInputRef.current?.click()
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
        onImport={openImportDialog}
        onRefreshImport={openImportDialog}
        onSyncFolders={openFolderSyncDialog}
        onBackupSelect={openBackupZipDialog}
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

        <main className="relative min-h-0 flex-1 overflow-auto p-4 md:p-6">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading library...</p>
          ) : (
            <LibraryGrid documents={filteredDocuments} />
          )}

          <DropzoneOverlay active={dragging} />
        </main>
      </div>

      <input
        ref={inputRef}
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

      <input
        ref={listInputRef}
        type="file"
        accept=".list"
        className="hidden"
        onChange={(event) => {
          if (event.target.files) {
            void handleImportFiles(event.target.files)
            event.target.value = ''
          }
        }}
      />

      <input
        ref={backupZipInputRef}
        type="file"
        accept=".zip"
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
