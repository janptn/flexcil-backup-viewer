import { DocumentCard } from './DocumentCard'
import type { DocumentRecord } from '../types'

interface LibraryGridProps {
  documents: DocumentRecord[]
  previewMode: 'default' | 'a4' | 'original'
  gridSize: 'compact' | 'comfortable' | 'large'
}

export function LibraryGrid({ documents, previewMode, gridSize }: LibraryGridProps) {
  if (documents.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
        No documents yet. Drop FLEX/ZIP/FLX/LIST files (or folders) in the import area above.
      </div>
    )
  }

  const gridClassName =
    gridSize === 'compact'
      ? 'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5'
      : gridSize === 'large'
        ? 'grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3'
        : 'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'

  return (
    <div className={gridClassName}>
      {documents.map((document) => (
        <DocumentCard key={document.id} document={document} previewMode={previewMode} />
      ))}
    </div>
  )
}
