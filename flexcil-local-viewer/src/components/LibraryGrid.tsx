import { DocumentCard } from './DocumentCard'
import type { DocumentRecord } from '../types'

interface LibraryGridProps {
  documents: DocumentRecord[]
}

export function LibraryGrid({ documents }: LibraryGridProps) {
  if (documents.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
        No documents yet. Drop ZIP/FLX/LIST files (or folders) in the import area above.
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {documents.map((document) => (
        <DocumentCard key={document.id} document={document} />
      ))}
    </div>
  )
}
