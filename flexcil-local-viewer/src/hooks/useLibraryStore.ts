import { useCallback, useEffect, useState } from 'react'
import { getAllDocuments, getDocumentById } from '../lib/db'
import type { DocumentRecord } from '../types'

export function useLibraryStore() {
  const [documents, setDocuments] = useState<DocumentRecord[]>([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    setLoading(true)
    const next = await getAllDocuments()
    setDocuments(next)
    setLoading(false)
  }, [])

  const findById = useCallback(async (id: string) => {
    const local = documents.find((document) => document.id === id)
    if (local) {
      return local
    }

    return getDocumentById(id)
  }, [documents])

  useEffect(() => {
    void reload()
  }, [reload])

  return {
    documents,
    loading,
    reload,
    findById,
  }
}
