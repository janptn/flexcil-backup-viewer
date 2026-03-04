import type { FlexcilInkPoint, FlexcilInkStroke } from '../types'

interface FlexcilStartPoint {
  x: number
  y: number
}

interface RawDrawingStroke {
  start?: FlexcilStartPoint
  points?: string
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
      if (variants.auto.length < 2) {
        continue
      }

      strokes.push({
        points: variants.auto,
        pointsAbsolute: variants.absolute,
        pointsCumulative: variants.cumulative,
        strokeStyle: argbToRgbaCss(typeof stroke.strokeColor === 'number' ? stroke.strokeColor : -16777216),
        lineWidth: computeLineWidth(stroke.scale),
        rotate: typeof stroke.rotate === 'number' ? stroke.rotate : undefined,
      })
    } catch {
      continue
    }
  }

  return strokes
}
