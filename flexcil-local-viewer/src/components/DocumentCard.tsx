import { useEffect, useState } from 'react'
import { ExternalLink, FileText, PenLine } from 'lucide-react'
import { Link } from 'react-router-dom'
import { formatBytes, formatDate } from '../lib/format'
import type { DocumentRecord } from '../types'

export function DocumentCard({ document }: { document: DocumentRecord }) {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | undefined>()
  const hasDrawings =
    Object.values(document.inkDrawingsByPageKey ?? {}).some((strokes) => strokes.length > 0)

  useEffect(() => {
    if (!document.thumbnailBlob) {
      setThumbnailUrl(undefined)
      return
    }

    const url = URL.createObjectURL(document.thumbnailBlob)
    setThumbnailUrl(url)

    return () => URL.revokeObjectURL(url)
  }, [document.thumbnailBlob])

  return (
    <div className="group relative overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg">
      <Link
        to={`/workspace?doc=${encodeURIComponent(document.id)}`}
        className="block"
      >
        <div className="aspect-[4/3] overflow-hidden bg-muted">
          {thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              alt={document.title}
              className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.02]"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <FileText className="size-10" />
            </div>
          )}
        </div>

        <div className="space-y-1.5 p-4">
          <h3 className="line-clamp-1 text-sm font-semibold text-foreground">{document.title}</h3>
          <p className="text-xs text-muted-foreground">
            {formatDate(document.createdAt || document.addedAt)} • {formatBytes(document.sizeBytes)}
            {typeof document.pageCount === 'number' && document.pageCount > 0
              ? ` • ${document.pageCount} Seiten`
              : ''}
          </p>
        </div>
      </Link>

      <Link
        to={`/workspace?doc=${encodeURIComponent(document.id)}`}
        target="_blank"
        rel="noreferrer"
        className="absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card/90 text-muted-foreground shadow-sm transition hover:bg-muted"
        aria-label="Open in new tab"
        title="Open in new tab"
      >
        <ExternalLink className="size-4" />
      </Link>

      {hasDrawings && (
        <div
          className="absolute left-2 top-2 inline-flex h-8 items-center gap-1 rounded-md border border-border bg-card/90 px-2 text-xs text-muted-foreground shadow-sm"
          title="Has drawings"
          aria-label="Document has drawings"
        >
          <PenLine className="size-3.5" />
        </div>
      )}
    </div>
  )
}
