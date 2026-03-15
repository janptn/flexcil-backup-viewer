import JSZip from 'jszip'
import { PDFDocument } from 'pdf-lib'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import type {
  DocumentRecord,
  FlexcilImageAnnotation,
  FlexcilInkPoint,
  FlexcilInkStroke,
  FlexcilShapeAnnotation,
} from '../types'

GlobalWorkerOptions.workerSrc = workerUrl

const EXPORT_RENDER_SCALE = 2
const INK_OFFSET_X_NORM = 0
const INK_OFFSET_Y_NORM = 0.004
const INK_SCALE_X = 1
const INK_SCALE_Y = 0.715
const INK_OPACITY = 1
const INK_WIDTH_MULTIPLIER = 1
const ENABLE_INK_SMOOTHING = true
const SIMPLIFY_EPSILON_PX = 0
const CHAIKIN_ITERATIONS = 0
const USE_SPLINE = true
const CURVE_TENSION_PERCENT = 50
const ENABLE_ONE_EURO_FILTER = false
const ONE_EURO_MIN_CUTOFF = 1
const ONE_EURO_BETA = 0.4
const PRESSURE_GAMMA = 1.6
const SPEED_SENSITIVITY = 20
const SPLIT_BY_PRESSURE = false
const LOCK_STROKE_WIDTH_ON_ZOOM = true
const ZIP_COMPRESSION_LEVEL = 6

const META_FOLDER_KEYS = new Set([
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

export interface ExportProgress {
  stage: string
  percent: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function findFolderValueFromMeta(meta: unknown): string | undefined {
  if (!isRecord(meta)) {
    return undefined
  }

  for (const [key, value] of Object.entries(meta)) {
    if (META_FOLDER_KEYS.has(key.toLowerCase()) && typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }

  for (const value of Object.values(meta)) {
    const nested = findFolderValueFromMeta(value)
    if (nested) {
      return nested
    }
  }

  return undefined
}

function getDocumentFolderSegments(document: DocumentRecord): string[] {
  const fromPath = document.folderPath?.filter((segment) => segment.trim().length > 0) ?? []
  if (fromPath.length > 0) {
    return fromPath
  }

  const fromMeta = findFolderValueFromMeta(document.meta)
  if (!fromMeta) {
    return []
  }

  return fromMeta
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
}

function sanitizePathSegment(name: string): string {
  const sanitized = name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/g, '')

  return sanitized.length > 0 ? sanitized : 'untitled'
}

function hasAnnotations(document: DocumentRecord): boolean {
  const hasInk = Boolean(document.inkDrawingsByPageKey && Object.keys(document.inkDrawingsByPageKey).length > 0)
  const hasImages = Boolean(document.imageAnnotationsByPageKey && Object.keys(document.imageAnnotationsByPageKey).length > 0)
  const hasShapes = Boolean(document.shapeAnnotationsByPageKey && Object.keys(document.shapeAnnotationsByPageKey).length > 0)

  return hasInk || hasImages || hasShapes
}

interface CanvasPoint {
  x: number
  y: number
  pressure?: number
}

function toCanvasX(xNorm: number, canvasWidth: number): number {
  return (xNorm * INK_SCALE_X + INK_OFFSET_X_NORM) * canvasWidth
}

function toCanvasY(yNorm: number, canvasHeight: number): number {
  return (yNorm * INK_SCALE_Y + INK_OFFSET_Y_NORM) * canvasHeight
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

function strokeWidthFromPressure(baseWidth: number, pressure: number | undefined, gamma: number): number {
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

    const looksLikeLeadingTrail = firstLength > 0.0022 && ratioToMedian >= 4.5 && ratioToMax >= 1.35
    if (!looksLikeLeadingTrail) {
      break
    }

    cleaned = cleaned.slice(1)
  }

  return cleaned
}

function percentileFromSorted(sorted: number[], percentile: number): number {
  if (sorted.length === 0) {
    return 0
  }

  const ratio = clamp(percentile, 0, 1)
  const index = Math.floor((sorted.length - 1) * ratio)
  return sorted[index]
}

function deriveWidthMultiplierFromMetadataPressure(pressures: number[]): number {
  if (pressures.length === 0) {
    return 1
  }

  const sorted = [...pressures].sort((left, right) => left - right)
  const representative = percentileFromSorted(sorted, 0.7)
  const reference = 0.0028
  const normalized = representative / reference
  const curved = normalized ** 0.92
  return clamp(curved, 0.78, 2.9)
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

function resolveStrokePoints(stroke: FlexcilInkStroke): FlexcilInkStroke['points'] {
  const preferred = stroke.pointsAbsolute ?? stroke.points
  return shouldFallbackToAbsoluteVariant(stroke, preferred)
    ? stroke.pointsAbsolute ?? stroke.points
    : preferred
}

function drawStrokesOnCanvas(
  canvas: HTMLCanvasElement,
  strokes: FlexcilInkStroke[],
  clear = true,
  options?: { pixelScaleOverride?: number; zoomScaleOverride?: number },
) {
  if (!strokes || strokes.length === 0) {
    return
  }

  const context = canvas.getContext('2d')
  if (!context) {
    return
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
      : 1

  if (clear) {
    context.clearRect(0, 0, canvas.width, canvas.height)
  }

  const drawSegment = (segment: CanvasPoint[], baseStrokeWidth: number, forceLinear = false) => {
    if (segment.length < 2) {
      return
    }

    const prepared = (() => {
      let points = segment

      if (ENABLE_ONE_EURO_FILTER) {
        points = applyOneEuroFilter(points, ONE_EURO_MIN_CUTOFF, ONE_EURO_BETA)
      }

      if (ENABLE_INK_SMOOTHING && SPLIT_BY_PRESSURE) {
        points = applySpeedAdaptiveSmoothing(points, SPEED_SENSITIVITY)
      }

      if (SIMPLIFY_EPSILON_PX > 0) {
        points = simplifyRdp(points, SIMPLIFY_EPSILON_PX)
      }

      if (CHAIKIN_ITERATIONS > 0) {
        points = applyChaikin(points, CHAIKIN_ITERATIONS)
      }

      return points
    })()

    if (prepared.length < 2) {
      return
    }

    if (!forceLinear && USE_SPLINE && prepared.length > 2) {
      context.beginPath()
      context.moveTo(prepared[0].x, prepared[0].y)
      const tension = clamp(CURVE_TENSION_PERCENT / 100, 0, 1)

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

      const widthCss = strokeWidthFromPressure(baseStrokeWidth, avgPressure, PRESSURE_GAMMA)
      const widthDevicePx = widthCss * canvasPixelScale
      context.lineWidth = LOCK_STROKE_WIDTH_ON_ZOOM ? widthDevicePx * zoomScale : widthDevicePx
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
        : strokeWidthFromPressure(baseStrokeWidth, curr.pressure, PRESSURE_GAMMA)
      const widthDevicePx = widthCss * canvasPixelScale
      context.lineWidth = LOCK_STROKE_WIDTH_ON_ZOOM ? widthDevicePx * zoomScale : widthDevicePx
      context.stroke()
    }
  }

  context.globalAlpha = INK_OPACITY
  context.lineCap = 'round'
  context.lineJoin = 'round'

  const preparedStrokes = strokes
    .map((stroke) => ({
      stroke,
      points: trimLeadingInkTrailPoints(resolveStrokePoints(stroke)),
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
            const blended = absoluteMultiplier * 0.85 + relativeMultiplier * 0.15
            const minForShortStroke = strokePoints.length <= 6 ? 0.95 : 0.85
            return clamp(blended, minForShortStroke, 2.7)
          })()
        : 1

    context.strokeStyle = stroke.strokeStyle
    const baseStrokeWidthRaw = (Number.isFinite(stroke.lineWidth) ? stroke.lineWidth : 2) * INK_WIDTH_MULTIPLIER
    const baseStrokeWidth = pressureLooksLikeWidthMetadata
      ? baseStrokeWidthRaw * metadataWidthMultiplier
      : baseStrokeWidthRaw

    const isGeneratedFigureStroke = stroke.sourceMode === 5 || stroke.sourceFigure === 1
    const canvasStrokePointsRaw = strokePoints.map((point: FlexcilInkPoint) => ({
      x: toCanvasX(point.xNorm, canvas.width),
      y: toCanvasY(point.yNorm, canvas.height),
      pressure: pressureLooksLikeWidthMetadata || isGeneratedFigureStroke ? undefined : point.pressure,
    }))

    const canvasStrokePoints = canvasStrokePointsRaw

    if (canvasStrokePoints.length < 2) {
      continue
    }

    drawSegment(canvasStrokePoints, baseStrokeWidth, isGeneratedFigureStroke)
  }

  context.globalAlpha = 1
}

async function drawImageAnnotationsOnCanvas(canvas: HTMLCanvasElement, annotations: FlexcilImageAnnotation[]) {
  if (!annotations || annotations.length === 0) {
    return
  }

  const context = canvas.getContext('2d')
  if (!context) {
    return
  }

  for (const annotation of annotations) {
    try {
      const bitmap = await createImageBitmap(annotation.imageBlob)

      const widthPx = Math.max(1, annotation.widthNorm * INK_SCALE_X * canvas.width)
      const heightPx = Math.max(1, annotation.heightNorm * INK_SCALE_Y * canvas.height)
      const xPx = toCanvasX(annotation.xNorm, canvas.width)
      const yPx = toCanvasY(annotation.yNorm, canvas.height)

      const crop = annotation.cropBox
      const sourceX = crop ? Math.max(0, Math.min(1, crop.xNorm)) * bitmap.width : 0
      const sourceY = crop ? Math.max(0, Math.min(1, crop.yNorm)) * bitmap.height : 0
      const sourceW = crop ? Math.max(1, Math.min(1, crop.widthNorm) * bitmap.width) : bitmap.width
      const sourceH = crop ? Math.max(1, Math.min(1, crop.heightNorm) * bitmap.height) : bitmap.height

      context.save()

      if (typeof annotation.rotate === 'number' && Math.abs(annotation.rotate) > 0.0001) {
        const centerX = xPx + widthPx / 2
        const centerY = yPx + heightPx / 2
        context.translate(centerX, centerY)
        context.rotate(annotation.rotate)
        context.drawImage(bitmap, sourceX, sourceY, sourceW, sourceH, -widthPx / 2, -heightPx / 2, widthPx, heightPx)
      } else {
        context.drawImage(bitmap, sourceX, sourceY, sourceW, sourceH, xPx, yPx, widthPx, heightPx)
      }

      context.restore()
      bitmap.close()
    } catch {
      continue
    }
  }
}

function drawShapeAnnotationsOnCanvas(
  canvas: HTMLCanvasElement,
  shapes: FlexcilShapeAnnotation[],
  options?: { pixelScaleOverride?: number },
) {
  if (!shapes || shapes.length === 0) {
    return
  }

  const context = canvas.getContext('2d')
  if (!context) {
    return
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

    if ((shape.shapeType === 1 || shape.shapeType === 3 || shape.shapeType === 4) && shape.points.length >= 2) {
      const first = shape.points[0]
      const last = shape.points[shape.points.length - 1]
      const x1 = toCanvasX(first.xNorm, canvas.width)
      const y1 = toCanvasY(first.yNorm, canvas.height)
      const x2 = toCanvasX(last.xNorm, canvas.width)
      const y2 = toCanvasY(last.yNorm, canvas.height)
      const left = Math.min(x1, x2)
      const right = Math.max(x1, x2)
      const top = Math.min(y1, y2)
      const bottom = Math.max(y1, y2)
      const width = right - left
      const height = bottom - top
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
    context.moveTo(toCanvasX(first.xNorm, canvas.width), toCanvasY(first.yNorm, canvas.height))

    if (shape.shapeType === 6 && shape.controlPoints && shape.controlPoints.length > 0 && effectivePoints.length >= 2) {
      const control = shape.controlPoints[0]
      const last = effectivePoints[effectivePoints.length - 1]
      context.quadraticCurveTo(
        toCanvasX(control.xNorm, canvas.width),
        toCanvasY(control.yNorm, canvas.height),
        toCanvasX(last.xNorm, canvas.width),
        toCanvasY(last.yNorm, canvas.height),
      )
    } else {
      for (let index = 1; index < effectivePoints.length; index += 1) {
        const point = effectivePoints[index]
        context.lineTo(toCanvasX(point.xNorm, canvas.width), toCanvasY(point.yNorm, canvas.height))
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
    if (isFilledTriangleShape && hasVisibleFill) {
      context.fill()
    }

    context.stroke()

    if (shape.shapeType === 7 && shapePoints.length >= 2) {
      const directionPoint =
        effectivePoints.length >= 2 ? effectivePoints[effectivePoints.length - 2] : shapePoints[0]
      const endPoint = lastOriginal
      drawArrowHead(
        toCanvasX(directionPoint.xNorm, canvas.width),
        toCanvasY(directionPoint.yNorm, canvas.height),
        toCanvasX(endPoint.xNorm, canvas.width),
        toCanvasY(endPoint.yNorm, canvas.height),
        strokeWidth,
        shape.strokeStyle,
      )
    }

    context.restore()
  }

  context.setLineDash([])
}

async function renderDocumentWithAnnotations(documentRecord: DocumentRecord): Promise<Uint8Array> {
  const inputBytes = new Uint8Array(await documentRecord.pdfBlob.arrayBuffer())
  const loadingTask = getDocument({ data: inputBytes })
  const sourcePdf = await loadingTask.promise
  const outputPdf = await PDFDocument.create()

  try {
    for (let pageNumber = 1; pageNumber <= sourcePdf.numPages; pageNumber += 1) {
      const pdfPage = await sourcePdf.getPage(pageNumber)
      const baseViewport = pdfPage.getViewport({ scale: 1 })
      const renderViewport = pdfPage.getViewport({ scale: EXPORT_RENDER_SCALE })

      const canvas = window.document.createElement('canvas')
      canvas.width = Math.max(1, Math.ceil(renderViewport.width))
      canvas.height = Math.max(1, Math.ceil(renderViewport.height))

      const context = canvas.getContext('2d', { alpha: false })
      if (!context) {
        continue
      }

      await pdfPage.render({ canvas, canvasContext: context, viewport: renderViewport }).promise

      const pageKey = documentRecord.inkPageKeys?.[String(pageNumber)]
      const pageStrokes = pageKey ? documentRecord.inkDrawingsByPageKey?.[pageKey] ?? [] : []
      const pageImages = pageKey ? documentRecord.imageAnnotationsByPageKey?.[pageKey] ?? [] : []
      const pageShapes = pageKey ? documentRecord.shapeAnnotationsByPageKey?.[pageKey] ?? [] : []

      if (pageImages.length > 0) {
        await drawImageAnnotationsOnCanvas(canvas, pageImages)
      }
      if (pageStrokes.length > 0) {
        drawStrokesOnCanvas(canvas, pageStrokes, false, { pixelScaleOverride: EXPORT_RENDER_SCALE })
      }
      if (pageShapes.length > 0) {
        drawShapeAnnotationsOnCanvas(canvas, pageShapes, { pixelScaleOverride: EXPORT_RENDER_SCALE })
      }

      const flattenedBlob = await new Promise<Blob | null>((resolveBlob) => {
        canvas.toBlob(resolveBlob, 'image/jpeg', 0.92)
      })

      if (flattenedBlob) {
        const flattenedBytes = new Uint8Array(await flattenedBlob.arrayBuffer())
        const embedded = await outputPdf.embedJpg(flattenedBytes)
        const outPage = outputPdf.addPage([baseViewport.width, baseViewport.height])
        outPage.drawImage(embedded, {
          x: 0,
          y: 0,
          width: baseViewport.width,
          height: baseViewport.height,
        })
      }

      pdfPage.cleanup()
      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), 0)
      })
    }

    const outputBytes = await outputPdf.save()
    const normalizedOutputBytes = new Uint8Array(outputBytes.byteLength)
    normalizedOutputBytes.set(outputBytes)
    return normalizedOutputBytes
  } finally {
    try {
      await loadingTask.destroy()
    } catch {
    }
  }
}

function createDownloadFileName(): string {
  const now = new Date()
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
  ]

  return `flexcil-documents-${parts.join('')}.zip`
}

function emitProgress(
  onProgress: ((progress: ExportProgress) => void) | undefined,
  stage: string,
  percent: number,
) {
  if (!onProgress) {
    return
  }

  onProgress({ stage, percent: clamp(percent, 0, 100) })
}

export async function exportAllDocumentsAsZip(
  documents: DocumentRecord[],
  onProgress?: (progress: ExportProgress) => void,
): Promise<string> {
  if (documents.length === 0) {
    throw new Error('No documents available for export.')
  }

  const zip = new JSZip()
  const usedPaths = new Set<string>()

  for (let index = 0; index < documents.length; index += 1) {
    const documentRecord = documents[index]
    emitProgress(
      onProgress,
      `Preparing ${index + 1}/${documents.length}: ${documentRecord.title}`,
      (index / documents.length) * 90,
    )

    const folderSegments = getDocumentFolderSegments(documentRecord).map(sanitizePathSegment)
    const baseName = sanitizePathSegment(documentRecord.title || documentRecord.id)

    let relativePath = [...folderSegments, `${baseName}.pdf`].join('/')
    if (relativePath.length === 0) {
      relativePath = `${sanitizePathSegment(documentRecord.id)}.pdf`
    }

    if (usedPaths.has(relativePath)) {
      let duplicateIndex = 2
      while (usedPaths.has(relativePath)) {
        relativePath = [...folderSegments, `${baseName} (${duplicateIndex}).pdf`].join('/')
        duplicateIndex += 1
      }
    }

    usedPaths.add(relativePath)

    const fileBytes = hasAnnotations(documentRecord)
      ? await renderDocumentWithAnnotations(documentRecord)
      : new Uint8Array(await documentRecord.pdfBlob.arrayBuffer())

    zip.file(relativePath, fileBytes)

    emitProgress(
      onProgress,
      `Prepared ${index + 1}/${documents.length}: ${documentRecord.title}`,
      ((index + 1) / documents.length) * 90,
    )

    await new Promise<void>((resolve) => {
      window.setTimeout(() => resolve(), 0)
    })
  }

  emitProgress(onProgress, 'Packing ZIP archive...', 92)

  const zipBlob = await zip.generateAsync(
    {
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: ZIP_COMPRESSION_LEVEL },
    },
    (metadata) => {
      emitProgress(onProgress, 'Packing ZIP archive...', 92 + metadata.percent * 0.08)
    },
  )

  const fileName = createDownloadFileName()
  const url = URL.createObjectURL(zipBlob)
  const anchor = window.document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)

  emitProgress(onProgress, 'ZIP download started.', 100)
  return fileName
}
