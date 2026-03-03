export type UnknownMeta = Record<string, unknown>

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
