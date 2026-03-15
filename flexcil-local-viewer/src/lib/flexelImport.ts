import JSZip from 'jszip'
import { sha256 } from './hash'
import { argbToRgbaCss, parseFlexcilDrawings } from './flexcilInk'
import { normalizeDocumentId } from './documentsList'
import type {
  BackupImportKind,
  DocumentRecord,
  FlexcilImageAnnotation,
  ImportInputFile,
  FlexcilShapeAnnotation,
  FlexcilShapePoint,
  UnknownMeta,
} from '../types'
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
const PARSER_VERSION = '2026-03-15-hover-filter-v2'

interface PageIndexEntry {
  attachmentPage?: {
    index?: number
  }
  key?: string
}

interface RawImageFrame {
  x?: number
  y?: number
  width?: number
  height?: number
}

interface RawImageObject {
  key?: string
  frame?: RawImageFrame
  cropBox?: RawImageFrame
  rotate?: number
}

interface RawShapeObject {
  key?: string
  shapeType?: number
  points?: string
  rotate?: number
  start?: {
    x?: number
    y?: number
  }
  controlPoints?: Array<{
    x?: number
    y?: number
  }>
  dashtype?: number
  fillColor?: number
  strokeColor?: number
  scale?: {
    x?: number
    y?: number
  }
}

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

function inferManualFolderPathFromArchivePath(archivePath?: string): string[] | undefined {
  if (!archivePath || archivePath.trim().length === 0) {
    return undefined
  }

  const segments = archivePath
    .split(/[\\/]+/g)
    .map((segment) => segment.trim())
    .filter(Boolean)

  if (segments.length <= 1) {
    return undefined
  }

  const fileNameIndex = segments.length - 1
  const documentsIndex = segments.findIndex((segment) => segment.toLowerCase() === 'documents')
  const folderSegments =
    documentsIndex >= 0
      ? segments.slice(documentsIndex + 1, fileNameIndex)
      : segments.slice(0, fileNameIndex)

  return folderSegments.length > 0 ? folderSegments : undefined
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

function extractPageKeyMappings(pagesIndexRaw: unknown): Record<string, string> {
  if (!Array.isArray(pagesIndexRaw)) {
    return {}
  }

  const mappings: Record<string, string> = {}

  for (const item of pagesIndexRaw) {
    if (!item || typeof item !== 'object') {
      continue
    }

    const entry = item as PageIndexEntry
    const pageIndex = entry.attachmentPage?.index
    const pageKey = typeof entry.key === 'string' ? entry.key.trim() : ''

    if (!Number.isFinite(pageIndex) || pageKey.length === 0) {
      continue
    }

    const oneBasedPageNumber = (pageIndex as number) + 1
    mappings[String(oneBasedPageNumber)] = pageKey
  }

  return mappings
}

function findDrawingsEntry(zip: JSZip, pageKey: string): JSZip.JSZipObject | undefined {
  const suffix = `objects/${pageKey}.drawings`.toLowerCase()
  return Object.values(zip.files).find((entry) => !entry.dir && entry.name.toLowerCase().endsWith(suffix))
}

function findImagesEntry(zip: JSZip, pageKey: string): JSZip.JSZipObject | undefined {
  const suffix = `objects/${pageKey}.images`.toLowerCase()
  return Object.values(zip.files).find((entry) => !entry.dir && entry.name.toLowerCase().endsWith(suffix))
}

function findShapesEntry(zip: JSZip, pageKey: string): JSZip.JSZipObject | undefined {
  const suffix = `objects/${pageKey}.shapes`.toLowerCase()
  return Object.values(zip.files).find((entry) => !entry.dir && entry.name.toLowerCase().endsWith(suffix))
}

function findImageAttachmentEntry(zip: JSZip, imageKey: string): JSZip.JSZipObject | undefined {
  const suffix = `attachment/image/${imageKey}`.toLowerCase()
  return Object.values(zip.files).find((entry) => !entry.dir && entry.name.toLowerCase().endsWith(suffix))
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, Math.min(1, value))
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function computeShapeLineWidth(scale: RawShapeObject['scale']): number {
  const xScale = typeof scale?.x === 'number' ? scale.x : 1
  const yScale = typeof scale?.y === 'number' ? scale.y : xScale
  const average = (xScale + yScale) / 2
  if (!Number.isFinite(average)) {
    return 2
  }
  return Math.max(0.8, Math.min(12, 2 * average))
}

function decodeShapePoints(
  base64: string,
  start: { x: number; y: number },
): { points: FlexcilShapePoint[]; widthNorm?: number } {
  if (!base64 || base64.trim().length === 0) {
    return { points: [{ xNorm: start.x, yNorm: start.y }] }
  }

  const bytes = base64ToBytes(base64)
  if (bytes.byteLength < 16) {
    return { points: [{ xNorm: start.x, yNorm: start.y }] }
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const expectedCount = view.getUint32(0, true)

  // Observed format in Flexcil .shapes:
  //   uint32 count, followed by count entries of float32(dx), float32(dy), float32(extra)
  // The third float is metadata and not geometry.
  const tripletPayloadBytes = bytes.byteLength - 4
  if (tripletPayloadBytes >= 12 && tripletPayloadBytes % 12 === 0) {
    const tripletCount = tripletPayloadBytes / 12
    if (expectedCount === 0 || expectedCount === tripletCount) {
      const points: FlexcilShapePoint[] = []
      const widths: number[] = []
      for (let offset = 4; offset + 12 <= bytes.byteLength; offset += 12) {
        const dx = view.getFloat32(offset, true)
        const dy = view.getFloat32(offset + 4, true)
        const extra = view.getFloat32(offset + 8, true)
        points.push({ xNorm: start.x + dx, yNorm: start.y + dy })
        if (Number.isFinite(extra) && extra > 0) {
          widths.push(extra)
        }
      }
      if (points.length > 0) {
        const widthNorm = widths.length > 0 ? widths.reduce((sum, value) => sum + value, 0) / widths.length : undefined
        return { points, widthNorm }
      }
    }
  }

  // Fallback for unknown/legacy shape encodings.
  if ((bytes.byteLength - 4) % 8 === 0) {
    const points: FlexcilShapePoint[] = []
    for (let offset = 4; offset + 8 <= bytes.byteLength; offset += 8) {
      const dx = view.getFloat32(offset, true)
      const dy = view.getFloat32(offset + 4, true)
      points.push({ xNorm: start.x + dx, yNorm: start.y + dy })
    }
    if (points.length > 0) {
      return { points }
    }
  }

  return { points: [{ xNorm: start.x, yNorm: start.y }] }
}

function isShapeClosed(shapeType: number): boolean {
  // In observed archives, type 9 encodes triangular arrow heads.
  // Other types are often open polylines and should not be force-closed.
  return shapeType === 9
}

async function extractInkDrawingsByPageKey(
  zip: JSZip,
  pageKeyMappings: Record<string, string>,
): Promise<Record<string, ReturnType<typeof parseFlexcilDrawings>>> {
  const uniquePageKeys = Array.from(new Set(Object.values(pageKeyMappings)))
  const drawingsByPageKey: Record<string, ReturnType<typeof parseFlexcilDrawings>> = {}

  for (const pageKey of uniquePageKeys) {
    const drawingsEntry = findDrawingsEntry(zip, pageKey)
    if (!drawingsEntry) {
      continue
    }

    try {
      const raw = await drawingsEntry.async('string')
      const parsed = safeJsonParse(raw)
      const strokes = parseFlexcilDrawings(parsed)
      if (strokes.length > 0) {
        drawingsByPageKey[pageKey] = strokes
      }
    } catch {
      continue
    }
  }

  return drawingsByPageKey
}

async function extractImageAnnotationsByPageKey(
  zip: JSZip,
  pageKeyMappings: Record<string, string>,
): Promise<Record<string, FlexcilImageAnnotation[]>> {
  const uniquePageKeys = Array.from(new Set(Object.values(pageKeyMappings)))
  const imageAnnotationsByPageKey: Record<string, FlexcilImageAnnotation[]> = {}

  for (const pageKey of uniquePageKeys) {
    const imagesEntry = findImagesEntry(zip, pageKey)
    if (!imagesEntry) {
      continue
    }

    try {
      const raw = await imagesEntry.async('string')
      const parsed = safeJsonParse(raw)
      if (!Array.isArray(parsed)) {
        continue
      }

      const annotations: FlexcilImageAnnotation[] = []
      for (const item of parsed) {
        if (!item || typeof item !== 'object') {
          continue
        }

        const imageObject = item as RawImageObject
        const imageKey = typeof imageObject.key === 'string' ? imageObject.key.trim() : ''
        const frame = imageObject.frame
        if (!imageKey || !frame) {
          continue
        }

        const attachmentEntry = findImageAttachmentEntry(zip, imageKey)
        if (!attachmentEntry) {
          continue
        }

        const bytes = await attachmentEntry.async('uint8array')
        const normalizedBytes = new Uint8Array(bytes.byteLength)
        normalizedBytes.set(bytes)
        const frameX = Number(frame.x)
        const frameY = Number(frame.y)
        const frameW = Number(frame.width)
        const frameH = Number(frame.height)
        if (!Number.isFinite(frameW) || !Number.isFinite(frameH) || frameW <= 0 || frameH <= 0) {
          continue
        }

        const crop = imageObject.cropBox
        const cropX = Number(crop?.x)
        const cropY = Number(crop?.y)
        const cropW = Number(crop?.width)
        const cropH = Number(crop?.height)

        annotations.push({
          key: imageKey,
          xNorm: frameX,
          yNorm: frameY,
          widthNorm: frameW,
          heightNorm: frameH,
          rotate: typeof imageObject.rotate === 'number' ? imageObject.rotate : undefined,
          cropBox:
            Number.isFinite(cropX) && Number.isFinite(cropY) && Number.isFinite(cropW) && Number.isFinite(cropH)
              ? {
                  xNorm: clamp01(cropX),
                  yNorm: clamp01(cropY),
                  widthNorm: clamp01(cropW),
                  heightNorm: clamp01(cropH),
                }
              : undefined,
          imageBlob: new Blob([normalizedBytes], { type: 'image/jpeg' }),
        })
      }

      if (annotations.length > 0) {
        imageAnnotationsByPageKey[pageKey] = annotations
      }
    } catch {
      continue
    }
  }

  return imageAnnotationsByPageKey
}

async function extractShapeAnnotationsByPageKey(
  zip: JSZip,
  pageKeyMappings: Record<string, string>,
): Promise<Record<string, FlexcilShapeAnnotation[]>> {
  const uniquePageKeys = Array.from(new Set(Object.values(pageKeyMappings)))
  const shapeAnnotationsByPageKey: Record<string, FlexcilShapeAnnotation[]> = {}

  for (const pageKey of uniquePageKeys) {
    const shapesEntry = findShapesEntry(zip, pageKey)
    if (!shapesEntry) {
      continue
    }

    try {
      const raw = await shapesEntry.async('string')
      const parsed = safeJsonParse(raw)
      if (!Array.isArray(parsed)) {
        continue
      }

      const annotations: FlexcilShapeAnnotation[] = []
      for (const item of parsed) {
        if (!item || typeof item !== 'object') {
          continue
        }

        const shapeObject = item as RawShapeObject
        const key = typeof shapeObject.key === 'string' ? shapeObject.key.trim() : ''
        const shapeType = Number(shapeObject.shapeType)
        const startX = Number(shapeObject.start?.x)
        const startY = Number(shapeObject.start?.y)
        const encodedPoints = typeof shapeObject.points === 'string' ? shapeObject.points : ''

        if (!key || !Number.isFinite(shapeType) || !Number.isFinite(startX) || !Number.isFinite(startY)) {
          continue
        }

        const geometry = decodeShapePoints(encodedPoints, { x: startX, y: startY })
        const points = geometry.points
        if (points.length < 2) {
          continue
        }

        const controlPoints = Array.isArray(shapeObject.controlPoints)
          ? shapeObject.controlPoints
              .map((point) => ({ xNorm: Number(point.x), yNorm: Number(point.y) }))
              .filter((point) => Number.isFinite(point.xNorm) && Number.isFinite(point.yNorm))
          : []

        const strokeColor = typeof shapeObject.strokeColor === 'number' ? shapeObject.strokeColor : 0xff000000
        const fillColor = typeof shapeObject.fillColor === 'number' ? shapeObject.fillColor : 0
        const fillAlpha = ((fillColor >>> 24) & 0xff) / 255

        annotations.push({
          key,
          shapeType,
          points,
          controlPoints: controlPoints.length > 0 ? controlPoints : undefined,
          widthNorm: geometry.widthNorm,
          strokeStyle: argbToRgbaCss(strokeColor),
          fillStyle: fillAlpha > 0 ? argbToRgbaCss(fillColor) : undefined,
          dashType: Number.isFinite(shapeObject.dashtype) ? Number(shapeObject.dashtype) : 0,
          lineWidth: computeShapeLineWidth(shapeObject.scale),
          rotate: typeof shapeObject.rotate === 'number' ? shapeObject.rotate : undefined,
          isClosed: isShapeClosed(shapeType),
        })
      }

      if (annotations.length > 0) {
        shapeAnnotationsByPageKey[pageKey] = annotations
      }
    } catch {
      continue
    }
  }

  return shapeAnnotationsByPageKey
}

export async function parseFlexelFiles(
  files: ImportInputFile[],
  backupKind: BackupImportKind,
  documentsListMappings?: Map<string, DocumentsListMapping>,
): Promise<DocumentRecord[]> {
  const parsedRecords: DocumentRecord[] = []

  for (const entry of files) {
    const file = entry.file
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
    const pagesIndexRaw = metaItems.find(([name]) => name.toLowerCase().endsWith('pages.index'))?.[1]
    const inkPageKeys = extractPageKeyMappings(pagesIndexRaw)
    const inkDrawingsByPageKey = await extractInkDrawingsByPageKey(zip, inkPageKeys)
    const imageAnnotationsByPageKey = await extractImageAnnotationsByPageKey(zip, inkPageKeys)
    const shapeAnnotationsByPageKey = await extractShapeAnnotationsByPageKey(zip, inkPageKeys)
    const thumbnailEntry = pickThumbnailEntry(zip)
    const thumbnailBytes = thumbnailEntry ? await thumbnailEntry.async('uint8array') : undefined
    const titleFromMeta = searchFirstString(meta, TITLE_KEYS)
    const createdAt = searchFirstDate(meta)
    const folderPath = inferFolderPath(meta)
    const folderPathFromArchive =
      backupKind === 'manual' ? inferManualFolderPathFromArchivePath(entry.archivePath) : undefined
    const manualTitle = file.name.replace(/\.flx$/i, '').trim()

    for (const pdfEntry of pdfEntries) {
      const pdfBytes = await pdfEntry.async('uint8array')
      const normalizedPdfBytes = new Uint8Array(pdfBytes.byteLength)
      normalizedPdfBytes.set(pdfBytes)
      const sourceId = pdfEntry.name.split('/').pop() ?? crypto.randomUUID()
      const sourceIdUpper = sourceId.trim().toUpperCase()
      const sourceIdNormalized = normalizeDocumentId(sourceId)
      const mapping = documentsListMappings?.get(sourceIdUpper) ?? documentsListMappings?.get(sourceIdNormalized)
      const pdfHash = await sha256(pdfBytes)
      const id = sourceId.trim().length > 0 ? sourceId : pdfHash
      const title =
        mapping?.title ??
        (backupKind === 'manual' && manualTitle.length > 0
          ? manualTitle
          : titleFromMeta && pdfEntries.length === 1
            ? titleFromMeta
            : id)

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
        folderPath: mapping?.folderPath?.length
          ? mapping.folderPath
          : folderPathFromArchive?.length
            ? folderPathFromArchive
            : folderPath,
        inkPageKeys: Object.keys(inkPageKeys).length > 0 ? inkPageKeys : undefined,
        inkDrawingsByPageKey:
          Object.keys(inkDrawingsByPageKey).length > 0 ? inkDrawingsByPageKey : undefined,
        imageAnnotationsByPageKey:
          Object.keys(imageAnnotationsByPageKey).length > 0 ? imageAnnotationsByPageKey : undefined,
        shapeAnnotationsByPageKey:
          Object.keys(shapeAnnotationsByPageKey).length > 0 ? shapeAnnotationsByPageKey : undefined,
        parserVersion: PARSER_VERSION,
      })
    }
  }

  return parsedRecords
}
