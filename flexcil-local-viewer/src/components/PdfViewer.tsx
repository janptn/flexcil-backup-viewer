import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Download,
  Minus,
  Plus,
  Search,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  EventBus,
  PDFFindController,
  PDFLinkService,
  PDFViewer as PdfJsViewer,
} from 'pdfjs-dist/legacy/web/pdf_viewer.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import type { DocumentRecord } from '../types'

GlobalWorkerOptions.workerSrc = workerUrl

interface PdfViewerProps {
  document: DocumentRecord
}

const MIN_SCALE = 0.5
const MAX_SCALE = 4
const ZOOM_STEP = 0.2

interface SearchHit {
  id: string
  pageNumber: number
  snippet: string
}

interface TextContentItemLike {
  str?: string
}

export function PdfViewer({ document }: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<HTMLDivElement>(null)
  const viewerInstanceRef = useRef<PdfJsViewer | null>(null)
  const eventBusRef = useRef<EventBus | null>(null)
  const pdfDocumentRef = useRef<Awaited<ReturnType<typeof getDocument>>['promise'] extends Promise<infer T> ? T : never | null>(null)

  const [pagesCount, setPagesCount] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [scalePercent, setScalePercent] = useState(100)
  const [pageInput, setPageInput] = useState('1')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchHits, setSearchHits] = useState<SearchHit[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fileName = useMemo(() => `${document.title || document.id}.pdf`, [document.id, document.title])

  useEffect(() => {
    const container = containerRef.current
    const viewerElement = viewerRef.current

    if (!container || !viewerElement) {
      return
    }

    let isMounted = true
    setLoading(true)
    setError(null)

    let eventBus: EventBus
    let linkService: PDFLinkService
    let pdfViewer: PdfJsViewer
    let findController: PDFFindController

    try {
      eventBus = new EventBus()
      linkService = new PDFLinkService({ eventBus })
      findController = new PDFFindController({ eventBus, linkService })
      pdfViewer = new PdfJsViewer({
        container,
        viewer: viewerElement,
        eventBus,
        linkService,
        findController,
        textLayerMode: 1,
        removePageBorders: false,
      })
    } catch (initError) {
      const message = initError instanceof Error ? initError.message : 'Unknown initialization error'
      setError(`Viewer initialization failed: ${message}`)
      setLoading(false)
      return
    }

    viewerInstanceRef.current = pdfViewer
    eventBusRef.current = eventBus
    linkService.setViewer(pdfViewer)

    const handlePageChanging = (event: { pageNumber: number }) => {
      setCurrentPage(event.pageNumber)
      setPageInput(String(event.pageNumber))
    }

    const handleScaleChanging = (event: { scale: number }) => {
      setScalePercent(Math.round(event.scale * 100))
    }

    eventBus.on('pagechanging', handlePageChanging)
    eventBus.on('scalechanging', handleScaleChanging)

    const run = async () => {
      try {
        const bytes = new Uint8Array(await document.pdfBlob.arrayBuffer())
        const loadingTask = getDocument({ data: bytes })
        const pdfDocument = await loadingTask.promise

        if (!isMounted) {
          await loadingTask.destroy()
          return
        }

        pdfViewer.setDocument(pdfDocument)
        linkService.setDocument(pdfDocument, null)
        findController.setDocument(pdfDocument)
        pdfDocumentRef.current = pdfDocument
        setPagesCount(pdfDocument.numPages)
        setCurrentPage(1)
        setPageInput('1')
        pdfViewer.currentScaleValue = 'page-width'
        setScalePercent(Math.round(pdfViewer.currentScale * 100))
      } catch (loadError) {
        if (isMounted) {
          const message = loadError instanceof Error ? loadError.message : 'Unknown loading error'
          setError(`Could not load PDF: ${message}`)
        }
      } finally {
        if (isMounted) {
          setLoading(false)
        }
      }
    }

    void run()

    return () => {
      isMounted = false
      eventBus.off('pagechanging', handlePageChanging)
      eventBus.off('scalechanging', handleScaleChanging)
      viewerInstanceRef.current = null
      eventBusRef.current = null
      pdfDocumentRef.current = null
    }
  }, [document.pdfBlob])

  useEffect(() => {
    const eventBus = eventBusRef.current
    if (!eventBus) {
      return
    }

    const query = searchQuery.trim()
    eventBus.dispatch('find', {
      source: 'viewer-search',
      type: '',
      query,
      caseSensitive: false,
      entireWord: false,
      phraseSearch: true,
      highlightAll: query.length > 0,
      findPrevious: false,
      matchDiacritics: false,
    })
  }, [searchQuery])

  useEffect(() => {
    const query = searchQuery.trim().toLowerCase()
    const pdfDocument = pdfDocumentRef.current

    if (!query || !pdfDocument) {
      setSearchHits([])
      setIsSearching(false)
      return
    }

    let cancelled = false

    const run = async () => {
      setIsSearching(true)
      const hits: SearchHit[] = []
      const maxHits = 300

      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
        if (cancelled) {
          return
        }

        const page = await pdfDocument.getPage(pageNumber)
        const content = await page.getTextContent()
        const pageText = content.items
          .map((item) => {
            const textItem = item as TextContentItemLike
            return textItem.str ?? ''
          })
          .join(' ')
          .replace(/\s+/g, ' ')

        const lower = pageText.toLowerCase()
        let fromIndex = 0

        while (fromIndex < lower.length) {
          const hitIndex = lower.indexOf(query, fromIndex)
          if (hitIndex < 0) {
            break
          }

          const snippetStart = Math.max(0, hitIndex - 40)
          const snippetEnd = Math.min(pageText.length, hitIndex + query.length + 80)
          const snippet = `${snippetStart > 0 ? '…' : ''}${pageText.slice(snippetStart, snippetEnd).trim()}${snippetEnd < pageText.length ? '…' : ''}`

          hits.push({
            id: `${pageNumber}-${hitIndex}-${hits.length}`,
            pageNumber,
            snippet,
          })

          if (hits.length >= maxHits) {
            break
          }

          fromIndex = hitIndex + query.length
        }

        page.cleanup()
        if (hits.length >= maxHits) {
          break
        }
      }

      if (!cancelled) {
        setSearchHits(hits)
        setIsSearching(false)
      }
    }

    void run().catch(() => {
      if (!cancelled) {
        setSearchHits([])
        setIsSearching(false)
      }
    })

    return () => {
      cancelled = true
    }
  }, [searchQuery])

  const goToPage = useCallback((nextPage: number) => {
    const viewer = viewerInstanceRef.current
    if (!viewer || pagesCount === 0) {
      return
    }

    const safePage = Math.max(1, Math.min(nextPage, pagesCount))
    viewer.currentPageNumber = safePage
    setCurrentPage(safePage)
    setPageInput(String(safePage))
  }, [pagesCount])

  const changeScale = useCallback((nextScale: number) => {
    const viewer = viewerInstanceRef.current
    if (!viewer) {
      return
    }
    const safeScale = Math.max(MIN_SCALE, Math.min(nextScale, MAX_SCALE))
    viewer.currentScale = safeScale
    setScalePercent(Math.round(safeScale * 100))
  }, [])

  const zoomIn = useCallback(
    () => changeScale((viewerInstanceRef.current?.currentScale ?? 1) + ZOOM_STEP),
    [changeScale],
  )
  const zoomOut = useCallback(
    () => changeScale((viewerInstanceRef.current?.currentScale ?? 1) - ZOOM_STEP),
    [changeScale],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === '+') {
        event.preventDefault()
        zoomIn()
      }
      if (event.key === '-') {
        event.preventDefault()
        zoomOut()
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        goToPage(currentPage - 1)
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        goToPage(currentPage + 1)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [currentPage, goToPage, zoomIn, zoomOut])

  const fitWidth = () => {
    const viewer = viewerInstanceRef.current
    if (viewer) {
      viewer.currentScaleValue = 'page-width'
    }
  }

  const fitPage = () => {
    const viewer = viewerInstanceRef.current
    if (viewer) {
      viewer.currentScaleValue = 'page-fit'
    }
  }

  const download = async () => {
    const url = URL.createObjectURL(document.pdfBlob)
    const anchor = window.document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2">
        <Link
          to="/"
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm hover:bg-muted"
        >
          <ArrowLeft className="size-4" />
          Back
        </Link>

        <div className="mx-2 h-5 w-px bg-border" />

        <button
          type="button"
          onClick={() => goToPage(1)}
          className="inline-flex size-9 items-center justify-center rounded-lg border border-border hover:bg-muted"
        >
          <ChevronsLeft className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => goToPage(currentPage - 1)}
          className="inline-flex size-9 items-center justify-center rounded-lg border border-border hover:bg-muted"
        >
          <ChevronLeft className="size-4" />
        </button>

        <div className="flex items-center gap-1 text-sm">
          <input
            value={pageInput}
            onChange={(event) => setPageInput(event.target.value)}
            onBlur={() => goToPage(Number(pageInput))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                goToPage(Number(pageInput))
              }
            }}
            className="h-9 w-14 rounded-lg border border-border bg-background px-2 text-center"
          />
          <span className="text-muted-foreground">/ {pagesCount || '-'}</span>
        </div>

        <button
          type="button"
          onClick={() => goToPage(currentPage + 1)}
          className="inline-flex size-9 items-center justify-center rounded-lg border border-border hover:bg-muted"
        >
          <ChevronRight className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => goToPage(pagesCount)}
          className="inline-flex size-9 items-center justify-center rounded-lg border border-border hover:bg-muted"
        >
          <ChevronsRight className="size-4" />
        </button>

        <div className="mx-2 h-5 w-px bg-border" />

        <button
          type="button"
          onClick={zoomOut}
          className="inline-flex size-9 items-center justify-center rounded-lg border border-border hover:bg-muted"
        >
          <Minus className="size-4" />
        </button>
        <span className="w-16 text-center text-sm text-muted-foreground">{scalePercent}%</span>
        <button
          type="button"
          onClick={zoomIn}
          className="inline-flex size-9 items-center justify-center rounded-lg border border-border hover:bg-muted"
        >
          <Plus className="size-4" />
        </button>

        <button
          type="button"
          onClick={fitWidth}
          className="ml-2 inline-flex h-9 items-center rounded-lg border border-border px-3 text-sm hover:bg-muted"
        >
          Fit Width
        </button>
        <button
          type="button"
          onClick={fitPage}
          className="inline-flex h-9 items-center rounded-lg border border-border px-3 text-sm hover:bg-muted"
        >
          Fit Page
        </button>

        <div className="relative ml-2 w-full min-w-[220px] max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search in document…"
            className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-2 text-sm"
          />
        </div>

        <button
          type="button"
          onClick={download}
          className="ml-auto inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm hover:bg-muted"
        >
          <Download className="size-4" />
          Download
        </button>
      </header>

      <div className="min-h-0 flex flex-1 bg-slate-900/10">
        {searchQuery.trim().length > 0 && (
          <aside className="w-80 border-r border-border bg-card/95 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-semibold">Matches</p>
              <p className="text-xs text-muted-foreground">{searchHits.length}</p>
            </div>

            <div className="max-h-[calc(100vh-170px)] space-y-1 overflow-auto pr-1">
              {isSearching && <p className="text-xs text-muted-foreground">Searching…</p>}
              {!isSearching && searchHits.length === 0 && (
                <p className="text-xs text-muted-foreground">No matches in this document.</p>
              )}
              {searchHits.map((hit) => (
                <button
                  key={hit.id}
                  type="button"
                  onClick={() => goToPage(hit.pageNumber)}
                  className="w-full rounded-lg border border-border px-2 py-2 text-left hover:bg-muted"
                >
                  <p className="mb-1 text-xs font-semibold text-accent">Page {hit.pageNumber}</p>
                  <p className="line-clamp-3 text-xs text-muted-foreground">{hit.snippet}</p>
                </button>
              ))}
            </div>
          </aside>
        )}

        <div className="relative min-w-0 flex-1">
          <div ref={containerRef} className="absolute inset-0 overflow-auto p-3">
            {loading && <p className="p-4 text-sm text-muted-foreground">Loading PDF...</p>}
            {error && <p className="p-4 text-sm text-red-500">{error}</p>}
            <div ref={viewerRef} className="pdfViewer" />
          </div>
        </div>
      </div>
    </div>
  )
}
