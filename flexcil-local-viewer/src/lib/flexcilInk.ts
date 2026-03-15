import type { FlexcilInkPoint, FlexcilInkStroke } from '../types'

interface FlexcilStartPoint {
  x: number
  y: number
}

interface RawDrawingStroke {
  start?: FlexcilStartPoint
  points?: string
  figure?: number
  strokeColor?: number
  scale?: {
    x?: number
    y?: number
  }
  rotate?: number
  type?: number
  mode?: number
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

interface PointSample {
  dx: number
  dy: number
  pressure?: number
}

function parseSamplesWithCountHeader(bytes: Uint8Array): PointSample[] {
  if (bytes.byteLength < 16 || (bytes.byteLength - 4) % 12 !== 0) {
    return []
  }

  const expectedCount = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true)
  const tripletCount = (bytes.byteLength - 4) / 12

  if (expectedCount !== 0 && expectedCount !== tripletCount) {
    return []
  }

  const payload = bytes.subarray(4)
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const samples: PointSample[] = []

  for (let offset = 0; offset + 12 <= payload.byteLength; offset += 12) {
    const dxRaw = view.getFloat32(offset, true)
    const dyRaw = view.getFloat32(offset + 4, true)
    const pressureRaw = view.getFloat32(offset + 8, true)

    const dx = Number.isFinite(dxRaw) ? dxRaw : 0
    const dy = Number.isFinite(dyRaw) ? dyRaw : 0
    const pressure = Number.isFinite(pressureRaw) ? pressureRaw : undefined

    samples.push({ dx, dy, pressure })
  }

  return samples
}

function parseSamplesLegacy(bytes: Uint8Array): PointSample[] {
  if (bytes.byteLength <= 8) {
    return []
  }

  const payload = bytes.subarray(8)
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const samples: PointSample[] = []

  for (let offset = 0; offset + 12 <= payload.byteLength; offset += 12) {
    const dxRaw = view.getFloat32(offset, true)
    const dyRaw = view.getFloat32(offset + 4, true)
    const pressureRaw = view.getFloat32(offset + 8, true)

    const dx = Number.isFinite(dxRaw) ? dxRaw : 0
    const dy = Number.isFinite(dyRaw) ? dyRaw : 0
    const pressure = Number.isFinite(pressureRaw) ? pressureRaw : undefined

    samples.push({ dx, dy, pressure })
  }

  return samples
}

function extractPointSamples(bytes: Uint8Array): PointSample[] {
  const v2Samples = parseSamplesWithCountHeader(bytes)
  if (v2Samples.length > 0) {
    return v2Samples
  }

  return parseSamplesLegacy(bytes)
}

function clampLineWidth(value: number): number {
  if (!Number.isFinite(value)) {
    return 2
  }
  return Math.max(0.6, Math.min(value, 10))
}

function computeLineWidth(scale: RawDrawingStroke['scale']): number {
  const xScale = typeof scale?.x === 'number' ? scale.x : 1
  const yScale = typeof scale?.y === 'number' ? scale.y : xScale
  const average = (xScale + yScale) / 2
  return clampLineWidth(2 * average)
}

interface PressureStats {
  hasUsablePressure: boolean
  pressureLooksLikeWidthMetadata: boolean
}

function analyzeStrokePressure(points: FlexcilInkPoint[]): PressureStats {
  const rawPressures = points
    .map((point) => point.pressure)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))

  if (rawPressures.length < 2) {
    return {
      hasUsablePressure: false,
      pressureLooksLikeWidthMetadata: false,
    }
  }

  const minPressure = Math.min(...rawPressures)
  const maxPressure = Math.max(...rawPressures)
  const pressureLooksLikeWidthMetadata =
    maxPressure <= 0.02 && maxPressure - minPressure <= 0.0035

  return {
    hasUsablePressure: rawPressures.length >= 3 && !pressureLooksLikeWidthMetadata,
    pressureLooksLikeWidthMetadata,
  }
}

function splitPointIndicesByPressureLift(
  points: FlexcilInkPoint[],
  liftThreshold = 0.05,
): Array<{ startIndex: number; endIndex: number }> {
  const spans: Array<{ startIndex: number; endIndex: number }> = []
  let currentStart = -1

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]
    const isLiftPoint =
      typeof point.pressure === 'number' && Number.isFinite(point.pressure) && point.pressure <= liftThreshold

    if (isLiftPoint) {
      if (currentStart >= 0 && index - currentStart >= 2) {
        spans.push({ startIndex: currentStart, endIndex: index - 1 })
      }
      currentStart = -1
      continue
    }

    if (currentStart < 0) {
      currentStart = index
      continue
    }
  }

  if (currentStart >= 0 && points.length - currentStart >= 2) {
    spans.push({ startIndex: currentStart, endIndex: points.length - 1 })
  }

  return spans
}

function extractPointSpan(
  points: FlexcilInkPoint[],
  startIndex: number,
  endIndex: number,
): FlexcilInkPoint[] {
  if (startIndex < 0 || endIndex >= points.length || endIndex - startIndex + 1 < 2) {
    return []
  }

  return points.slice(startIndex, endIndex + 1)
}

function computeSegmentLengths(points: FlexcilInkPoint[]): number[] {
  const lengths: number[] = []
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]
    const current = points[index]
    lengths.push(Math.hypot(current.xNorm - previous.xNorm, current.yNorm - previous.yNorm))
  }
  return lengths
}

function median(values: number[]): number {
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

function dropTrailingDuplicatePoints(points: FlexcilInkPoint[]): FlexcilInkPoint[] {
  if (points.length < 2) {
    return points
  }

  let endIndex = points.length - 1
  while (endIndex > 0) {
    const current = points[endIndex]
    const previous = points[endIndex - 1]
    const step = Math.hypot(current.xNorm - previous.xNorm, current.yNorm - previous.yNorm)
    if (step > 0.0000001) {
      break
    }
    endIndex -= 1
  }

  return points.slice(0, endIndex + 1)
}

function shouldTrimLeadingOutlier(points: FlexcilInkPoint[]): boolean {
  if (points.length < 8) {
    return false
  }

  const segmentLengths = computeSegmentLengths(points)
  if (segmentLengths.length < 4) {
    return false
  }

  const first = segmentLengths[0]
  const remainder = segmentLengths.slice(1)
  const baseline = median(remainder)
  const maxRemainder = Math.max(...remainder)

  if (first <= 0.0022) {
    return false
  }

  const ratioToMedian = baseline > 0 ? first / baseline : Infinity
  const ratioToMaxRemainder = maxRemainder > 0 ? first / maxRemainder : Infinity

  return ratioToMedian >= 4.5 && ratioToMaxRemainder >= 1.45
}

function normalizeFreehandPoints(points: FlexcilInkPoint[]): { points: FlexcilInkPoint[]; trimmedLeading: boolean } {
  const withoutTrailingDuplicates = dropTrailingDuplicatePoints(points)
  if (withoutTrailingDuplicates.length < 2) {
    return { points: withoutTrailingDuplicates, trimmedLeading: false }
  }

  if (shouldTrimLeadingOutlier(withoutTrailingDuplicates)) {
    return {
      points: withoutTrailingDuplicates.slice(1),
      trimmedLeading: true,
    }
  }

  return {
    points: withoutTrailingDuplicates,
    trimmedLeading: false,
  }
}

export function decodeFlexcilPoints(base64: string, start: FlexcilStartPoint): FlexcilInkPoint[] {
  const safeStartX = Number.isFinite(start.x) ? start.x : 0
  const safeStartY = Number.isFinite(start.y) ? start.y : 0

  if (!base64 || base64.trim().length === 0) {
    return [{ xNorm: safeStartX, yNorm: safeStartY }]
  }

  const bytes = base64ToBytes(base64)
  if (bytes.byteLength <= 8) {
    return [{ xNorm: safeStartX, yNorm: safeStartY }]
  }

  const samples = extractPointSamples(bytes)

  if (samples.length === 0) {
    return [{ xNorm: safeStartX, yNorm: safeStartY }]
  }

  const absolutePoints: FlexcilInkPoint[] = [{ xNorm: safeStartX, yNorm: safeStartY }]
  const cumulativePoints: FlexcilInkPoint[] = [{ xNorm: safeStartX, yNorm: safeStartY }]

  let cumulativeX = safeStartX
  let cumulativeY = safeStartY

  for (const sample of samples) {
    const dx = sample.dx
    const dy = sample.dy
    const pressure = sample.pressure

    absolutePoints.push({
      xNorm: safeStartX + dx,
      yNorm: safeStartY + dy,
      pressure,
    })

    cumulativeX += dx
    cumulativeY += dy
    cumulativePoints.push({
      xNorm: cumulativeX,
      yNorm: cumulativeY,
      pressure,
    })
  }

  const hasOutOfBoundsCumulative = cumulativePoints.some(
    (point) => point.xNorm < -0.2 || point.xNorm > 1.2 || point.yNorm < -0.2 || point.yNorm > 1.2,
  )

  return hasOutOfBoundsCumulative ? absolutePoints : cumulativePoints
}

export function decodeFlexcilPointVariants(
  base64: string,
  start: FlexcilStartPoint,
): {
  auto: FlexcilInkPoint[]
  absolute: FlexcilInkPoint[]
  cumulative: FlexcilInkPoint[]
} {
  const safeStartX = Number.isFinite(start.x) ? start.x : 0
  const safeStartY = Number.isFinite(start.y) ? start.y : 0

  if (!base64 || base64.trim().length === 0) {
    const fallback = [{ xNorm: safeStartX, yNorm: safeStartY }]
    return {
      auto: fallback,
      absolute: fallback,
      cumulative: fallback,
    }
  }

  const bytes = base64ToBytes(base64)
  if (bytes.byteLength <= 8) {
    const fallback = [{ xNorm: safeStartX, yNorm: safeStartY }]
    return {
      auto: fallback,
      absolute: fallback,
      cumulative: fallback,
    }
  }

  const samples = extractPointSamples(bytes)

  if (samples.length === 0) {
    const fallback = [{ xNorm: safeStartX, yNorm: safeStartY }]
    return {
      auto: fallback,
      absolute: fallback,
      cumulative: fallback,
    }
  }

  const absolutePoints: FlexcilInkPoint[] = [{ xNorm: safeStartX, yNorm: safeStartY }]
  const cumulativePoints: FlexcilInkPoint[] = [{ xNorm: safeStartX, yNorm: safeStartY }]

  let cumulativeX = safeStartX
  let cumulativeY = safeStartY

  for (const sample of samples) {
    const dx = sample.dx
    const dy = sample.dy
    const pressure = sample.pressure

    absolutePoints.push({
      xNorm: safeStartX + dx,
      yNorm: safeStartY + dy,
      pressure,
    })

    cumulativeX += dx
    cumulativeY += dy
    cumulativePoints.push({
      xNorm: cumulativeX,
      yNorm: cumulativeY,
      pressure,
    })
  }

  const hasOutOfBoundsCumulative = cumulativePoints.some(
    (point) => point.xNorm < -0.2 || point.xNorm > 1.2 || point.yNorm < -0.2 || point.yNorm > 1.2,
  )

  return {
    auto: hasOutOfBoundsCumulative ? absolutePoints : cumulativePoints,
    absolute: absolutePoints,
    cumulative: cumulativePoints,
  }
}

export function argbToRgbaCss(argb: number): string {
  const value = argb >>> 0
  const a = ((value >> 24) & 0xff) / 255
  const r = (value >> 16) & 0xff
  const g = (value >> 8) & 0xff
  const b = value & 0xff
  return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`
}

export function parseFlexcilDrawings(raw: unknown): FlexcilInkStroke[] {
  if (!Array.isArray(raw)) {
    return []
  }

  const strokes: FlexcilInkStroke[] = []

  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue
    }

    const stroke = item as RawDrawingStroke
    if (stroke.type !== 1) {
      continue
    }

    const start = stroke.start
    const encodedPoints = stroke.points

    if (!start || typeof start.x !== 'number' || typeof start.y !== 'number' || typeof encodedPoints !== 'string') {
      continue
    }

    try {
      const variants = decodeFlexcilPointVariants(encodedPoints, start)
      const figure = typeof stroke.figure === 'number' ? stroke.figure : undefined
      const mode = typeof stroke.mode === 'number' ? stroke.mode : undefined
      const isGeneratedFigure = figure === 1 || mode === 1

      const preferredPointsRaw = mode === 5 || mode === 1 ? variants.absolute : variants.auto
      const normalizeFreehand = mode === 1 && !isGeneratedFigure
      const normalizedPreferred = normalizeFreehand
        ? normalizeFreehandPoints(preferredPointsRaw)
        : { points: preferredPointsRaw, trimmedLeading: false }
      const preferredPoints = normalizedPreferred.points

      if (preferredPoints.length < 2) {
        continue
      }

      const variantsAbsolute = normalizeFreehand
        ? (() => {
            const absoluteNoDuplicates = dropTrailingDuplicatePoints(variants.absolute)
            return normalizedPreferred.trimmedLeading ? absoluteNoDuplicates.slice(1) : absoluteNoDuplicates
          })()
        : variants.absolute

      const variantsCumulative = normalizeFreehand
        ? (() => {
            const cumulativeNoDuplicates = dropTrailingDuplicatePoints(variants.cumulative)
            return normalizedPreferred.trimmedLeading ? cumulativeNoDuplicates.slice(1) : cumulativeNoDuplicates
          })()
        : variants.cumulative

      const pressureStats = analyzeStrokePressure(preferredPoints)
      const shouldSplitByLift = !isGeneratedFigure && pressureStats.hasUsablePressure
      const splitSpans = shouldSplitByLift
        ? splitPointIndicesByPressureLift(preferredPoints)
        : [{ startIndex: 0, endIndex: preferredPoints.length - 1 }]

      for (const span of splitSpans) {
        const points = extractPointSpan(preferredPoints, span.startIndex, span.endIndex)
        if (points.length < 2) {
          continue
        }

        const pointsAbsolute = extractPointSpan(variantsAbsolute, span.startIndex, span.endIndex)
        const pointsCumulative = extractPointSpan(variantsCumulative, span.startIndex, span.endIndex)

        strokes.push({
          points,
          pointsAbsolute: pointsAbsolute.length >= 2 ? pointsAbsolute : points,
          pointsCumulative: pointsCumulative.length >= 2 ? pointsCumulative : points,
          strokeStyle: argbToRgbaCss(typeof stroke.strokeColor === 'number' ? stroke.strokeColor : -16777216),
          lineWidth: computeLineWidth(stroke.scale),
          rotate: typeof stroke.rotate === 'number' ? stroke.rotate : undefined,
          sourceFigure: figure,
          sourceMode: mode,
          isGeneratedFigure,
        })
      }
    } catch {
      continue
    }
  }

  return strokes
}
