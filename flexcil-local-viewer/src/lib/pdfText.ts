import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

interface PdfTextItem {
  str?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export interface PdfTextInfo {
  fullText: string
  pageCount: number
  createdAt?: number
}

function parsePdfDateString(rawValue: string): number | undefined {
  const normalized = rawValue.trim()
  if (normalized.length === 0) {
    return undefined
  }

  const direct = Date.parse(normalized)
  if (!Number.isNaN(direct)) {
    return direct
  }

  const match = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz]|[+\-]\d{2}'?\d{2}'?)?$/.exec(
    normalized,
  )
  if (!match) {
    return undefined
  }

  const year = Number(match[1])
  const month = Number(match[2] ?? '01')
  const day = Number(match[3] ?? '01')
  const hour = Number(match[4] ?? '00')
  const minute = Number(match[5] ?? '00')
  const second = Number(match[6] ?? '00')
  const timezone = match[7] ?? 'Z'

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second)
  ) {
    return undefined
  }

  let utcMillis = Date.UTC(year, month - 1, day, hour, minute, second)

  if (timezone !== 'Z' && timezone !== 'z') {
    const tzMatch = /^([+\-])(\d{2})'?(\d{2})'?$/.exec(timezone)
    if (tzMatch) {
      const sign = tzMatch[1] === '+' ? 1 : -1
      const offsetHours = Number(tzMatch[2])
      const offsetMinutes = Number(tzMatch[3])
      const offsetMillis = (offsetHours * 60 + offsetMinutes) * 60 * 1000
      utcMillis -= sign * offsetMillis
    }
  }

  return Number.isFinite(utcMillis) ? utcMillis : undefined
}

function parsePdfDateValue(value: unknown): number | undefined {
  if (value instanceof Date) {
    const timestamp = value.getTime()
    return Number.isFinite(timestamp) ? timestamp : undefined
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 0 && value < 10_000_000_000) {
      return Math.trunc(value * 1000)
    }
    return Math.trunc(value)
  }

  if (typeof value === 'string') {
    return parsePdfDateString(value)
  }

  return undefined
}

async function extractPdfCreatedAt(pdfDocument: {
  getMetadata: () => Promise<{ info?: unknown }>
}): Promise<number | undefined> {
  try {
    const metadata = await pdfDocument.getMetadata()
    const info = isRecord(metadata.info) ? metadata.info : {}

    const candidates = [
      info.CreationDate,
      info.ModDate,
      info.creationDate,
      info.modDate,
      info.CreatedAt,
      info.ModifiedAt,
    ]

    for (const candidate of candidates) {
      const parsed = parsePdfDateValue(candidate)
      if (parsed && Number.isFinite(parsed) && parsed > 0) {
        return parsed
      }
    }
  } catch {
  }

  return undefined
}

export async function extractPdfTextInfo(pdfBlob: Blob): Promise<PdfTextInfo> {
  const bytes = new Uint8Array(await pdfBlob.arrayBuffer())
  const loadingTask = getDocument({ data: bytes })

  try {
    const pdfDocument = await loadingTask.promise
    const createdAt = await extractPdfCreatedAt(pdfDocument)
    const pages: string[] = []

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber)
      const content = await page.getTextContent()

      const pageText = content.items
        .map((item) => {
          const textItem = item as PdfTextItem
          return textItem.str ?? ''
        })
        .join(' ')
        .trim()

      if (pageText.length > 0) {
        pages.push(pageText)
      }

      page.cleanup()
    }

    const raw = pages.join('\n')
    return {
      fullText: raw.replace(/\s+/g, ' ').trim(),
      pageCount: pdfDocument.numPages,
      createdAt,
    }
  } finally {
    await loadingTask.destroy()
  }
}

export async function extractPdfFullText(pdfBlob: Blob): Promise<string> {
  const info = await extractPdfTextInfo(pdfBlob)
  return info.fullText
}
