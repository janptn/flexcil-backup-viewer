import { useEffect, useState } from 'react'
import { ExternalLink, FileText } from 'lucide-react'
import { Link } from 'react-router-dom'
import { formatBytes, formatDate } from '../lib/format'
import type { DocumentRecord } from '../types'

export function DocumentCard({ document }: { document: DocumentRecord }) {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | undefined>()

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
        to={`/doc/${document.id}`}
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
            {formatDate(document.addedAt)} • {formatBytes(document.sizeBytes)}
          </p>
        </div>
      </Link>

      <Link
        to={`/doc/${document.id}`}
        target="_blank"
        rel="noreferrer"
        className="absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card/90 text-muted-foreground shadow-sm transition hover:bg-muted"
        aria-label="Open in new tab"
        title="Open in new tab"
      >
        <ExternalLink className="size-4" />
      </Link>
    </div>
  )
}
