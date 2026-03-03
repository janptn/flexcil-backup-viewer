import JSZip from 'jszip'
import { sha256 } from './hash'
import type { DocumentRecord, UnknownMeta } from '../types'
import type { DocumentsListMapping } from './documentsList'

const PDF_ENTRY_PATTERN = /^attachment\/PDF\/[^/]+$/i
const META_ENTRY_PATTERN = /(^|\/)(info|pages\.index|template\.info|\.iteminfo)$/i
const FOLDER_KEYS = new Set([
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
const TITLE_KEYS = ['title', 'name', 'documentTitle']
const DATE_KEYS = ['createdAt', 'updatedAt', 'date', 'modifiedAt', 'created', 'timestamp']

function safeJsonParse(content: string): unknown {
  try {
    return JSON.parse(content)
  } catch {
    return content
  }
}

async function decodeItemInfo(bytes: Uint8Array): Promise<unknown> {
  const asText = new TextDecoder().decode(bytes)
  const direct = safeJsonParse(asText)
  if (isRecord(direct)) {
    return direct
  }

  const startOffset = 8
  if (bytes.byteLength <= startOffset) {
    return asText
  }

  try {
    const compressed = bytes.slice(startOffset)
    const stream = new DecompressionStream('deflate')
    const writer = stream.writable.getWriter()
    await writer.write(compressed)
    await writer.close()

    const text = await new Response(stream.readable).text()
    return safeJsonParse(text)
  } catch {
    return asText
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function searchFirstString(obj: unknown, candidates: string[]): string | undefined {
  if (!isRecord(obj)) {
    return undefined
  }

  for (const candidate of candidates) {
    const value = obj[candidate]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }

  for (const value of Object.values(obj)) {
    const next = searchFirstString(value, candidates)
    if (next) {
      return next
    }
  }

  return undefined
}

function searchFirstDate(obj: unknown): number | undefined {
  const dateValue = searchFirstString(obj, DATE_KEYS)
  if (!dateValue) {
    return undefined
  }

  const parsed = Date.parse(dateValue)
  if (!Number.isNaN(parsed)) {
    return parsed
  }

  const asNumber = Number(dateValue)
  return Number.isFinite(asNumber) ? asNumber : undefined
}

function inferFolderPath(obj: unknown): string[] | undefined {
  if (!isRecord(obj)) {
    return undefined
  }

  for (const [key, value] of Object.entries(obj)) {
    if (FOLDER_KEYS.has(key.toLowerCase()) && typeof value === 'string' && value.trim().length > 0) {
      return value
        .split(/[\\/]/g)
        .map((segment) => segment.trim())
        .filter(Boolean)
    }

    const nested = inferFolderPath(value)
    if (nested && nested.length > 0) {
      return nested
    }
  }

  return undefined
}

function createMetaObject(metaItems: Array<[string, unknown]>): UnknownMeta | undefined {
  if (metaItems.length === 0) {
    return undefined
  }

  return Object.fromEntries(metaItems)
}

function pickThumbnailEntry(zip: JSZip): JSZip.JSZipObject | undefined {
  const allEntries = Object.values(zip.files).filter((entry) => !entry.dir)

  const scored = allEntries
    .map((entry) => {
      const lower = entry.name.toLowerCase()
      if (lower.endsWith('thumbnail@2x')) {
        return { entry, score: 3 }
      }
      if (lower.endsWith('thumbnail@3x')) {
        return { entry, score: 2 }
      }
      if (lower.endsWith('thumbnail')) {
        return { entry, score: 1 }
      }
      return { entry, score: 0 }
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)

  return scored[0]?.entry
}

export async function parseFlexelFiles(
  files: File[],
  documentsListMappings?: Map<string, DocumentsListMapping>,
): Promise<DocumentRecord[]> {
  const parsedRecords: DocumentRecord[] = []

  for (const file of files) {
    if (!file.name.toLowerCase().endsWith('.flx')) {
      continue
    }

    const zipBytes = await file.arrayBuffer()
    const zip = await JSZip.loadAsync(zipBytes)
    const allEntries = Object.values(zip.files).filter((entry) => !entry.dir)
    const pdfEntries = allEntries.filter((entry) => PDF_ENTRY_PATTERN.test(entry.name))

    if (pdfEntries.length === 0) {
      continue
    }

    const metaCandidates = allEntries.filter((entry) => META_ENTRY_PATTERN.test(entry.name))
    const metaItems: Array<[string, unknown]> = []

    for (const metaEntry of metaCandidates) {
      const lowerName = metaEntry.name.toLowerCase()
      if (lowerName.endsWith('/.iteminfo') || lowerName === '/.iteminfo') {
        const bytes = await metaEntry.async('uint8array')
        const decoded = await decodeItemInfo(bytes)
        metaItems.push([metaEntry.name, decoded])
      } else {
        const raw = await metaEntry.async('string')
        metaItems.push([metaEntry.name, safeJsonParse(raw)])
      }
    }

    const meta = createMetaObject(metaItems)
    const thumbnailEntry = pickThumbnailEntry(zip)
    const thumbnailBytes = thumbnailEntry ? await thumbnailEntry.async('uint8array') : undefined
    const titleFromMeta = searchFirstString(meta, TITLE_KEYS)
    const createdAt = searchFirstDate(meta)
    const folderPath = inferFolderPath(meta)

    for (const pdfEntry of pdfEntries) {
      const pdfBytes = await pdfEntry.async('uint8array')
      const normalizedPdfBytes = new Uint8Array(pdfBytes.byteLength)
      normalizedPdfBytes.set(pdfBytes)
      const sourceId = pdfEntry.name.split('/').pop() ?? crypto.randomUUID()
      const mapping = documentsListMappings?.get(sourceId.toUpperCase())
      const pdfHash = await sha256(pdfBytes)
      const id = sourceId.trim().length > 0 ? sourceId : pdfHash
      const title =
        mapping?.title ?? (titleFromMeta && pdfEntries.length === 1 ? titleFromMeta : id)

      const normalizedThumbnailBytes = thumbnailBytes
        ? (() => {
            const copy = new Uint8Array(thumbnailBytes.byteLength)
            copy.set(thumbnailBytes)
            return copy
          })()
        : undefined

      parsedRecords.push({
        id,
        title,
        createdAt: createdAt ?? Date.now(),
        addedAt: Date.now(),
        sourceFileName: file.name,
        pdfBlob: new Blob([normalizedPdfBytes], { type: 'application/pdf' }),
        pdfHash,
        sizeBytes: pdfBytes.byteLength,
        thumbnailBlob: normalizedThumbnailBytes
          ? new Blob([normalizedThumbnailBytes], { type: 'image/jpeg' })
          : undefined,
        meta,
        folderPath: mapping?.folderPath?.length ? mapping.folderPath : folderPath,
      })
    }
  }

  return parsedRecords
}
