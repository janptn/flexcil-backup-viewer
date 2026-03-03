import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

interface PdfTextItem {
  str?: string
}

export async function extractPdfFullText(pdfBlob: Blob): Promise<string> {
  const bytes = new Uint8Array(await pdfBlob.arrayBuffer())
  const loadingTask = getDocument({ data: bytes })

  try {
    const pdfDocument = await loadingTask.promise
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
    return raw.replace(/\s+/g, ' ').trim()
  } finally {
    await loadingTask.destroy()
  }
}
