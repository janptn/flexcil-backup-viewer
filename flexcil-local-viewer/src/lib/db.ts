import { openDB } from 'idb'
import type { DBSchema } from 'idb'
import type { DocumentRecord } from '../types'
import type { DocumentsListMapping } from './documentsList'

const DB_NAME = 'flexcil-local-library'
const DB_VERSION = 1
const STORE_DOCUMENTS = 'documents'

interface FlexcilDb extends DBSchema {
  documents: {
    key: string
    value: DocumentRecord
    indexes: {
      'by-addedAt': number
      'by-source': string
      'by-hash': string
    }
  }
}

const dbPromise = openDB<FlexcilDb>(DB_NAME, DB_VERSION, {
  upgrade(db) {
    if (db.objectStoreNames.contains(STORE_DOCUMENTS)) {
      return
    }

    const store = db.createObjectStore(STORE_DOCUMENTS, { keyPath: 'id' })
    store.createIndex('by-addedAt', 'addedAt')
    store.createIndex('by-source', 'sourceFileName')
    store.createIndex('by-hash', 'pdfHash')
  },
})

function hasKeys(value: Record<string, unknown> | undefined): boolean {
  return Boolean(value && Object.keys(value).length > 0)
}

function stableJson(value: unknown): string {
  if (value === undefined) {
    return ''
  }
  return JSON.stringify(value)
}

export async function getAllDocuments(): Promise<DocumentRecord[]> {
  const db = await dbPromise
  const docs = await db.getAll(STORE_DOCUMENTS)
  return docs.sort((left, right) => right.addedAt - left.addedAt)
}

export async function getDocumentById(id: string): Promise<DocumentRecord | undefined> {
  const db = await dbPromise
  return db.get(STORE_DOCUMENTS, id)
}

export async function saveDocumentRecords(
  records: DocumentRecord[],
): Promise<{ added: number; updated: number; skipped: number }> {
  const db = await dbPromise
  const tx = db.transaction(STORE_DOCUMENTS, 'readwrite')
  const store = tx.store
  const hashIndex = store.index('by-hash')

  let added = 0
  let updated = 0
  let skipped = 0

  const mergeRecord = (existing: DocumentRecord, incoming: DocumentRecord): DocumentRecord => {
    const existingHasFolder = (existing.folderPath?.length ?? 0) > 0
    const incomingHasFolder = (incoming.folderPath?.length ?? 0) > 0

    const nextFolder = existingHasFolder ? existing.folderPath : incomingHasFolder ? incoming.folderPath : undefined
    const nextMeta = existing.meta ?? incoming.meta
    const nextThumbnail = existing.thumbnailBlob ?? incoming.thumbnailBlob
    const nextFullText =
      typeof existing.fullText === 'string' && existing.fullText.trim().length > 0
        ? existing.fullText
        : incoming.fullText
    const nextTitle =
      existing.title === existing.id && incoming.title !== incoming.id ? incoming.title : existing.title
    const nextInkPageKeys = hasKeys(incoming.inkPageKeys)
      ? incoming.inkPageKeys
      : existing.inkPageKeys
    const nextInkDrawings = hasKeys(incoming.inkDrawingsByPageKey)
      ? incoming.inkDrawingsByPageKey
      : existing.inkDrawingsByPageKey
    const nextPageCount =
      typeof existing.pageCount === 'number' && existing.pageCount > 0
        ? existing.pageCount
        : incoming.pageCount

    return {
      ...existing,
      title: nextTitle,
      createdAt: Math.min(existing.createdAt, incoming.createdAt),
      sourceFileName: existing.sourceFileName || incoming.sourceFileName,
      thumbnailBlob: nextThumbnail,
      meta: nextMeta,
      folderPath: nextFolder,
      fullText: nextFullText,
      pageCount: nextPageCount,
      inkPageKeys: nextInkPageKeys,
      inkDrawingsByPageKey: nextInkDrawings,
    }
  }

  const recordsEqual = (left: DocumentRecord, right: DocumentRecord): boolean => {
    return JSON.stringify({
      title: left.title,
      createdAt: left.createdAt,
      sourceFileName: left.sourceFileName,
      folderPath: left.folderPath,
      hasMeta: Boolean(left.meta),
      hasThumbnail: Boolean(left.thumbnailBlob),
      hasFullText: Boolean(left.fullText && left.fullText.trim().length > 0),
      pageCount: left.pageCount ?? 0,
      inkPageKeys: stableJson(left.inkPageKeys),
      inkDrawingsByPageKey: stableJson(left.inkDrawingsByPageKey),
    }) ===
      JSON.stringify({
        title: right.title,
        createdAt: right.createdAt,
        sourceFileName: right.sourceFileName,
        folderPath: right.folderPath,
        hasMeta: Boolean(right.meta),
        hasThumbnail: Boolean(right.thumbnailBlob),
        hasFullText: Boolean(right.fullText && right.fullText.trim().length > 0),
        pageCount: right.pageCount ?? 0,
        inkPageKeys: stableJson(right.inkPageKeys),
        inkDrawingsByPageKey: stableJson(right.inkDrawingsByPageKey),
      })
  }

  for (const record of records) {
    const duplicateById = await store.get(record.id)
    if (duplicateById) {
      const merged = mergeRecord(duplicateById, record)
      if (!recordsEqual(duplicateById, merged)) {
        await store.put(merged)
        updated += 1
      } else {
        skipped += 1
      }
      continue
    }

    const duplicateByHash = await hashIndex.get(record.pdfHash)
    if (duplicateByHash) {
      const merged = mergeRecord(duplicateByHash, record)
      if (!recordsEqual(duplicateByHash, merged)) {
        await store.put(merged)
        updated += 1
      } else {
        skipped += 1
      }
      continue
    }

    await store.put(record)
    added += 1
  }

  await tx.done
  return { added, updated, skipped }
}

export async function applyDocumentsListMappings(
  mappings: Map<string, DocumentsListMapping>,
): Promise<number> {
  if (mappings.size === 0) {
    return 0
  }

  const db = await dbPromise
  const tx = db.transaction(STORE_DOCUMENTS, 'readwrite')
  const store = tx.store
  const allDocuments = await store.getAll()
  let updated = 0

  for (const existing of allDocuments) {
    const mapping = mappings.get(existing.id.toUpperCase())
    if (!mapping) {
      continue
    }

    const hasFolder = (existing.folderPath?.length ?? 0) > 0
    const normalizedTitle = existing.title.trim().toUpperCase()
    const isFallbackTitle = normalizedTitle === existing.id.trim().toUpperCase()

    const nextFolder = hasFolder ? existing.folderPath : mapping.folderPath
    const nextTitle = isFallbackTitle && mapping.title ? mapping.title : existing.title

    const changedFolder = JSON.stringify(existing.folderPath ?? []) !== JSON.stringify(nextFolder ?? [])
    const changedTitle = nextTitle !== existing.title

    if (!changedFolder && !changedTitle) {
      continue
    }

    await store.put({
      ...existing,
      folderPath: nextFolder,
      title: nextTitle,
    })
    updated += 1
  }

  await tx.done
  return updated
}
