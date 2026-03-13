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
  sourceFigure?: number
  sourceMode?: number
  isGeneratedFigure?: boolean
}

export interface FlexcilImageCropBox {
  xNorm: number
  yNorm: number
  widthNorm: number
  heightNorm: number
}

export interface FlexcilImageAnnotation {
  key: string
  xNorm: number
  yNorm: number
  widthNorm: number
  heightNorm: number
  rotate?: number
  cropBox?: FlexcilImageCropBox
  imageBlob: Blob
}

export interface FlexcilShapePoint {
  xNorm: number
  yNorm: number
}

export interface FlexcilShapeAnnotation {
  key: string
  shapeType: number
  points: FlexcilShapePoint[]
  controlPoints?: FlexcilShapePoint[]
  widthNorm?: number
  strokeStyle: string
  fillStyle?: string
  dashType: number
  lineWidth: number
  rotate?: number
  isClosed: boolean
}

export interface DocumentRecord {
  id: string
  title: string
  createdAt: number
  addedAt: number
  sourceFileName: string
  pageCount?: number
  pdfBlob: Blob
  pdfHash: string
  sizeBytes: number
  thumbnailBlob?: Blob
  meta?: UnknownMeta
  folderPath?: string[]
  fullText?: string
  inkPageKeys?: Record<string, string>
  inkDrawingsByPageKey?: Record<string, FlexcilInkStroke[]>
  imageAnnotationsByPageKey?: Record<string, FlexcilImageAnnotation[]>
  shapeAnnotationsByPageKey?: Record<string, FlexcilShapeAnnotation[]>
  parserVersion?: string
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

export interface PdfSearchHit {
  id: string
  pageNumber: number
  snippet: string
}

export interface TabViewState {
  currentPage: number
  zoomPercent: number
  scrollPosition: number
}

export interface TabSearchState {
  searchQuery: string
  selectedMatchIndex: number
  searchResults: PdfSearchHit[]
}

export interface WorkspaceTabState {
  id: string
  documentId: string
  title: string
  view: TabViewState
  search: TabSearchState
}

export interface WorkspacePaneState {
  id: string
  activeTabId: string | null
  tabIds: string[]
  isSearchOpen: boolean
}

export interface WorkspaceState {
  panes: WorkspacePaneState[]
  tabsById: Record<string, WorkspaceTabState>
  activePaneId: string
}
