import { Link, useParams } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { PdfViewer } from '../components/PdfViewer'
import { useLibraryContext } from '../context/LibraryContext'
import type { DocumentRecord } from '../types'

export function DocumentPage() {
  const { id } = useParams<{ id: string }>()
  const { findById } = useLibraryContext()
  const [document, setDocument] = useState<DocumentRecord | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!id) {
      setLoading(false)
      return
    }

    const run = async () => {
      setLoading(true)
      const found = await findById(id)
      setDocument(found ?? null)
      setLoading(false)
    }

    void run()
  }, [findById, id])

  if (loading) {
    return <p className="p-6 text-sm text-muted-foreground">Loading document...</p>
  }

  if (!document) {
    return (
      <div className="p-6 text-sm">
        <p className="mb-2">Document not found.</p>
        <Link to="/" className="text-accent underline">
          Back to library
        </Link>
      </div>
    )
  }

  return <PdfViewer document={document} />
}
