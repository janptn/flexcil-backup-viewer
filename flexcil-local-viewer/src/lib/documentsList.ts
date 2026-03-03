import { inflate, inflateRaw } from 'pako'

export interface DocumentsListMapping {
  documentId: string
  folderPath: string[]
  title?: string
}

interface ListNode {
  name?: unknown
  document?: unknown
  children?: unknown
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function decodeCompressedList(file: File): Promise<unknown> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.byteLength <= 8) {
    return []
  }

  const compressed = bytes.slice(8)
  let decodedText = ''

  try {
    decodedText = new TextDecoder().decode(inflate(compressed))
  } catch {
    decodedText = new TextDecoder().decode(inflateRaw(compressed))
  }

  try {
    return JSON.parse(decodedText)
  } catch {
    return []
  }
}

function walkNodes(
  nodes: unknown,
  currentPath: string[],
  output: Map<string, DocumentsListMapping>,
) {
  if (!Array.isArray(nodes)) {
    return
  }

  for (const rawNode of nodes) {
    if (!isObject(rawNode)) {
      continue
    }

    const node = rawNode as ListNode
    const nodeName = typeof node.name === 'string' ? node.name.trim() : ''
    const nextPath = nodeName.length > 0 ? [...currentPath, nodeName] : currentPath

    if (typeof node.document === 'string' && node.document.trim().length > 0) {
      const documentId = node.document.trim().toUpperCase()
      output.set(documentId, {
        documentId,
        folderPath: currentPath,
        title: nodeName || undefined,
      })
    }

    walkNodes(node.children, nextPath, output)
  }
}

export async function parseDocumentsListMappings(files: File[]): Promise<Map<string, DocumentsListMapping>> {
  const listFiles = files.filter((file) => file.name.toLowerCase().endsWith('documents.list'))
  const mappings = new Map<string, DocumentsListMapping>()

  for (const listFile of listFiles) {
    try {
      const decoded = await decodeCompressedList(listFile)
      walkNodes(decoded, [], mappings)
    } catch {
      continue
    }
  }

  return mappings
}
