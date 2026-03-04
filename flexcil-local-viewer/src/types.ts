export type UnknownMeta = Record<string, unknown>

export interface FlexcilInkPoint {
  xNorm: number
  yNorm: number
  pressure?: number
}

export interface FlexcilInkStroke {
  points: FlexcilInkPoint[]
  pointsAbsolute?: FlexcilInkPoint[]
  pointsCumulative?: FlexcilInkPoint[]
  strokeStyle: string
  lineWidth: number
  rotate?: number
}

export interface DocumentRecord {
  id: string
  title: string
  createdAt: number
  addedAt: number
  sourceFileName: string
  pdfBlob: Blob
  pdfHash: string
  sizeBytes: number
  thumbnailBlob?: Blob
  meta?: UnknownMeta
  folderPath?: string[]
  fullText?: string
  inkPageKeys?: Record<string, string>
  inkDrawingsByPageKey?: Record<string, FlexcilInkStroke[]>
}

export type CollectionFilter =
  | { type: 'all' }
  | { type: 'recent' }
  | { type: 'source'; value: string }
  | { type: 'folder'; value: string }

export interface ImportSummary {
  added: number
  updated: number
  skipped: number
  failed: number
}

export interface ImportProgress {
  active: boolean
  stage: string
  percent: number
}
