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
  SlidersHorizontal,
} from 'lucide-react'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  EventBus,
  PDFFindController,
  PDFLinkService,
  PDFViewer as PdfJsViewer,
} from 'pdfjs-dist/legacy/web/pdf_viewer.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import type { DocumentRecord, FlexcilInkStroke, PdfSearchHit, TabViewState } from '../types'

GlobalWorkerOptions.workerSrc = workerUrl

interface PdfViewerProps {
  document: DocumentRecord
  showToolbar?: boolean
  showBackButton?: boolean
  showSearchInput?: boolean
  showSearchSidebar?: boolean
  viewportMode?: 'screen' | 'fill'
  externalSearchQuery?: string
  onExternalSearchQueryChange?: (query: string) => void
  externalSelectedMatchIndex?: number
  onExternalSelectedMatchIndexChange?: (index: number) => void
  onSearchHitsChange?: (hits: PdfSearchHit[]) => void
  initialViewState?: Partial<TabViewState>
  onViewStateChange?: (state: TabViewState) => void
}

const MIN_SCALE = 0.5
const MAX_SCALE = 4
const ZOOM_STEP = 0.2

type SearchHit = PdfSearchHit

interface TextContentItemLike {
  str?: string
}

type InkDecodeMode = 'auto' | 'absolute' | 'cumulative'

interface InkInspectorStats {
  strokeCount: number
  pointCount: number
  avgStepNorm: number
  maxJumpNorm: number
  jumpSplitCount: number
  outOfBoundsRatio: number
}

interface CanvasPoint {
  x: number
  y: number
  pressure?: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function perpendicularDistance(point: CanvasPoint, start: CanvasPoint, end: CanvasPoint): number {
  const dx = end.x - start.x
  const dy = end.y - start.y

  if (dx === 0 && dy === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y)
  }

  const numerator = Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x)
  const denominator = Math.hypot(dx, dy)
  return numerator / denominator
}

function simplifyRdp(points: CanvasPoint[], epsilon: number): CanvasPoint[] {
  if (points.length < 3 || epsilon <= 0) {
    return points
  }

  const first = points[0]
  const last = points[points.length - 1]
  let maxDistance = 0
  let splitIndex = -1

  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = perpendicularDistance(points[index], first, last)
    if (distance > maxDistance) {
      maxDistance = distance
      splitIndex = index
    }
  }

  if (maxDistance <= epsilon || splitIndex <= 0) {
    return [first, last]
  }

  const left = simplifyRdp(points.slice(0, splitIndex + 1), epsilon)
  const right = simplifyRdp(points.slice(splitIndex), epsilon)
  return [...left.slice(0, -1), ...right]
}

function applyChaikin(points: CanvasPoint[], iterations: number): CanvasPoint[] {
  if (iterations <= 0 || points.length < 3) {
    return points
  }

  let result = points
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    if (result.length < 3) {
      break
    }

    const next: CanvasPoint[] = [result[0]]
    for (let index = 0; index < result.length - 1; index += 1) {
      const current = result[index]
      const following = result[index + 1]
      next.push({
        x: 0.75 * current.x + 0.25 * following.x,
        y: 0.75 * current.y + 0.25 * following.y,
        pressure:
          typeof current.pressure === 'number' && typeof following.pressure === 'number'
            ? 0.75 * current.pressure + 0.25 * following.pressure
            : current.pressure ?? following.pressure,
      })
      next.push({
        x: 0.25 * current.x + 0.75 * following.x,
        y: 0.25 * current.y + 0.75 * following.y,
        pressure:
          typeof current.pressure === 'number' && typeof following.pressure === 'number'
            ? 0.25 * current.pressure + 0.75 * following.pressure
            : current.pressure ?? following.pressure,
      })
    }
    next.push(result[result.length - 1])
    result = next
  }

  return result
}

function computeAlpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff)
  return 1 / (1 + tau / dt)
}

function applyOneEuroFilter(points: CanvasPoint[], minCutoff: number, beta: number): CanvasPoint[] {
  if (points.length < 3) {
    return points
  }

  const dt = 1 / 60
  const dCutoff = 1

  const output: CanvasPoint[] = [points[0]]
  let prev = { ...points[0] }
  let prevDx = 0
  let prevDy = 0

  for (let index = 1; index < points.length; index += 1) {
    const current = points[index]
    const dx = (current.x - prev.x) / dt
    const dy = (current.y - prev.y) / dt

    const alphaD = computeAlpha(dCutoff, dt)
    prevDx = alphaD * dx + (1 - alphaD) * prevDx
    prevDy = alphaD * dy + (1 - alphaD) * prevDy

    const cutoffX = minCutoff + beta * Math.abs(prevDx)
    const cutoffY = minCutoff + beta * Math.abs(prevDy)
    const alphaX = computeAlpha(Math.max(0.01, cutoffX), dt)
    const alphaY = computeAlpha(Math.max(0.01, cutoffY), dt)

    const filtered: CanvasPoint = {
      x: alphaX * current.x + (1 - alphaX) * prev.x,
      y: alphaY * current.y + (1 - alphaY) * prev.y,
      pressure: current.pressure,
    }

    output.push(filtered)
    prev = filtered
  }

  return output
}

function applySpeedAdaptiveSmoothing(points: CanvasPoint[], sensitivity: number): CanvasPoint[] {
  if (points.length < 3 || sensitivity <= 0) {
    return points
  }

  const result: CanvasPoint[] = [points[0]]
  let previous = points[0]

  for (let index = 1; index < points.length; index += 1) {
    const current = points[index]
    const speed = Math.hypot(current.x - previous.x, current.y - previous.y)
    const smoothing = clamp((sensitivity / 100) * (1 / (1 + speed / 6)), 0, 0.9)

    const smoothed: CanvasPoint = {
      x: current.x * (1 - smoothing) + previous.x * smoothing,
      y: current.y * (1 - smoothing) + previous.y * smoothing,
      pressure: current.pressure,
    }

    result.push(smoothed)
    previous = smoothed
  }

  return result
}

function strokeWidthFromPressure(
  baseWidth: number,
  pressure: number | undefined,
  gamma: number,
): number {
  const p = clamp(pressure ?? 0.5, 0, 1)
  const curved = p ** Math.max(0.1, gamma)
  const minW = baseWidth * 0.55
  const maxW = baseWidth * 1.35
  return minW + curved * (maxW - minW)
}

export function PdfViewer({
  document,
  showToolbar = true,
  showBackButton = true,
  showSearchInput = true,
  showSearchSidebar = true,
  viewportMode = 'screen',
  externalSearchQuery,
  onExternalSearchQueryChange,
  externalSelectedMatchIndex,
  onExternalSelectedMatchIndexChange,
  onSearchHitsChange,
  initialViewState,
  onViewStateChange,
}: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<HTMLDivElement>(null)
  const viewerInstanceRef = useRef<PdfJsViewer | null>(null)
  const eventBusRef = useRef<EventBus | null>(null)
  const pdfDocumentRef = useRef<Awaited<ReturnType<typeof getDocument>>['promise'] extends Promise<infer T> ? T : never | null>(null)

  const [pagesCount, setPagesCount] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [scalePercent, setScalePercent] = useState(100)
  const [pageInput, setPageInput] = useState('1')
  const [internalSearchQuery, setInternalSearchQuery] = useState('')
  const [searchHits, setSearchHits] = useState<SearchHit[]>([])
  const [internalSelectedMatchIndex, setInternalSelectedMatchIndex] = useState(0)
  const [isSearching, setIsSearching] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAnnotations, setShowAnnotations] = useState(true)
  const [inkDecodeMode, setInkDecodeMode] = useState<InkDecodeMode>('absolute')
  const [flipInkY, setFlipInkY] = useState(false)
  const [splitByPressure, setSplitByPressure] = useState(false)
  const [inkOffsetXPercent, setInkOffsetXPercent] = useState(0)
  const [inkOffsetYPercent, setInkOffsetYPercent] = useState(-1)
  const [inkScaleXPercent, setInkScaleXPercent] = useState(100)
  const [inkScaleYPercent, setInkScaleYPercent] = useState(71.5)
  const [showInkDebugPanel, setShowInkDebugPanel] = useState(false)
  const [enableInkSmoothing, setEnableInkSmoothing] = useState(true)
  const [inkSmoothingPercent, setInkSmoothingPercent] = useState(50)
  const [inkStrokeWidthPercent, setInkStrokeWidthPercent] = useState(100)
  const [inkOpacityPercent, setInkOpacityPercent] = useState(100)
  const [simplifyEpsilonPx, setSimplifyEpsilonPx] = useState(0)
  const [chaikinIterations, setChaikinIterations] = useState(0)
  const [useSpline, setUseSpline] = useState(true)
  const [curveTensionPercent, setCurveTensionPercent] = useState(50)
  const [enableOneEuroFilter, setEnableOneEuroFilter] = useState(false)
  const [oneEuroMinCutoff, setOneEuroMinCutoff] = useState(1)
  const [oneEuroBeta, setOneEuroBeta] = useState(0.4)
  const [pressureGamma, setPressureGamma] = useState(1.6)
  const [speedSensitivity, setSpeedSensitivity] = useState(20)
  const [lockStrokeWidthOnZoom, setLockStrokeWidthOnZoom] = useState(true)

  const searchQuery = externalSearchQuery ?? internalSearchQuery
  const selectedMatchIndex = externalSelectedMatchIndex ?? internalSelectedMatchIndex

  const setSearchQuery = useCallback(
    (value: string) => {
      if (externalSearchQuery === undefined) {
        setInternalSearchQuery(value)
      }
      onExternalSearchQueryChange?.(value)
    },
    [externalSearchQuery, onExternalSearchQueryChange],
  )

  const setSelectedMatchIndex = useCallback(
    (value: number) => {
      if (externalSelectedMatchIndex === undefined) {
        setInternalSelectedMatchIndex(value)
      }
      onExternalSelectedMatchIndexChange?.(value)
    },
    [externalSelectedMatchIndex, onExternalSelectedMatchIndexChange],
  )

  const fileName = useMemo(() => `${document.title || document.id}.pdf`, [document.id, document.title])

  useEffect(() => {
    if (externalSearchQuery === undefined) {
      setInternalSearchQuery('')
    }
    if (externalSelectedMatchIndex === undefined) {
      setInternalSelectedMatchIndex(0)
    }
  }, [document.id, externalSearchQuery, externalSelectedMatchIndex])

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

        const initialPage = initialViewState?.currentPage
        const initialZoomPercent = initialViewState?.zoomPercent
        const initialScrollPosition = initialViewState?.scrollPosition

        const applyInitialView = () => {
          try {
            if (Number.isFinite(initialZoomPercent) && initialZoomPercent) {
              const nextScale = Math.max(MIN_SCALE, Math.min(initialZoomPercent / 100, MAX_SCALE))
              pdfViewer.currentScale = nextScale
              setScalePercent(Math.round(nextScale * 100))
            } else {
              pdfViewer.currentScaleValue = 'page-width'
              setScalePercent(Math.round(pdfViewer.currentScale * 100))
            }

            const desiredPage =
              Number.isFinite(initialPage) && initialPage
                ? Math.max(1, Math.min(initialPage, pdfDocument.numPages))
                : 1
            pdfViewer.currentPageNumber = desiredPage
            setCurrentPage(desiredPage)
            setPageInput(String(desiredPage))

            window.requestAnimationFrame(() => {
              if (!containerRef.current) {
                return
              }
              const nextScroll =
                Number.isFinite(initialScrollPosition) && initialScrollPosition
                  ? Math.max(0, initialScrollPosition)
                  : 0
              containerRef.current.scrollTop = nextScroll
            })
          } catch {
            pdfViewer.currentScaleValue = 'page-width'
            setScalePercent(Math.round(pdfViewer.currentScale * 100))
            setCurrentPage(1)
            setPageInput('1')
          }
        }

        window.requestAnimationFrame(applyInitialView)
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
  }, [document.id, document.pdfBlob])

  useEffect(() => {
    const eventBus = eventBusRef.current
    if (!eventBus || loading || pagesCount <= 0) {
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
  }, [loading, pagesCount, searchQuery])

  const resolvePageKey = useCallback(
    (pageNumber: number): string | undefined => {
      const pageKeys = document.inkPageKeys
      if (!pageKeys) {
        return undefined
      }

      return pageKeys[String(pageNumber)]
    },
    [document.inkPageKeys],
  )

  const getStrokePoints = useCallback(
    (stroke: FlexcilInkStroke) => {
      if (inkDecodeMode === 'absolute') {
        return stroke.pointsAbsolute ?? stroke.points
      }
      if (inkDecodeMode === 'cumulative') {
        return stroke.pointsCumulative ?? stroke.points
      }
      return stroke.points
    },
    [inkDecodeMode],
  )

  const inspectorPageKey = useMemo(() => resolvePageKey(currentPage), [currentPage, resolvePageKey])

  const inspectorStrokes = useMemo(
    () => (inspectorPageKey ? document.inkDrawingsByPageKey?.[inspectorPageKey] ?? [] : []),
    [document.inkDrawingsByPageKey, inspectorPageKey],
  )

  const inspectorStats = useMemo<InkInspectorStats>(() => {
    if (inspectorStrokes.length === 0) {
      return {
        strokeCount: 0,
        pointCount: 0,
        avgStepNorm: 0,
        maxJumpNorm: 0,
        jumpSplitCount: 0,
        outOfBoundsRatio: 0,
      }
    }

    let pointCount = 0
    let stepCount = 0
    let totalStepNorm = 0
    let maxJumpNorm = 0
    let jumpSplitCount = 0
    let outOfBounds = 0

    for (const stroke of inspectorStrokes) {
      const points = getStrokePoints(stroke)
      if (!points || points.length === 0) {
        continue
      }

      pointCount += points.length

      for (const point of points) {
        if (point.xNorm < 0 || point.xNorm > 1 || point.yNorm < 0 || point.yNorm > 1) {
          outOfBounds += 1
        }
      }

      for (let index = 1; index < points.length; index += 1) {
        const prev = points[index - 1]
        const curr = points[index]
        const jumpNorm = Math.hypot(curr.xNorm - prev.xNorm, curr.yNorm - prev.yNorm)

        totalStepNorm += jumpNorm
        stepCount += 1
        if (jumpNorm > maxJumpNorm) {
          maxJumpNorm = jumpNorm
        }
        if (jumpNorm > 0.04) {
          jumpSplitCount += 1
        }
      }
    }

    return {
      strokeCount: inspectorStrokes.length,
      pointCount,
      avgStepNorm: stepCount > 0 ? totalStepNorm / stepCount : 0,
      maxJumpNorm,
      jumpSplitCount,
      outOfBoundsRatio: pointCount > 0 ? outOfBounds / pointCount : 0,
    }
  }, [getStrokePoints, inspectorStrokes])

  const drawStrokesOnCanvas = useCallback((canvas: HTMLCanvasElement, strokes: FlexcilInkStroke[]) => {
    const offsetXNorm = inkOffsetXPercent / 100
    const offsetYNorm = inkOffsetYPercent / 100
    const scaleX = inkScaleXPercent / 100
    const scaleY = inkScaleYPercent / 100
    const widthMultiplier = Math.max(0.3, inkStrokeWidthPercent / 100)
    const opacity = Math.max(0, Math.min(1, inkOpacityPercent / 100))
    const smoothingFactor = Math.max(0, Math.min(1, inkSmoothingPercent / 100))
    const toCanvasX = (xNorm: number) => (xNorm * scaleX + offsetXNorm) * canvas.width
    const toCanvasY = (yNorm: number) => {
      const shifted = yNorm * scaleY + offsetYNorm
      return (flipInkY ? 1 - shifted : shifted) * canvas.height
    }
    const canvasScaleX = canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : 1
    const canvasScaleY = canvas.clientHeight > 0 ? canvas.height / canvas.clientHeight : 1
    const canvasPixelScale = (canvasScaleX + canvasScaleY) / 2
    const zoomScale = Math.max(0.1, scalePercent / 100)

    const context = canvas.getContext('2d')
    if (!context) {
      return
    }

    context.clearRect(0, 0, canvas.width, canvas.height)
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.miterLimit = 2

    const drawSegment = (segment: CanvasPoint[], baseStrokeWidth: number) => {
      if (segment.length < 2) {
        return
      }

      const prepared = (() => {
        let points = segment

        if (enableOneEuroFilter) {
          points = applyOneEuroFilter(points, oneEuroMinCutoff, oneEuroBeta)
        }

        points = applySpeedAdaptiveSmoothing(points, speedSensitivity)

        if (simplifyEpsilonPx > 0) {
          points = simplifyRdp(points, simplifyEpsilonPx)
        }

        if (chaikinIterations > 0) {
          points = applyChaikin(points, chaikinIterations)
        }

        return points
      })()

      if (prepared.length < 2) {
        return
      }

      if (useSpline && prepared.length > 2) {
        context.beginPath()
        context.moveTo(prepared[0].x, prepared[0].y)
        const tension = clamp(curveTensionPercent / 100, 0, 1)

        for (let index = 0; index < prepared.length - 1; index += 1) {
          const p0 = prepared[Math.max(0, index - 1)]
          const p1 = prepared[index]
          const p2 = prepared[index + 1]
          const p3 = prepared[Math.min(prepared.length - 1, index + 2)]

          const cp1x = p1.x + ((p2.x - p0.x) / 6) * tension
          const cp1y = p1.y + ((p2.y - p0.y) / 6) * tension
          const cp2x = p2.x - ((p3.x - p1.x) / 6) * tension
          const cp2y = p2.y - ((p3.y - p1.y) / 6) * tension
          context.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y)
        }

        const pressureValues = prepared
          .map((point) => point.pressure)
          .filter((value): value is number => typeof value === 'number')
        const avgPressure =
          pressureValues.length > 0
            ? pressureValues.reduce((sum, value) => sum + value, 0) / pressureValues.length
            : undefined
        const widthCss = strokeWidthFromPressure(baseStrokeWidth, avgPressure, pressureGamma)
        const widthDevicePx = widthCss * canvasPixelScale
        context.lineWidth = lockStrokeWidthOnZoom ? widthDevicePx * zoomScale : widthDevicePx
        context.stroke()
        return
      }

      for (let index = 1; index < prepared.length; index += 1) {
        const prev = prepared[index - 1]
        const curr = prepared[index]
        context.beginPath()
        context.moveTo(prev.x, prev.y)
        context.lineTo(curr.x, curr.y)
        const widthCss = strokeWidthFromPressure(baseStrokeWidth, curr.pressure, pressureGamma)
        const widthDevicePx = widthCss * canvasPixelScale
        context.lineWidth = lockStrokeWidthOnZoom ? widthDevicePx * zoomScale : widthDevicePx
        context.stroke()
      }
    }

    for (const stroke of strokes) {
      const strokePoints = getStrokePoints(stroke)

      if (!strokePoints || strokePoints.length < 2) {
        continue
      }

      context.strokeStyle = stroke.strokeStyle
      const baseStrokeWidth = (Number.isFinite(stroke.lineWidth) ? stroke.lineWidth : 2) * widthMultiplier
      context.globalAlpha = opacity

      const first = strokePoints[0]
      let previousX = toCanvasX(first.xNorm)
      let previousY = toCanvasY(first.yNorm)
      let previousPressure = first.pressure
      const jumpThresholdPx = Math.max(24, canvas.width * 0.04)
      const segments: CanvasPoint[][] = [[{ x: previousX, y: previousY, pressure: first.pressure }]]

      for (let index = 1; index < strokePoints.length; index += 1) {
        const point = strokePoints[index]
        const x = toCanvasX(point.xNorm)
        const y = toCanvasY(point.yNorm)
        const jump = Math.hypot(x - previousX, y - previousY)
        const isPenLift =
          splitByPressure &&
          typeof point.pressure === 'number' &&
          point.pressure <= 0 &&
          (previousPressure ?? 1) > 0

        if (jump > jumpThresholdPx || isPenLift) {
          segments.push([{ x, y, pressure: point.pressure }])
        } else {
          const currentSegment = segments[segments.length - 1]
          currentSegment.push({ x, y, pressure: point.pressure })
        }

        previousX = x
        previousY = y
        previousPressure = point.pressure
      }

      if (enableInkSmoothing && smoothingFactor > 0) {
        for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
          segments[segmentIndex] = applyChaikin(segments[segmentIndex], Math.round(smoothingFactor * 2))
        }
      }

      for (const segment of segments) {
        drawSegment(segment, baseStrokeWidth)
      }
      context.globalAlpha = 1
    }
  }, [
    chaikinIterations,
    curveTensionPercent,
    enableOneEuroFilter,
    enableInkSmoothing,
    flipInkY,
    getStrokePoints,
    inkOffsetXPercent,
    inkOpacityPercent,
    inkSmoothingPercent,
    inkOffsetYPercent,
    inkScaleXPercent,
    inkScaleYPercent,
    inkStrokeWidthPercent,
    oneEuroBeta,
    oneEuroMinCutoff,
    pressureGamma,
    simplifyEpsilonPx,
    speedSensitivity,
    scalePercent,
    splitByPressure,
    useSpline,
    lockStrokeWidthOnZoom,
  ])

  const renderInkOverlays = useCallback(() => {
    const viewerElement = viewerRef.current
    if (!viewerElement) {
      return
    }

    const pageElements = Array.from(viewerElement.querySelectorAll<HTMLElement>('.page'))

    for (const pageElement of pageElements) {
      const existing = pageElement.querySelector<HTMLCanvasElement>('.flexcil-ink-overlay')
      if (existing) {
        existing.remove()
      }

      if (!showAnnotations) {
        continue
      }

      const pageNumberRaw = pageElement.getAttribute('data-page-number')
      const pageNumber = Number(pageNumberRaw)
      if (!Number.isFinite(pageNumber)) {
        continue
      }

      const pageKey = resolvePageKey(pageNumber)
      if (!pageKey) {
        continue
      }

      const strokes = document.inkDrawingsByPageKey?.[pageKey]
      if (!strokes || strokes.length === 0) {
        continue
      }

      const pdfCanvas = pageElement.querySelector<HTMLCanvasElement>('canvas')
      if (!pdfCanvas || pdfCanvas.width <= 0 || pdfCanvas.height <= 0) {
        continue
      }

      const canvasHost = pdfCanvas.parentElement as HTMLElement | null
      if (!canvasHost) {
        continue
      }

      if (!canvasHost.style.position) {
        canvasHost.style.position = 'relative'
      }

      const overlay = window.document.createElement('canvas')
      overlay.className = 'flexcil-ink-overlay'
      overlay.width = pdfCanvas.width
      overlay.height = pdfCanvas.height
      overlay.style.position = 'absolute'
      overlay.style.left = '0'
      overlay.style.top = '0'
      overlay.style.width = '100%'
      overlay.style.height = '100%'
      overlay.style.pointerEvents = 'none'

      drawStrokesOnCanvas(overlay, strokes)
      canvasHost.appendChild(overlay)
    }
  }, [document.inkDrawingsByPageKey, drawStrokesOnCanvas, resolvePageKey, showAnnotations])

  useEffect(() => {
    const eventBus = eventBusRef.current
    if (!eventBus) {
      return
    }

    const rerender = () => {
      window.requestAnimationFrame(() => {
        renderInkOverlays()
      })
    }

    eventBus.on('pagesloaded', rerender)
    eventBus.on('pagerendered', rerender)
    eventBus.on('scalechanging', rerender)
    rerender()

    return () => {
      eventBus.off('pagesloaded', rerender)
      eventBus.off('pagerendered', rerender)
      eventBus.off('scalechanging', rerender)
    }
  }, [renderInkOverlays])

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

  useEffect(() => {
    onSearchHitsChange?.(searchHits)
  }, [onSearchHitsChange, searchHits])

  useEffect(() => {
    const query = searchQuery.trim()
    if (!query || searchHits.length === 0) {
      return
    }

    const safeIndex = Math.max(0, Math.min(selectedMatchIndex, searchHits.length - 1))
    if (safeIndex !== selectedMatchIndex) {
      setSelectedMatchIndex(safeIndex)
      return
    }

    const hit = searchHits[safeIndex]
    if (!hit) {
      return
    }

    const viewer = viewerInstanceRef.current
    if (viewer) {
      viewer.currentPageNumber = hit.pageNumber
    }
  }, [searchHits, searchQuery, selectedMatchIndex, setSelectedMatchIndex])

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

  const emitViewState = useCallback(() => {
    if (!onViewStateChange) {
      return
    }

    onViewStateChange({
      currentPage,
      zoomPercent: scalePercent,
      scrollPosition: containerRef.current?.scrollTop ?? 0,
    })
  }, [currentPage, onViewStateChange, scalePercent])

  useEffect(() => {
    emitViewState()
  }, [emitViewState])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !onViewStateChange) {
      return
    }

    const onScroll = () => {
      emitViewState()
    }

    container.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', onScroll)
    }
  }, [emitViewState, onViewStateChange])

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
    if (!showBackButton) {
      return
    }

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
  }, [currentPage, goToPage, showBackButton, zoomIn, zoomOut])

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

  const rootHeightClass = viewportMode === 'fill' ? 'h-full' : 'h-screen'

  return (
    <div className={`flex min-h-0 ${rootHeightClass} flex-col bg-background`}>
      {showToolbar && <header className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2">
        {showBackButton && (
          <>
            <button
              type="button"
              onClick={() => {
                window.location.assign('/')
              }}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm hover:bg-muted"
            >
              <ArrowLeft className="size-4" />
              Library
            </button>
            <div className="mx-2 h-5 w-px bg-border" />
          </>
        )}

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

        {showSearchInput && (
          <div className="relative ml-2 w-full min-w-[220px] max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search in document…"
              className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-2 text-sm"
            />
          </div>
        )}

        <button
          type="button"
          onClick={download}
          className="ml-auto inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm hover:bg-muted"
        >
          <Download className="size-4" />
          Download
        </button>

        <label className="ml-2 inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm hover:bg-muted">
          <input
            type="checkbox"
            checked={showAnnotations}
            onChange={(event) => setShowAnnotations(event.target.checked)}
            className="size-4"
          />
          Show annotations (beta)
        </label>

        <button
          type="button"
          onClick={() => setShowInkDebugPanel((previous) => !previous)}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm hover:bg-muted"
        >
          <SlidersHorizontal className="size-4" />
          Ink Debug
        </button>
      </header>}

      <div className="min-h-0 flex flex-1 bg-slate-900/10">
        {showSearchSidebar && searchQuery.trim().length > 0 && (
          <aside className="w-80 border-r border-border bg-card/95 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-semibold">Matches</p>
              <p className="text-xs text-muted-foreground">{searchHits.length}</p>
            </div>

            <div className="max-h-full space-y-1 overflow-auto pr-1">
              {isSearching && <p className="text-xs text-muted-foreground">Searching…</p>}
              {!isSearching && searchHits.length === 0 && (
                <p className="text-xs text-muted-foreground">No matches in this document.</p>
              )}
              {searchHits.map((hit, index) => (
                <button
                  key={hit.id}
                  type="button"
                  onClick={() => {
                    setSelectedMatchIndex(index)
                    goToPage(hit.pageNumber)
                  }}
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
          {showInkDebugPanel && (
            <div className="absolute right-4 top-4 z-20 w-80 rounded-lg border border-border bg-card/95 p-3 text-xs shadow-md backdrop-blur-sm">
              <p className="mb-3 text-sm font-semibold">Ink Debug</p>

              <div className="mb-3 grid grid-cols-2 gap-2">
                <label className="col-span-2 flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Decode</span>
                  <select
                    value={inkDecodeMode}
                    onChange={(event) => setInkDecodeMode(event.target.value as InkDecodeMode)}
                    className="h-7 rounded-md border border-border bg-background px-2 text-xs"
                  >
                    <option value="auto">Auto</option>
                    <option value="absolute">Absolute</option>
                    <option value="cumulative">Cumulative</option>
                  </select>
                </label>

                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={flipInkY}
                    onChange={(event) => setFlipInkY(event.target.checked)}
                    className="size-4"
                  />
                  Y-Flip
                </label>

                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={splitByPressure}
                    onChange={(event) => setSplitByPressure(event.target.checked)}
                    className="size-4"
                  />
                  Split by pressure
                </label>
              </div>

              <div className="mb-3 space-y-2">
                <label className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Offset X</span>
                  <input
                    type="range"
                    min={-20}
                    max={20}
                    step={0.1}
                    value={inkOffsetXPercent}
                    onChange={(event) => setInkOffsetXPercent(Number(event.target.value))}
                    className="w-36"
                  />
                  <span className="w-12 text-right text-muted-foreground">{inkOffsetXPercent.toFixed(1)}%</span>
                </label>

                <label className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Offset Y</span>
                  <input
                    type="range"
                    min={-20}
                    max={20}
                    step={0.1}
                    value={inkOffsetYPercent}
                    onChange={(event) => setInkOffsetYPercent(Number(event.target.value))}
                    className="w-36"
                  />
                  <span className="w-12 text-right text-muted-foreground">{inkOffsetYPercent.toFixed(1)}%</span>
                </label>

                <label className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Scale X</span>
                  <input
                    type="range"
                    min={50}
                    max={150}
                    step={0.5}
                    value={inkScaleXPercent}
                    onChange={(event) => setInkScaleXPercent(Number(event.target.value))}
                    className="w-36"
                  />
                  <span className="w-12 text-right text-muted-foreground">{inkScaleXPercent.toFixed(1)}%</span>
                </label>

                <label className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Scale Y</span>
                  <input
                    type="range"
                    min={50}
                    max={150}
                    step={0.5}
                    value={inkScaleYPercent}
                    onChange={(event) => setInkScaleYPercent(Number(event.target.value))}
                    className="w-36"
                  />
                  <span className="w-12 text-right text-muted-foreground">{inkScaleYPercent.toFixed(1)}%</span>
                </label>
              </div>

              <div className="mb-3 space-y-2">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={enableInkSmoothing}
                    onChange={(event) => setEnableInkSmoothing(event.target.checked)}
                    className="size-4"
                  />
                  Smoothing
                </label>

                <label className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Simplify (RDP px)</span>
                  <input
                    type="range"
                    min={0}
                    max={3}
                    step={0.1}
                    value={simplifyEpsilonPx}
                    onChange={(event) => setSimplifyEpsilonPx(Number(event.target.value))}
                    className="w-36"
                  />
                  <span className="w-12 text-right text-muted-foreground">{simplifyEpsilonPx.toFixed(1)}</span>
                </label>

                <label className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Chaikin iter</span>
                  <input
                    type="range"
                    min={0}
                    max={3}
                    step={1}
                    value={chaikinIterations}
                    onChange={(event) => setChaikinIterations(Number(event.target.value))}
                    className="w-36"
                  />
                  <span className="w-12 text-right text-muted-foreground">{chaikinIterations}</span>
                </label>

                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={enableOneEuroFilter}
                    onChange={(event) => setEnableOneEuroFilter(event.target.checked)}
                    className="size-4"
                  />
                  One Euro filter
                </label>

                <label className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Stabilization</span>
                  <input
                    type="range"
                    min={0.5}
                    max={3}
                    step={0.1}
                    value={oneEuroMinCutoff}
                    onChange={(event) => setOneEuroMinCutoff(Number(event.target.value))}
                    className="w-36"
                    disabled={!enableOneEuroFilter}
                  />
                  <span className="w-12 text-right text-muted-foreground">{oneEuroMinCutoff.toFixed(1)}</span>
                </label>

                <label className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Responsiveness</span>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.1}
                    value={oneEuroBeta}
                    onChange={(event) => setOneEuroBeta(Number(event.target.value))}
                    className="w-36"
                    disabled={!enableOneEuroFilter}
                  />
                  <span className="w-12 text-right text-muted-foreground">{oneEuroBeta.toFixed(1)}</span>
                </label>

                <label className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Smoothness</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={inkSmoothingPercent}
                    onChange={(event) => setInkSmoothingPercent(Number(event.target.value))}
                    className="w-36"
                    disabled={!enableInkSmoothing}
                  />
                  <span className="w-12 text-right text-muted-foreground">{inkSmoothingPercent}%</span>
                </label>

                <label className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Speed sensitivity</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={speedSensitivity}
                    onChange={(event) => setSpeedSensitivity(Number(event.target.value))}
                    className="w-36"
                  />
                  <span className="w-12 text-right text-muted-foreground">{speedSensitivity}</span>
                </label>

                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={useSpline}
                    onChange={(event) => setUseSpline(event.target.checked)}
                    className="size-4"
                  />
                  Use spline
                </label>

                <label className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Curve tension</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={curveTensionPercent}
                    onChange={(event) => setCurveTensionPercent(Number(event.target.value))}
                    className="w-36"
                    disabled={!useSpline}
                  />
                  <span className="w-12 text-right text-muted-foreground">{curveTensionPercent}%</span>
                </label>

                <label className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Stroke size</span>
                  <input
                    type="range"
                    min={40}
                    max={250}
                    step={5}
                    value={inkStrokeWidthPercent}
                    onChange={(event) => setInkStrokeWidthPercent(Number(event.target.value))}
                    className="w-36"
                  />
                  <span className="w-12 text-right text-muted-foreground">{inkStrokeWidthPercent}%</span>
                </label>

                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={lockStrokeWidthOnZoom}
                    onChange={(event) => setLockStrokeWidthOnZoom(event.target.checked)}
                    className="size-4"
                  />
                  Lock stroke width on zoom
                </label>

                <label className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Pressure gamma</span>
                  <input
                    type="range"
                    min={1}
                    max={2.2}
                    step={0.1}
                    value={pressureGamma}
                    onChange={(event) => setPressureGamma(Number(event.target.value))}
                    className="w-36"
                  />
                  <span className="w-12 text-right text-muted-foreground">{pressureGamma.toFixed(1)}</span>
                </label>

                <label className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Opacity</span>
                  <input
                    type="range"
                    min={20}
                    max={100}
                    step={5}
                    value={inkOpacityPercent}
                    onChange={(event) => setInkOpacityPercent(Number(event.target.value))}
                    className="w-36"
                  />
                  <span className="w-12 text-right text-muted-foreground">{inkOpacityPercent}%</span>
                </label>
              </div>

              <div className="space-y-1 border-t border-border pt-2 text-muted-foreground">
                <p>Page: {currentPage}</p>
                <p>PageKey: {inspectorPageKey ?? 'none'}</p>
                <p>Strokes: {inspectorStats.strokeCount}</p>
                <p>Points: {inspectorStats.pointCount}</p>
                <p>Avg step: {inspectorStats.avgStepNorm.toFixed(5)}</p>
                <p>Max jump: {inspectorStats.maxJumpNorm.toFixed(5)}</p>
                <p>Jumps &gt; 0.04: {inspectorStats.jumpSplitCount}</p>
                <p>Out-of-bounds: {(inspectorStats.outOfBoundsRatio * 100).toFixed(2)}%</p>
              </div>
            </div>
          )}

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
