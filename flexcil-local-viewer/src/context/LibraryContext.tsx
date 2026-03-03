import { createContext, useContext, useMemo } from 'react'
import { useFlexelImport } from '../hooks/useFlexelImport'
import { useLibraryStore } from '../hooks/useLibraryStore'
import type { DocumentRecord, ImportProgress, ImportSummary } from '../types'

interface LibraryContextValue {
  documents: DocumentRecord[]
  loading: boolean
  reload: () => Promise<void>
  findById: (id: string) => Promise<DocumentRecord | undefined>
  importFlxFiles: (files: FileList | File[]) => Promise<ImportSummary>
  isImporting: boolean
  importProgress: ImportProgress
  lastSummary: ImportSummary | null
}

const LibraryContext = createContext<LibraryContextValue | undefined>(undefined)

export function LibraryProvider({ children }: { children: React.ReactNode }) {
  const { documents, loading, reload, findById } = useLibraryStore()
  const { importFiles, isImporting, summary, progress } = useFlexelImport(reload)

  const value = useMemo<LibraryContextValue>(
    () => ({
      documents,
      loading,
      reload,
      findById,
      importFlxFiles: importFiles,
      isImporting,
      importProgress: progress,
      lastSummary: summary,
    }),
    [documents, findById, importFiles, isImporting, loading, progress, reload, summary],
  )

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>
}

export function useLibraryContext() {
  const context = useContext(LibraryContext)
  if (!context) {
    throw new Error('useLibraryContext must be used inside LibraryProvider')
  }
  return context
}
