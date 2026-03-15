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
import { PDFDocument } from 'pdf-lib'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import type {
  DocumentRecord,
  FlexcilImageAnnotation,
  FlexcilInkStroke,
  FlexcilShapeAnnotation,
  PdfSearchHit,
  TabViewState,
} from '../types'

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
const INK_DEBUG_GLOBAL_SETTINGS_KEY = 'flexcil-ink-debug-global-settings-v6'

type SearchHit = PdfSearchHit

interface TextContentItemLike {
  str?: string
}

type InkDecodeMode = 'auto' | 'absolute' | 'cumulative'
type DrawingDecodeMode = 'auto' | 'absolute' | 'cumulative'

interface InkDebugGlobalSettings {
  inkDecodeMode: InkDecodeMode
  drawingsMode5DecodeMode: DrawingDecodeMode
  drawingsFigure1DecodeMode: DrawingDecodeMode
  flipInkY: boolean
  splitByPressure: boolean
  pressureLiftThresholdRaw: number
  connectorRejectLengthPx: number
  inkOffsetXPercent: number
  inkOffsetYPercent: number
  inkScaleXPercent: number
  inkScaleYPercent: number
  showSegmentOverlay: boolean
  enableInkSmoothing: boolean
  inkSmoothingPercent: number
  inkStrokeWidthPercent: number
  inkOpacityPercent: number
  simplifyEpsilonPx: number
  chaikinIterations: number
  useSpline: boolean
  curveTensionPercent: number
  enableOneEuroFilter: boolean
  oneEuroMinCutoff: number
  oneEuroBeta: number
  pressureGamma: number
  speedSensitivity: number
  lockStrokeWidthOnZoom: boolean
}

const DEFAULT_INK_DEBUG_SETTINGS: InkDebugGlobalSettings = {
  inkDecodeMode: 'absolute',
  drawingsMode5DecodeMode: 'absolute',
  drawingsFigure1DecodeMode: 'absolute',
  flipInkY: false,
  splitByPressure: false,
  pressureLiftThresholdRaw: 0,
  connectorRejectLengthPx: 28,
  inkOffsetXPercent: 0,
  inkOffsetYPercent: 0.4,
  inkScaleXPercent: 100,
  inkScaleYPercent: 71.5,
  showSegmentOverlay: false,
  enableInkSmoothing: true,
  inkSmoothingPercent: 50,
  inkStrokeWidthPercent: 100,
  inkOpacityPercent: 100,
  simplifyEpsilonPx: 0,
  chaikinIterations: 0,
  useSpline: true,
  curveTensionPercent: 50,
  enableOneEuroFilter: false,
  oneEuroMinCutoff: 1,
  oneEuroBeta: 0.4,
  pressureGamma: 1.6,
  speedSensitivity: 20,
  lockStrokeWidthOnZoom: true,
}

function loadInkDebugGlobalSettings(): InkDebugGlobalSettings {
  try {
    const raw = localStorage.getItem(INK_DEBUG_GLOBAL_SETTINGS_KEY)
    if (!raw) {
      return DEFAULT_INK_DEBUG_SETTINGS
    }

    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      return DEFAULT_INK_DEBUG_SETTINGS
    }

    return {
      ...DEFAULT_INK_DEBUG_SETTINGS,
      ...parsed,
    }
  } catch {
    return DEFAULT_INK_DEBUG_SETTINGS
  }
}

function saveInkDebugGlobalSettings(settings: InkDebugGlobalSettings) {
  try {
    localStorage.setItem(INK_DEBUG_GLOBAL_SETTINGS_KEY, JSON.stringify(settings))
  } catch {
  }
}

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

function removeIsolatedSpikePoints(points: CanvasPoint[], spikeThresholdPx: number): CanvasPoint[] {
  if (points.length < 5) {
    return points
  }

  const filtered: CanvasPoint[] = [points[0]]

  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1]
    const current = points[index]
    const next = points[index + 1]

    const prevDistance = Math.hypot(current.x - previous.x, current.y - previous.y)
    const nextDistance = Math.hypot(next.x - current.x, next.y - current.y)
    const bridgeDistance = Math.hypot(next.x - previous.x, next.y - previous.y)

    const isSpike =
      prevDistance > spikeThresholdPx &&
      nextDistance > spikeThresholdPx &&
      bridgeDistance < Math.min(prevDistance, nextDistance) * 0.35

    if (!isSpike) {
      filtered.push(current)
    }
  }

  filtered.push(points[points.length - 1])
  return filtered
}

function computeSegmentLength(points: CanvasPoint[]): number {
  if (points.length < 2) {
    return 0
  }

  let length = 0
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]
    const current = points[index]
    length += Math.hypot(current.x - previous.x, current.y - previous.y)
  }
  return length
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
      const 
      current = result[index]
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

function computeInkPathStats(points: FlexcilInkStroke['points'] | undefined): {
  count: number
  lengthNorm: number
  spanNorm: number
  outOfBoundsRatio: number
} {
  if (!points || points.length === 0) {
    return { count: 0, lengthNorm: 0, spanNorm: 0, outOfBoundsRatio: 0 }
  }

  let lengthNorm = 0
  let outOfBounds = 0
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]
    minX = Math.min(minX, point.xNorm)
    maxX = Math.max(maxX, point.xNorm)
    minY = Math.min(minY, point.yNorm)
    maxY = Math.max(maxY, point.yNorm)

    if (point.xNorm < 0 || point.xNorm > 1 || point.yNorm < 0 || point.yNorm > 1) {
      outOfBounds += 1
    }

    if (index > 0) {
      const previous = points[index - 1]
      lengthNorm += Math.hypot(point.xNorm - previous.xNorm, point.yNorm - previous.yNorm)
    }
  }

  return {
    count: points.length,
    lengthNorm,
    spanNorm: Math.hypot(maxX - minX, maxY - minY),
    outOfBoundsRatio: outOfBounds / points.length,
  }
}

function medianNumber(values: number[]): number {
  if (values.length === 0) {
    return 0
  }

  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2
  }

  return sorted[middle]
}

function trimLeadingInkTrailPoints(points: FlexcilInkStroke['points']): FlexcilInkStroke['points'] {
  if (!points || points.length < 3) {
    return points
  }

  let cleaned = points

  // Drop duplicated starting coordinates that frequently appear after pen-lift metadata points.
  while (cleaned.length > 2) {
    const first = cleaned[0]
    const second = cleaned[1]
    const firstStep = Math.hypot(second.xNorm - first.xNorm, second.yNorm - first.yNorm)
    if (firstStep > 0.0000001) {
      break
    }
    cleaned = cleaned.slice(1)
  }

  for (let iteration = 0; iteration < 4 && cleaned.length >= 8; iteration += 1) {
    const segmentLengths: number[] = []
    for (let index = 1; index < cleaned.length; index += 1) {
      const previous = cleaned[index - 1]
      const current = cleaned[index]
      segmentLengths.push(Math.hypot(current.xNorm - previous.xNorm, current.yNorm - previous.yNorm))
    }

    if (segmentLengths.length < 4) {
      break
    }

    const firstLength = segmentLengths[0]
    const remainder = segmentLengths.slice(1)
    const nonZeroRemainder = remainder.filter((length) => length > 0.0000001)
    const baseline = medianNumber(nonZeroRemainder)
    const maxRemainder = nonZeroRemainder.length > 0 ? Math.max(...nonZeroRemainder) : 0
    const ratioToMedian = baseline > 0 ? firstLength / baseline : Infinity
    const ratioToMax = maxRemainder > 0 ? firstLength / maxRemainder : Infinity

    const looksLikeLeadingTrail =
      firstLength > 0.0022 &&
      ratioToMedian >= 4.5 &&
      ratioToMax >= 1.35

    if (!looksLikeLeadingTrail) {
      break
    }

    cleaned = cleaned.slice(1)
  }

  return cleaned
}

function deriveWidthMultiplierFromMetadataPressure(pressures: number[]): number {
  if (pressures.length === 0) {
    return 1
  }

  const sorted = [...pressures].sort((left, right) => left - right)
  const representative = percentileFromSorted(sorted, 0.7)

  // Empirical reference from Flexcil archives where scale stays at 1.
  const reference = 0.0028
  const normalized = representative / reference
  const curved = normalized ** 0.92
  return clamp(curved, 0.78, 2.9)
}

function percentileFromSorted(sorted: number[], percentile: number): number {
  if (sorted.length === 0) {
    return 0
  }

  const ratio = clamp(percentile, 0, 1)
  const index = Math.floor((sorted.length - 1) * ratio)
  return sorted[index]
}

function deriveRelativeMetadataWidthMultiplier(
  pressureMedian: number,
  distribution: { p25: number; p50: number; p75: number },
): number {
  const iqr = Math.max(distribution.p75 - distribution.p25, 0.0000001)
  const normalized = (pressureMedian - distribution.p50) / iqr
  const curved = Math.sign(normalized) * Math.abs(normalized) ** 0.85
  return clamp(1 + curved * 0.6, 0.7, 2.5)
}

function shouldFallbackToAbsoluteVariant(stroke: FlexcilInkStroke, candidate: FlexcilInkStroke['points']): boolean {
  const absolute = stroke.pointsAbsolute
  if (!absolute || absolute.length < 2 || !candidate || candidate.length < 2 || candidate === absolute) {
    return false
  }

  const candidateStats = computeInkPathStats(candidate)
  const absoluteStats = computeInkPathStats(absolute)
  if (candidateStats.count < 2 || absoluteStats.count < 2) {
    return false
  }

  const lengthRatio = candidateStats.lengthNorm / Math.max(absoluteStats.lengthNorm, 0.0001)
  const spanRatio = candidateStats.spanNorm / Math.max(absoluteStats.spanNorm, 0.0001)
  const candidateLooksSuspicious =
    candidateStats.outOfBoundsRatio > 0.1 ||
    (lengthRatio > 3.5 && spanRatio > 2.2) ||
    candidateStats.spanNorm > 1.25

  return candidateLooksSuspicious
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
  const globalInkDebugSettings = useMemo(() => loadInkDebugGlobalSettings(), [])
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<HTMLDivElement>(null)
  const viewerInstanceRef = useRef<PdfJsViewer | null>(null)
  const eventBusRef = useRef<EventBus | null>(null)
  const pdfDocumentRef = useRef<Awaited<ReturnType<typeof getDocument>>['promise'] extends Promise<infer T> ? T : never | null>(null)
  const lastNavigatedSearchStateRef = useRef<{ query: string; index: number } | null>(null)
  const pendingSearchClickRef = useRef<{ query: string; index: number } | null>(null)
  const navigationRequestIdRef = useRef(0)

  const [pagesCount, setPagesCount] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [scalePercent, setScalePercent] = useState(100)
  const [pageInput, setPageInput] = useState('1')
  const [internalSearchQuery, setInternalSearchQuery] = useState('')
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('')
  const [searchHits, setSearchHits] = useState<SearchHit[]>([])
  const [internalSelectedMatchIndex, setInternalSelectedMatchIndex] = useState(0)
  const [isSearching, setIsSearching] = useState(false)
  const [isDownloadingAnnotatedPdf, setIsDownloadingAnnotatedPdf] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAnnotations, setShowAnnotations] = useState(true)
  const [inkDecodeMode, setInkDecodeMode] = useState<InkDecodeMode>(globalInkDebugSettings.inkDecodeMode)
  const [drawingsMode5DecodeMode, setDrawingsMode5DecodeMode] = useState<DrawingDecodeMode>(
    globalInkDebugSettings.drawingsMode5DecodeMode,
  )
  const [drawingsFigure1DecodeMode, setDrawingsFigure1DecodeMode] = useState<DrawingDecodeMode>(
    globalInkDebugSettings.drawingsFigure1DecodeMode,
  )
  const [flipInkY, setFlipInkY] = useState(globalInkDebugSettings.flipInkY)
  const [splitByPressure, setSplitByPressure] = useState(globalInkDebugSettings.splitByPressure)
  const [pressureLiftThresholdRaw, setPressureLiftThresholdRaw] = useState(globalInkDebugSettings.pressureLiftThresholdRaw)
  const [connectorRejectLengthPx, setConnectorRejectLengthPx] = useState(globalInkDebugSettings.connectorRejectLengthPx)
  const [inkOffsetXPercent, setInkOffsetXPercent] = useState(globalInkDebugSettings.inkOffsetXPercent)
  const [inkOffsetYPercent, setInkOffsetYPercent] = useState(globalInkDebugSettings.inkOffsetYPercent)
  const [inkScaleXPercent, setInkScaleXPercent] = useState(globalInkDebugSettings.inkScaleXPercent)
  const [inkScaleYPercent, setInkScaleYPercent] = useState(globalInkDebugSettings.inkScaleYPercent)
  const [showInkDebugPanel, setShowInkDebugPanel] = useState(false)
  const [showSegmentOverlay, setShowSegmentOverlay] = useState(globalInkDebugSettings.showSegmentOverlay)
  const [enableInkSmoothing, setEnableInkSmoothing] = useState(globalInkDebugSettings.enableInkSmoothing)
  const [inkSmoothingPercent, setInkSmoothingPercent] = useState(globalInkDebugSettings.inkSmoothingPercent)
  const [inkStrokeWidthPercent, setInkStrokeWidthPercent] = useState(globalInkDebugSettings.inkStrokeWidthPercent)
  const [inkOpacityPercent, setInkOpacityPercent] = useState(globalInkDebugSettings.inkOpacityPercent)
  const [simplifyEpsilonPx, setSimplifyEpsilonPx] = useState(globalInkDebugSettings.simplifyEpsilonPx)
  const [chaikinIterations, setChaikinIterations] = useState(globalInkDebugSettings.chaikinIterations)
  const [useSpline, setUseSpline] = useState(globalInkDebugSettings.useSpline)
  const [curveTensionPercent, setCurveTensionPercent] = useState(globalInkDebugSettings.curveTensionPercent)
  const [enableOneEuroFilter, setEnableOneEuroFilter] = useState(globalInkDebugSettings.enableOneEuroFilter)
  const [oneEuroMinCutoff, setOneEuroMinCutoff] = useState(globalInkDebugSettings.oneEuroMinCutoff)
  const [oneEuroBeta, setOneEuroBeta] = useState(globalInkDebugSettings.oneEuroBeta)
  const [pressureGamma, setPressureGamma] = useState(globalInkDebugSettings.pressureGamma)
  const [speedSensitivity, setSpeedSensitivity] = useState(globalInkDebugSettings.speedSensitivity)
  const [lockStrokeWidthOnZoom, setLockStrokeWidthOnZoom] = useState(globalInkDebugSettings.lockStrokeWidthOnZoom)
  const [inkDefaultsSavedAt, setInkDefaultsSavedAt] = useState<number | null>(null)

  const saveCurrentDebugSettingsAsGlobalDefaults = useCallback(() => {
    saveInkDebugGlobalSettings({
      inkDecodeMode,
      drawingsMode5DecodeMode,
      drawingsFigure1DecodeMode,
      flipInkY,
      splitByPressure,
      pressureLiftThresholdRaw,
      connectorRejectLengthPx,
      inkOffsetXPercent,
      inkOffsetYPercent,
      inkScaleXPercent,
      inkScaleYPercent,
      showSegmentOverlay,
      enableInkSmoothing,
      inkSmoothingPercent,
      inkStrokeWidthPercent,
      inkOpacityPercent,
      simplifyEpsilonPx,
      chaikinIterations,
      useSpline,
      curveTensionPercent,
      enableOneEuroFilter,
      oneEuroMinCutoff,
      oneEuroBeta,
      pressureGamma,
      speedSensitivity,
      lockStrokeWidthOnZoom,
    })
    setInkDefaultsSavedAt(Date.now())
  }, [
    chaikinIterations,
    drawingsFigure1DecodeMode,
    drawingsMode5DecodeMode,
    connectorRejectLengthPx,
    curveTensionPercent,
    enableInkSmoothing,
    enableOneEuroFilter,
    flipInkY,
    inkDecodeMode,
    inkOffsetXPercent,
    inkOffsetYPercent,
    inkOpacityPercent,
    inkScaleXPercent,
    inkScaleYPercent,
    inkSmoothingPercent,
    inkStrokeWidthPercent,
    lockStrokeWidthOnZoom,
    oneEuroBeta,
    oneEuroMinCutoff,
    pressureGamma,
    pressureLiftThresholdRaw,
    showSegmentOverlay,
    simplifyEpsilonPx,
    speedSensitivity,
    splitByPressure,
    useSpline,
  ])

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

    const query = debouncedSearchQuery.trim()
    eventBus.dispatch('find', {
      source: 'viewer-search',
      type: 'highlightallchange',
      query,
      caseSensitive: false,
      entireWord: false,
      phraseSearch: true,
      highlightAll: query.length > 0,
      findPrevious: false,
      matchDiacritics: false,
    })
  }, [debouncedSearchQuery, loading, pagesCount])

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
      const resolveByMode = (mode: DrawingDecodeMode) => {
        if (mode === 'absolute') {
          return stroke.pointsAbsolute ?? stroke.points
        }
        if (mode === 'cumulative') {
          return stroke.pointsCumulative ?? stroke.points
        }
        return stroke.points
      }

      if (stroke.sourceMode === 5) {
        return resolveByMode(drawingsMode5DecodeMode)
      }

      if (stroke.sourceFigure === 1) {
        return resolveByMode(drawingsFigure1DecodeMode)
      }

      if (inkDecodeMode === 'absolute') {
        return stroke.pointsAbsolute ?? stroke.points
      }
      if (inkDecodeMode === 'cumulative') {
        const candidate = stroke.pointsCumulative ?? stroke.points
        return shouldFallbackToAbsoluteVariant(stroke, candidate)
          ? stroke.pointsAbsolute ?? stroke.points
          : candidate
      }
      return shouldFallbackToAbsoluteVariant(stroke, stroke.points)
        ? stroke.pointsAbsolute ?? stroke.points
        : stroke.points
    },
    [drawingsFigure1DecodeMode, drawingsMode5DecodeMode, inkDecodeMode],
  )

  const inspectorPageKey = useMemo(() => resolvePageKey(currentPage), [currentPage, resolvePageKey])

  const inspectorStrokes = useMemo(
    () => (inspectorPageKey ? document.inkDrawingsByPageKey?.[inspectorPageKey] ?? [] : []),
    [document.inkDrawingsByPageKey, inspectorPageKey],
  )

  const inspectorImageAnnotations = useMemo(
    () => (inspectorPageKey ? document.imageAnnotationsByPageKey?.[inspectorPageKey] ?? [] : []),
    [document.imageAnnotationsByPageKey, inspectorPageKey],
  )

  const inspectorShapes = useMemo(
    () => (inspectorPageKey ? document.shapeAnnotationsByPageKey?.[inspectorPageKey] ?? [] : []),
    [document.shapeAnnotationsByPageKey, inspectorPageKey],
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

  const drawStrokesOnCanvas = useCallback(
    (
      canvas: HTMLCanvasElement,
      strokes: FlexcilInkStroke[],
      clear = true,
      options?: { pixelScaleOverride?: number; zoomScaleOverride?: number },
    ) => {
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
    const canvasPixelScale =
      typeof options?.pixelScaleOverride === 'number' && Number.isFinite(options.pixelScaleOverride)
        ? Math.max(0.1, options.pixelScaleOverride)
        : (canvasScaleX + canvasScaleY) / 2
    const zoomScale =
      typeof options?.zoomScaleOverride === 'number' && Number.isFinite(options.zoomScaleOverride)
        ? Math.max(0.1, options.zoomScaleOverride)
        : Math.max(0.1, scalePercent / 100)

    const context = canvas.getContext('2d')
    if (!context) {
      return
    }

    if (clear) {
      context.clearRect(0, 0, canvas.width, canvas.height)
    }
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.miterLimit = 2

    const drawSegment = (segment: CanvasPoint[], baseStrokeWidth: number, forceLinear = false) => {
      if (segment.length < 2) {
        return
      }

      const prepared = (() => {
        let points = segment

        if (enableOneEuroFilter) {
          points = applyOneEuroFilter(points, oneEuroMinCutoff, oneEuroBeta)
        }

        if (enableInkSmoothing && splitByPressure) {
          points = applySpeedAdaptiveSmoothing(points, speedSensitivity)
        }

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

      if (!forceLinear && useSpline && prepared.length > 2) {
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
        const widthCss = forceLinear
          ? baseStrokeWidth
          : strokeWidthFromPressure(baseStrokeWidth, curr.pressure, pressureGamma)
        const widthDevicePx = widthCss * canvasPixelScale
        context.lineWidth = lockStrokeWidthOnZoom ? widthDevicePx * zoomScale : widthDevicePx
        context.stroke()
      }
    }

    const preparedStrokes = strokes
      .map((stroke) => ({
        stroke,
        points: trimLeadingInkTrailPoints(getStrokePoints(stroke)),
      }))
      .filter((item) => item.points && item.points.length >= 2)

    const metadataPressureMedians: number[] = []
    const metadataMedianByIndex = new Map<number, number>()

    for (let strokeIndex = 0; strokeIndex < preparedStrokes.length; strokeIndex += 1) {
      const item = preparedStrokes[strokeIndex]
      const pressures = item.points
        .map((point) => point.pressure)
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))

      if (pressures.length < 2) {
        continue
      }

      const maxPressure = Math.max(...pressures)
      // In Flexcil archives, metadata-width channels are tiny values near zero.
      if (maxPressure > 0.02) {
        continue
      }

      const sorted = [...pressures].sort((left, right) => left - right)
      const median = sorted[Math.floor(sorted.length / 2)]
      metadataMedianByIndex.set(strokeIndex, median)
      metadataPressureMedians.push(median)
    }

    const sortedMetadataMedians = [...metadataPressureMedians].sort((left, right) => left - right)
    const metadataDistribution =
      sortedMetadataMedians.length >= 4
        ? {
            p25: percentileFromSorted(sortedMetadataMedians, 0.25),
            p50: percentileFromSorted(sortedMetadataMedians, 0.5),
            p75: percentileFromSorted(sortedMetadataMedians, 0.75),
          }
        : undefined

    for (let strokeIndex = 0; strokeIndex < preparedStrokes.length; strokeIndex += 1) {
      const { stroke, points: strokePoints } = preparedStrokes[strokeIndex]

      if (!strokePoints || strokePoints.length < 2) {
        continue
      }

      const rawPressures = strokePoints
        .map((point) => point.pressure)
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
      const maxPressure = rawPressures.length > 0 ? Math.max(...rawPressures) : 0
      const pressureLooksLikeWidthMetadata = rawPressures.length >= 2 && maxPressure <= 0.02
      const metadataMedian = metadataMedianByIndex.get(strokeIndex)
      const metadataWidthMultiplier =
        pressureLooksLikeWidthMetadata && typeof metadataMedian === 'number'
          ? (() => {
              const absoluteMultiplier = deriveWidthMultiplierFromMetadataPressure(rawPressures)
              const relativeMultiplier = metadataDistribution
                ? deriveRelativeMetadataWidthMultiplier(metadataMedian, metadataDistribution)
                : absoluteMultiplier

              // Keep strong absolute size differences while still using relative local contrast.
              const blended = absoluteMultiplier * 0.85 + relativeMultiplier * 0.15

              // Prevent very short symbol strokes from becoming unnaturally thin, without flattening all widths.
              const minForShortStroke = strokePoints.length <= 6 ? 0.95 : 0.85
              return clamp(blended, minForShortStroke, 2.7)
            })()
          : 1

      context.strokeStyle = stroke.strokeStyle
      const baseStrokeWidthRaw = (Number.isFinite(stroke.lineWidth) ? stroke.lineWidth : 2) * widthMultiplier
      const baseStrokeWidth = pressureLooksLikeWidthMetadata
        ? baseStrokeWidthRaw * metadataWidthMultiplier
        : baseStrokeWidthRaw
      context.globalAlpha = showSegmentOverlay ? 1 : opacity
      const isGeneratedFigureStroke = stroke.sourceMode === 5 || stroke.sourceFigure === 1

      const canvasStrokePointsRaw = strokePoints.map((point) => ({
        x: toCanvasX(point.xNorm),
        y: toCanvasY(point.yNorm),
        pressure:
          pressureLooksLikeWidthMetadata || isGeneratedFigureStroke
            ? undefined
            : point.pressure,
      }))
      const spikeThresholdPx = Math.max(18, canvas.width * 0.03)
      const canvasStrokePoints = splitByPressure
        ? removeIsolatedSpikePoints(canvasStrokePointsRaw, spikeThresholdPx)
        : canvasStrokePointsRaw
      if (canvasStrokePoints.length < 2) {
        continue
      }

      const first = canvasStrokePoints[0]
      let previousX = first.x
      let previousY = first.y
      const jumpThresholdPx = Math.max(24, canvas.width * 0.04)
      const manualLiftThreshold = clamp(pressureLiftThresholdRaw, 0, 0.2)
      const usePressureLiftSplit = splitByPressure && !pressureLooksLikeWidthMetadata && !isGeneratedFigureStroke
      const liftPressureThreshold = Math.max(manualLiftThreshold, usePressureLiftSplit ? 0.05 : 0)
      const numericPressures = canvasStrokePoints
        .map((point) => point.pressure)
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
      const hasPressureData = numericPressures.length >= Math.max(2, Math.floor(canvasStrokePoints.length * 0.1))
      const geometricLiftSensitivity = 0.35 + (manualLiftThreshold / 0.2) * 0.45
      const firstIsLowPressure =
        usePressureLiftSplit && typeof first.pressure === 'number' && first.pressure <= liftPressureThreshold
      const secondPoint = canvasStrokePoints.length > 1 ? canvasStrokePoints[1] : undefined
      const secondIsLowPressure =
        usePressureLiftSplit &&
        typeof secondPoint?.pressure === 'number' &&
        secondPoint.pressure <= liftPressureThreshold
      const isFirstLiftPoint = usePressureLiftSplit && firstIsLowPressure && secondIsLowPressure
      let segments: CanvasPoint[][] = isGeneratedFigureStroke
        ? [canvasStrokePoints.map((point) => ({ x: point.x, y: point.y }))]
        : isFirstLiftPoint
          ? []
          : [[{ x: previousX, y: previousY, pressure: first.pressure }]]
      let previousWasLift = isGeneratedFigureStroke ? false : isFirstLiftPoint

      for (let index = 1; index < canvasStrokePoints.length && !isGeneratedFigureStroke; index += 1) {
        const point = canvasStrokePoints[index]
        const previousPoint = canvasStrokePoints[index - 1]
        const nextPoint = index + 1 < canvasStrokePoints.length ? canvasStrokePoints[index + 1] : undefined
        const x = point.x
        const y = point.y
        const jump = Math.hypot(x - previousX, y - previousY)
        const isLowPressurePoint =
          usePressureLiftSplit && typeof point.pressure === 'number' && point.pressure <= liftPressureThreshold

        const previousIsLowPressure =
          usePressureLiftSplit &&
          typeof previousPoint?.pressure === 'number' &&
          previousPoint.pressure <= liftPressureThreshold
        const nextIsLowPressure =
          usePressureLiftSplit && typeof nextPoint?.pressure === 'number' && nextPoint.pressure <= liftPressureThreshold
        const nextJump = nextPoint ? Math.hypot(nextPoint.x - x, nextPoint.y - y) : 0

        const geometricLiftSignal =
          jump > jumpThresholdPx * geometricLiftSensitivity && nextJump > jumpThresholdPx * geometricLiftSensitivity

        const nonDebugLiftSignal =
          (previousIsLowPressure || nextIsLowPressure) &&
          (jump > jumpThresholdPx * 0.45 || nextJump > jumpThresholdPx * 0.45)

        const pressureLiftSignal = isLowPressurePoint && nonDebugLiftSignal
        const fallbackLiftSignal = usePressureLiftSplit && !hasPressureData && geometricLiftSignal
        const isCurrentLiftPoint = pressureLiftSignal || fallbackLiftSignal

        // Treat lift points as separators only; do not draw them as stroke geometry.
        if (isCurrentLiftPoint) {
          previousWasLift = true
          previousX = x
          previousY = y
          continue
        }

        if (segments.length === 0 || jump > jumpThresholdPx || previousWasLift) {
          segments.push([{ x, y, pressure: point.pressure }])
        } else {
          const currentSegment = segments[segments.length - 1]
          currentSegment.push({ x, y, pressure: point.pressure })
        }

        previousWasLift = false
        previousX = x
        previousY = y
      }

      if (usePressureLiftSplit) {
        const connectorRejectThresholdPx = clamp(connectorRejectLengthPx, 8, 120)
        segments = segments.filter((segment) => {
          if (segment.length < 2) {
            return false
          }

          if (segment.length > 2) {
            return true
          }

          const segmentLength = computeSegmentLength(segment)
          // Ghost connectors are often represented as a long 2-point segment.
          if (segmentLength > connectorRejectThresholdPx) {
            return false
          }

          return true
        })
      }

      if (!isGeneratedFigureStroke && enableInkSmoothing && smoothingFactor > 0) {
        for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
          segments[segmentIndex] = applyChaikin(segments[segmentIndex], Math.round(smoothingFactor * 2))
        }
      }

      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
        const segment = segments[segmentIndex]
        if (showSegmentOverlay) {
          const hue = (segmentIndex * 67) % 360
          context.strokeStyle = `hsla(${hue}, 90%, 65%, 0.95)`
        } else {
          context.strokeStyle = stroke.strokeStyle
        }

        drawSegment(segment, baseStrokeWidth, isGeneratedFigureStroke)

        if (showSegmentOverlay && segment.length > 0) {
          const firstPoint = segment[0]
          context.beginPath()
          context.fillStyle = context.strokeStyle
          context.arc(firstPoint.x, firstPoint.y, 2.5, 0, Math.PI * 2)
          context.fill()
        }
      }
      context.globalAlpha = 1
    }
    },
    [
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
    connectorRejectLengthPx,
    pressureGamma,
    pressureLiftThresholdRaw,
    simplifyEpsilonPx,
    speedSensitivity,
    scalePercent,
    showSegmentOverlay,
    splitByPressure,
    useSpline,
      lockStrokeWidthOnZoom,
    ],
  )

  const drawImageAnnotationsOnCanvas = useCallback(
    async (canvas: HTMLCanvasElement, annotations: FlexcilImageAnnotation[]) => {
      if (!annotations || annotations.length === 0) {
        return
      }

      const context = canvas.getContext('2d')
      if (!context) {
        return
      }

      const offsetXNorm = inkOffsetXPercent / 100
      const offsetYNorm = inkOffsetYPercent / 100
      const scaleX = inkScaleXPercent / 100
      const scaleY = inkScaleYPercent / 100
      const opacity = Math.max(0, Math.min(1, inkOpacityPercent / 100))

      const toCanvasX = (xNorm: number) => (xNorm * scaleX + offsetXNorm) * canvas.width
      const toCanvasY = (yNorm: number) => {
        const shifted = yNorm * scaleY + offsetYNorm
        return (flipInkY ? 1 - shifted : shifted) * canvas.height
      }

      for (const annotation of annotations) {
        try {
          const bitmap = await createImageBitmap(annotation.imageBlob)

          const widthPx = Math.max(1, annotation.widthNorm * scaleX * canvas.width)
          const heightPx = Math.max(1, annotation.heightNorm * scaleY * canvas.height)
          const xPx = toCanvasX(annotation.xNorm)
          const yPx = toCanvasY(annotation.yNorm)

          const crop = annotation.cropBox
          const sourceX = crop ? Math.max(0, Math.min(1, crop.xNorm)) * bitmap.width : 0
          const sourceY = crop ? Math.max(0, Math.min(1, crop.yNorm)) * bitmap.height : 0
          const sourceW = crop ? Math.max(1, Math.min(1, crop.widthNorm) * bitmap.width) : bitmap.width
          const sourceH = crop ? Math.max(1, Math.min(1, crop.heightNorm) * bitmap.height) : bitmap.height

          context.save()
          context.globalAlpha = opacity

          if (typeof annotation.rotate === 'number' && Math.abs(annotation.rotate) > 0.0001) {
            const centerX = xPx + widthPx / 2
            const centerY = yPx + heightPx / 2
            context.translate(centerX, centerY)
            context.rotate(annotation.rotate)
            context.drawImage(
              bitmap,
              sourceX,
              sourceY,
              sourceW,
              sourceH,
              -widthPx / 2,
              -heightPx / 2,
              widthPx,
              heightPx,
            )
          } else {
            context.drawImage(bitmap, sourceX, sourceY, sourceW, sourceH, xPx, yPx, widthPx, heightPx)
          }

          context.restore()
          bitmap.close()
        } catch {
          continue
        }
      }

      context.globalAlpha = 1
    },
    [flipInkY, inkOffsetXPercent, inkOffsetYPercent, inkOpacityPercent, inkScaleXPercent, inkScaleYPercent],
  )

  const drawShapeAnnotationsOnCanvas = useCallback(
    (
      canvas: HTMLCanvasElement,
      shapes: FlexcilShapeAnnotation[],
      options?: { pixelScaleOverride?: number },
    ) => {
      if (!shapes || shapes.length === 0) {
        return
      }

      const context = canvas.getContext('2d')
      if (!context) {
        return
      }

      const offsetXNorm = inkOffsetXPercent / 100
      const offsetYNorm = inkOffsetYPercent / 100
      const scaleX = inkScaleXPercent / 100
      const scaleY = inkScaleYPercent / 100
      const opacity = Math.max(0, Math.min(1, inkOpacityPercent / 100))

      const toCanvasX = (xNorm: number) => (xNorm * scaleX + offsetXNorm) * canvas.width
      const toCanvasY = (yNorm: number) => {
        const shifted = yNorm * scaleY + offsetYNorm
        return (flipInkY ? 1 - shifted : shifted) * canvas.height
      }

      const canvasScaleX = canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : 1
      const canvasScaleY = canvas.clientHeight > 0 ? canvas.height / canvas.clientHeight : 1
      const canvasPixelScale =
        typeof options?.pixelScaleOverride === 'number' && Number.isFinite(options.pixelScaleOverride)
          ? Math.max(0.1, options.pixelScaleOverride)
          : (canvasScaleX + canvasScaleY) / 2

      const drawArrowHead = (
        fromX: number,
        fromY: number,
        endX: number,
        endY: number,
        strokeWidth: number,
        color: string,
      ) => {
        const dx = endX - fromX
        const dy = endY - fromY
        const length = Math.hypot(dx, dy)
        if (!Number.isFinite(length) || length < 0.0001) {
          return
        }

        const ux = dx / length
        const uy = dy / length
        const px = -uy
        const py = ux
        const headLength = Math.max(8, strokeWidth * 2.95)
        const headWidth = Math.max(8.2, strokeWidth * 5.05)
        const connectorLength = headLength * 0.5

        context.beginPath()
        context.moveTo(endX - ux * connectorLength, endY - uy * connectorLength)
        context.lineTo(endX, endY)
        context.moveTo(endX, endY)
        context.lineTo(endX - ux * headLength + px * headWidth * 0.5, endY - uy * headLength + py * headWidth * 0.5)
        context.moveTo(endX, endY)
        context.lineTo(endX - ux * headLength - px * headWidth * 0.5, endY - uy * headLength - py * headWidth * 0.5)
        context.strokeStyle = color
        context.lineCap = 'round'
        context.lineJoin = 'round'
        context.stroke()
      }

      for (const shape of shapes) {
        if (!shape.points || shape.points.length < 2) {
          continue
        }

        context.save()
        context.globalAlpha = opacity
        context.strokeStyle = shape.strokeStyle
        context.fillStyle = shape.fillStyle ?? 'transparent'
        const widthFromPoints =
          typeof shape.widthNorm === 'number' && Number.isFinite(shape.widthNorm) && shape.widthNorm > 0
            ? shape.widthNorm * Math.min(canvas.width, canvas.height)
            : 0
        const isSymbolShape = shape.shapeType === 7 || shape.shapeType === 9 || shape.shapeType === 4
        const scaleFromLineWidth = isSymbolShape ? 0.82 : 0.92
        const scaleFromWidthNorm = isSymbolShape ? 0.95 : 1.2
        const minStrokeWidth = isSymbolShape ? 0.9 : 1.05
        const strokeWidth = Math.max(
          minStrokeWidth,
          shape.lineWidth * canvasPixelScale * scaleFromLineWidth,
          widthFromPoints * scaleFromWidthNorm,
        )
        context.lineWidth = strokeWidth
        context.lineCap = 'round'
        context.lineJoin = 'round'
        context.setLineDash(
          shape.dashType === 1
            ? [8 * canvasPixelScale, 6 * canvasPixelScale]
            : shape.dashType === 2
              ? [2 * canvasPixelScale, 5 * canvasPixelScale]
              : [],
        )

        // Flexcil generated primitives: these types encode a bbox via two corner points.
        if ((shape.shapeType === 1 || shape.shapeType === 3 || shape.shapeType === 4) && shape.points.length >= 2) {
          const first = shape.points[0]
          const last = shape.points[shape.points.length - 1]
          const x1 = toCanvasX(first.xNorm)
          const y1 = toCanvasY(first.yNorm)
          const x2 = toCanvasX(last.xNorm)
          const y2 = toCanvasY(last.yNorm)
          const left = Math.min(x1, x2)
          const right = Math.max(x1, x2)
          const top = Math.min(y1, y2)
          const bottom = Math.max(y1, y2)
          const width = right - left
          const height = bottom - top

          // Tiny extents in legacy data should still behave like a line.
          const treatAsPrimitive = Math.min(width, height) > Math.max(6, strokeWidth * 2)

          if (treatAsPrimitive) {
            context.beginPath()

            if (shape.shapeType === 1) {
              const cx = (left + right) / 2
              const cy = (top + bottom) / 2
              context.ellipse(cx, cy, width / 2, height / 2, 0, 0, Math.PI * 2)
            } else if (shape.shapeType === 3) {
              context.rect(left, top, width, height)
            } else {
              const cx = (left + right) / 2
              const cy = (top + bottom) / 2
              const rx = width / 2
              const ry = height / 2
              const angleOffset = -Math.PI / 2

              for (let index = 0; index < 5; index += 1) {
                const angle = angleOffset + (index / 5) * Math.PI * 2
                const px = cx + Math.cos(angle) * rx
                const py = cy + Math.sin(angle) * ry
                if (index === 0) {
                  context.moveTo(px, py)
                } else {
                  context.lineTo(px, py)
                }
              }
              context.closePath()
            }

            context.stroke()
            context.restore()
            continue
          }
        }

        const shapePoints = shape.points
        const first = shapePoints[0]
        const lastOriginal = shapePoints[shapePoints.length - 1]

        let effectivePoints = shapePoints
        if (shape.shapeType === 7 && shapePoints.length >= 2) {
          const prev = shapePoints[shapePoints.length - 2]
          const dx = lastOriginal.xNorm - prev.xNorm
          const dy = lastOriginal.yNorm - prev.yNorm
          const lenNorm = Math.hypot(dx, dy)
          if (lenNorm > 0.000001) {
            const minDimPx = Math.min(canvas.width, canvas.height)
            const headLengthPx = Math.max(7, strokeWidth * 3.5)
            const headLengthNorm = headLengthPx / Math.max(1, minDimPx)
            const trimNorm = Math.min(lenNorm * 0.6, headLengthNorm * 0.6)
            const ux = dx / lenNorm
            const uy = dy / lenNorm
            const shortenedLast = {
              xNorm: lastOriginal.xNorm - ux * trimNorm,
              yNorm: lastOriginal.yNorm - uy * trimNorm,
            }
            effectivePoints = [...shapePoints.slice(0, -1), shortenedLast]
          }
        }

        context.beginPath()
        context.moveTo(toCanvasX(first.xNorm), toCanvasY(first.yNorm))

        if (shape.shapeType === 6 && shape.controlPoints && shape.controlPoints.length > 0 && effectivePoints.length >= 2) {
          const control = shape.controlPoints[0]
          const last = effectivePoints[effectivePoints.length - 1]
          context.quadraticCurveTo(
            toCanvasX(control.xNorm),
            toCanvasY(control.yNorm),
            toCanvasX(last.xNorm),
            toCanvasY(last.yNorm),
          )
        } else {
          for (let index = 1; index < effectivePoints.length; index += 1) {
            const point = effectivePoints[index]
            context.lineTo(toCanvasX(point.xNorm), toCanvasY(point.yNorm))
          }
        }

        if (shape.shapeType === 9 || shape.isClosed) {
          context.closePath()
        }

        const fillAlpha = (() => {
          if (!shape.fillStyle) {
            return 0
          }
          const match = shape.fillStyle.match(/rgba\([^)]*,\s*([0-9.]+)\s*\)$/i)
          if (!match) {
            return 0
          }
          const parsed = Number(match[1])
          return Number.isFinite(parsed) ? parsed : 0
        })()
        const hasVisibleFill = fillAlpha > 0.03
        const isFilledTriangleShape = shape.shapeType === 9 && effectivePoints.length <= 3
        const shouldFill = isFilledTriangleShape && hasVisibleFill
        if (shouldFill) {
          context.fill()
        }
        context.stroke()

        if (shape.shapeType === 7 && shapePoints.length >= 2) {
          const directionPoint =
            effectivePoints.length >= 2
              ? effectivePoints[effectivePoints.length - 2]
              : shapePoints[0]
          const endPoint = lastOriginal
          drawArrowHead(
            toCanvasX(directionPoint.xNorm),
            toCanvasY(directionPoint.yNorm),
            toCanvasX(endPoint.xNorm),
            toCanvasY(endPoint.yNorm),
            strokeWidth,
            shape.strokeStyle,
          )
        }

        context.restore()
      }

      context.setLineDash([])
      context.globalAlpha = 1
    },
    [flipInkY, inkOffsetXPercent, inkOffsetYPercent, inkOpacityPercent, inkScaleXPercent, inkScaleYPercent],
  )

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
      const imageAnnotations = document.imageAnnotationsByPageKey?.[pageKey]
      const shapes = document.shapeAnnotationsByPageKey?.[pageKey]
      const hasStrokes = Boolean(strokes && strokes.length > 0)
      const hasImages = Boolean(imageAnnotations && imageAnnotations.length > 0)
      const hasShapes = Boolean(shapes && shapes.length > 0)
      if (!hasStrokes && !hasImages && !hasShapes) {
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

      const pageStrokes = strokes ?? []
      const pageImages = imageAnnotations ?? []
      const pageShapes = shapes ?? []
      void (async () => {
        drawStrokesOnCanvas(overlay, pageStrokes, true)
        await drawImageAnnotationsOnCanvas(overlay, pageImages)
        drawStrokesOnCanvas(overlay, pageStrokes, false)
        drawShapeAnnotationsOnCanvas(overlay, pageShapes)
      })()
      canvasHost.appendChild(overlay)
    }
  }, [
    document.imageAnnotationsByPageKey,
    document.inkDrawingsByPageKey,
    document.shapeAnnotationsByPageKey,
    drawImageAnnotationsOnCanvas,
    drawShapeAnnotationsOnCanvas,
    drawStrokesOnCanvas,
    resolvePageKey,
    showAnnotations,
  ])

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
    const timer = window.setTimeout(() => {
      setDebouncedSearchQuery(searchQuery)
    }, 220)

    return () => {
      window.clearTimeout(timer)
    }
  }, [searchQuery])

  useEffect(() => {
    const query = debouncedSearchQuery.trim().toLowerCase()
    const pdfDocument = pdfDocumentRef.current

    if (!showSearchSidebar || !query || !pdfDocument) {
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

        // Yield every page so wheel/scroll interactions stay responsive during indexing.
        await new Promise<void>((resolve) => {
          window.setTimeout(() => resolve(), 0)
        })

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
  }, [debouncedSearchQuery, pagesCount, showSearchSidebar])

  useEffect(() => {
    onSearchHitsChange?.(searchHits)
  }, [onSearchHitsChange, searchHits])

  const navigateToPage = useCallback((nextPage: number) => {
    const viewer = viewerInstanceRef.current
    if (!viewer || pagesCount === 0) {
      return
    }

    const navigationRequestId = navigationRequestIdRef.current + 1
    navigationRequestIdRef.current = navigationRequestId

    const safePage = Math.max(1, Math.min(nextPage, pagesCount))
    viewer.currentPageNumber = safePage

    try {
      const jump = viewer as unknown as {
        scrollPageIntoView?: (params: { pageNumber: number }) => void
      }
      jump.scrollPageIntoView?.({ pageNumber: safePage })
    } catch {
    }

    const ensureDomScroll = (attempt = 0) => {
      if (navigationRequestIdRef.current !== navigationRequestId) {
        return
      }

      const host = viewerRef.current
      if (!host) {
        return
      }

      const pageElement = host.querySelector<HTMLElement>(`.page[data-page-number=\"${safePage}\"]`)
      if (pageElement) {
        pageElement.scrollIntoView({ block: 'start', behavior: 'auto' })
        return
      }

      if (attempt < 10) {
        window.setTimeout(() => ensureDomScroll(attempt + 1), 45)
      }
    }

    window.requestAnimationFrame(() => {
      if (navigationRequestIdRef.current !== navigationRequestId) {
        return
      }
      ensureDomScroll()
    })
    setCurrentPage(safePage)
    setPageInput(String(safePage))
  }, [pagesCount])

  useEffect(() => {
    return () => {
      navigationRequestIdRef.current += 1
    }
  }, [])

  useEffect(() => {
    const query = searchQuery.trim()
    if (!query || searchHits.length === 0) {
      lastNavigatedSearchStateRef.current = null
      pendingSearchClickRef.current = null
      return
    }

    const safeIndex = Math.max(0, Math.min(selectedMatchIndex, searchHits.length - 1))
    if (safeIndex !== selectedMatchIndex) {
      setSelectedMatchIndex(safeIndex)
      return
    }

    const pendingClick = pendingSearchClickRef.current
    if (pendingClick && pendingClick.query === query) {
      if (pendingClick.index !== safeIndex) {
        // Ignore stale controlled-index updates until it catches up with the most recent click.
        return
      }

      pendingSearchClickRef.current = null
    }

    const lastState = lastNavigatedSearchStateRef.current
    // Do not auto-jump while typing/changing query; only jump on explicit match index changes.
    if (!lastState || lastState.query !== query) {
      lastNavigatedSearchStateRef.current = { query, index: safeIndex }
      return
    }

    if (lastState.index === safeIndex) {
      return
    }

    const hit = searchHits[safeIndex]
    if (!hit) {
      return
    }

    navigateToPage(hit.pageNumber)

    lastNavigatedSearchStateRef.current = { query, index: safeIndex }
  }, [navigateToPage, searchHits, searchQuery, selectedMatchIndex, setSelectedMatchIndex])

  const goToPage = useCallback((nextPage: number) => {
    navigateToPage(nextPage)
  }, [navigateToPage])

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

  const downloadOriginalPdf = useCallback(() => {
    const url = URL.createObjectURL(document.pdfBlob)
    const anchor = window.document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.click()
    URL.revokeObjectURL(url)
  }, [document.pdfBlob, fileName])

  const download = async () => {
    if (isDownloadingAnnotatedPdf) {
      return
    }

    const sourcePdf = pdfDocumentRef.current
    const hasInkOverlays = Boolean(document.inkDrawingsByPageKey && Object.keys(document.inkDrawingsByPageKey).length > 0)
    const hasImageOverlays = Boolean(
      document.imageAnnotationsByPageKey && Object.keys(document.imageAnnotationsByPageKey).length > 0,
    )
    const hasShapeOverlays = Boolean(
      document.shapeAnnotationsByPageKey && Object.keys(document.shapeAnnotationsByPageKey).length > 0,
    )

    if (!sourcePdf || (!hasInkOverlays && !hasImageOverlays && !hasShapeOverlays)) {
      downloadOriginalPdf()
      return
    }

    setIsDownloadingAnnotatedPdf(true)
    try {
      const outputPdf = await PDFDocument.create()
      const renderScale = 2

      for (let pageNumber = 1; pageNumber <= sourcePdf.numPages; pageNumber += 1) {
        const pdfPage = await sourcePdf.getPage(pageNumber)
        const baseViewport = pdfPage.getViewport({ scale: 1 })
        const renderViewport = pdfPage.getViewport({ scale: renderScale })

        const canvas = window.document.createElement('canvas')
        canvas.width = Math.max(1, Math.ceil(renderViewport.width))
        canvas.height = Math.max(1, Math.ceil(renderViewport.height))

        const context = canvas.getContext('2d', { alpha: false })
        if (!context) {
          continue
        }

        await pdfPage.render({ canvas: canvas, canvasContext: context, viewport: renderViewport }).promise

        const pageKey = resolvePageKey(pageNumber)
        const pageImages = pageKey ? document.imageAnnotationsByPageKey?.[pageKey] ?? [] : []
        const pageStrokes = pageKey ? document.inkDrawingsByPageKey?.[pageKey] ?? [] : []
        const pageShapes = pageKey ? document.shapeAnnotationsByPageKey?.[pageKey] ?? [] : []

        if (pageImages.length > 0) {
          await drawImageAnnotationsOnCanvas(canvas, pageImages)
        }
        if (pageStrokes.length > 0) {
          drawStrokesOnCanvas(canvas, pageStrokes, false, { pixelScaleOverride: renderScale })
        }
        if (pageShapes.length > 0) {
          drawShapeAnnotationsOnCanvas(canvas, pageShapes, { pixelScaleOverride: renderScale })
        }

        const flattenedBlob = await new Promise<Blob | null>((resolveBlob) => {
          canvas.toBlob(resolveBlob, 'image/jpeg', 0.92)
        })
        if (!flattenedBlob) {
          continue
        }

        const flattenedBytes = new Uint8Array(await flattenedBlob.arrayBuffer())
        const embedded = await outputPdf.embedJpg(flattenedBytes)
        const outPage = outputPdf.addPage([baseViewport.width, baseViewport.height])
        outPage.drawImage(embedded, {
          x: 0,
          y: 0,
          width: baseViewport.width,
          height: baseViewport.height,
        })

        pdfPage.cleanup()
      }

      const outputBytes = await outputPdf.save()
      const normalizedOutputBytes = new Uint8Array(outputBytes.byteLength)
      normalizedOutputBytes.set(outputBytes)
      const outputBlob = new Blob([normalizedOutputBytes], { type: 'application/pdf' })
      const outputUrl = URL.createObjectURL(outputBlob)
      const anchor = window.document.createElement('a')
      const baseName = fileName.replace(/\.pdf$/i, '')
      anchor.href = outputUrl
      anchor.download = `${baseName}-annotated.pdf`
      anchor.click()
      URL.revokeObjectURL(outputUrl)
    } catch {
      downloadOriginalPdf()
    } finally {
      setIsDownloadingAnnotatedPdf(false)
    }
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
          disabled={isDownloadingAnnotatedPdf}
          className="ml-auto inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm hover:bg-muted"
        >
          <Download className="size-4" />
          {isDownloadingAnnotatedPdf ? 'Preparing…' : 'Download'}
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
                    const query = searchQuery.trim()
                    pendingSearchClickRef.current = {
                      query,
                      index,
                    }
                    setSelectedMatchIndex(index)
                    goToPage(hit.pageNumber)
                    lastNavigatedSearchStateRef.current = {
                      query,
                      index,
                    }
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

                <label className="col-span-2 flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Drawings mode=5 decode</span>
                  <select
                    value={drawingsMode5DecodeMode}
                    onChange={(event) => setDrawingsMode5DecodeMode(event.target.value as DrawingDecodeMode)}
                    className="h-7 rounded-md border border-border bg-background px-2 text-xs"
                  >
                    <option value="auto">Auto</option>
                    <option value="absolute">Absolute</option>
                    <option value="cumulative">Cumulative</option>
                  </select>
                </label>

                <label className="col-span-2 flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Drawings figure=1 decode</span>
                  <select
                    value={drawingsFigure1DecodeMode}
                    onChange={(event) => setDrawingsFigure1DecodeMode(event.target.value as DrawingDecodeMode)}
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

                <label className="col-span-2 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={showSegmentOverlay}
                    onChange={(event) => setShowSegmentOverlay(event.target.checked)}
                    className="size-4"
                  />
                  Segment overlay (diagnose connectors)
                </label>

                <label className="col-span-2 flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Pressure lift threshold (raw)</span>
                  <input
                    type="range"
                    min={0}
                    max={0.2}
                    step={0.0005}
                    value={pressureLiftThresholdRaw}
                    onChange={(event) => setPressureLiftThresholdRaw(Number(event.target.value))}
                    className="w-20"
                  />
                  <input
                    type="number"
                    min={0}
                    max={0.2}
                    step={0.0005}
                    value={pressureLiftThresholdRaw.toFixed(4)}
                    onChange={(event) => {
                      const nextValue = Number(event.target.value)
                      if (!Number.isFinite(nextValue)) {
                        return
                      }
                      setPressureLiftThresholdRaw(clamp(nextValue, 0, 0.2))
                    }}
                    className="h-7 w-16 rounded-md border border-border bg-background px-1.5 text-right text-xs"
                  />
                  <span className="w-14 text-right text-muted-foreground">
                    {pressureLiftThresholdRaw.toFixed(4)}
                  </span>
                </label>

                <label className="col-span-2 flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Connector reject length</span>
                  <input
                    type="range"
                    min={8}
                    max={80}
                    step={1}
                    value={connectorRejectLengthPx}
                    onChange={(event) => setConnectorRejectLengthPx(Number(event.target.value))}
                    className="w-20"
                  />
                  <input
                    type="number"
                    min={8}
                    max={120}
                    step={1}
                    value={connectorRejectLengthPx}
                    onChange={(event) => {
                      const nextValue = Number(event.target.value)
                      if (!Number.isFinite(nextValue)) {
                        return
                      }
                      setConnectorRejectLengthPx(Math.round(clamp(nextValue, 8, 120)))
                    }}
                    className="h-7 w-16 rounded-md border border-border bg-background px-1.5 text-right text-xs"
                  />
                  <span className="w-14 text-right text-muted-foreground">{connectorRejectLengthPx}px</span>
                </label>
              </div>

              <div className="mb-3 space-y-2">
                <button
                  type="button"
                  onClick={saveCurrentDebugSettingsAsGlobalDefaults}
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
                >
                  Save current debug settings as global defaults
                </button>

                {inkDefaultsSavedAt && (
                  <p className="text-[11px] text-emerald-500">Global debug defaults saved.</p>
                )}

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
                <p>Images on page: {inspectorImageAnnotations.length}</p>
                <p>Shapes on page: {inspectorShapes.length}</p>
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
