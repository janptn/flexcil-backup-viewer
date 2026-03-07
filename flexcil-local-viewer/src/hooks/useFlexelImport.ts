import { useCallback, useState } from 'react'
import JSZip from 'jszip'
import { applyDocumentsListMappings, saveDocumentRecords } from '../lib/db'
import { parseDocumentsListMappings } from '../lib/documentsList'
import { parseFlexelFiles } from '../lib/flexelImport'
import { extractPdfTextInfo } from '../lib/pdfText'
import type { ImportProgress, ImportSummary } from '../types'

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(message))
    }, timeoutMs)

    promise
      .then((value) => {
        window.clearTimeout(timer)
        resolve(value)
      })
      .catch((error) => {
        window.clearTimeout(timer)
        reject(error)
      })
  })
}

function isSupportedImportName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.flx') || lower.endsWith('.list')
}

async function expandImportFiles(files: File[]): Promise<File[]> {
  const expanded: File[] = []

  for (const file of files) {
    const lower = file.name.toLowerCase()
    if (lower.endsWith('.zip')) {
      const zip = await JSZip.loadAsync(await file.arrayBuffer())
      const entries = Object.values(zip.files).filter((entry) => !entry.dir && isSupportedImportName(entry.name))

      for (const entry of entries) {
        const blob = await entry.async('blob')
        const fallbackName = entry.name.split('/').pop() ?? entry.name
        const fileName = fallbackName.length > 0 ? fallbackName : entry.name
        expanded.push(new File([blob], fileName, { type: 'application/octet-stream' }))
      }
      continue
    }

    if (isSupportedImportName(file.name)) {
      expanded.push(file)
    }
  }

  return expanded
}

export function useFlexelImport(onImported: () => Promise<void>) {
  const [isImporting, setIsImporting] = useState(false)
  const [summary, setSummary] = useState<ImportSummary | null>(null)
  const [progress, setProgress] = useState<ImportProgress>({
    active: false,
    stage: 'Ready',
    percent: 0,
  })

  const importFiles = useCallback(
    async (files: FileList | File[]) => {
      const incoming = Array.from(files)
      if (incoming.length === 0) {
        const emptySummary = { added: 0, updated: 0, skipped: 0, failed: 0 }
        setSummary(emptySummary)
        return emptySummary
      }

      setIsImporting(true)
      setProgress({ active: true, stage: 'Validating files…', percent: 5 })
      try {
        setProgress({ active: true, stage: 'Extracting backup…', percent: 12 })
        const list = await withTimeout(
          expandImportFiles(incoming),
          30000,
          'Backup extraction took too long.',
        )

        if (list.length === 0) {
          const emptySummary = { added: 0, updated: 0, skipped: 0, failed: 0 }
          setSummary(emptySummary)
          setProgress({ active: true, stage: 'No importable files found', percent: 100 })
          return emptySummary
        }

        setProgress({ active: true, stage: 'Reading folder structure…', percent: 20 })
        const mappings = await withTimeout(
          parseDocumentsListMappings(list),
          15000,
          'Folder structure import took too long.',
        )

        setProgress({ active: true, stage: 'Extracting FLX documents…', percent: 45 })
        const records = await parseFlexelFiles(list, mappings)

        let indexedRecords = records
        if (records.length > 0) {
          const nextRecords = [...records]
          for (let index = 0; index < nextRecords.length; index += 1) {
            const record = nextRecords[index]
            const stagePercent = 50 + Math.round(((index + 1) / nextRecords.length) * 15)
            setProgress({
              active: true,
              stage: `Indexing full text… (${index + 1}/${nextRecords.length})`,
              percent: stagePercent,
            })

            try {
              const pdfTextInfo = await withTimeout(
                extractPdfTextInfo(record.pdfBlob),
                12000,
                'Full-text indexing took too long.',
              )
              nextRecords[index] = {
                ...record,
                fullText: pdfTextInfo.fullText,
                pageCount: pdfTextInfo.pageCount,
                createdAt: pdfTextInfo.createdAt ?? record.createdAt,
              }
            } catch {
              nextRecords[index] = {
                ...record,
                fullText: '',
                pageCount: record.pageCount,
              }
            }
          }

          indexedRecords = nextRecords
        }

        setProgress({ active: true, stage: 'Saving documents…', percent: 70 })
        const { added, updated, skipped } = await saveDocumentRecords(indexedRecords)

        setProgress({ active: true, stage: 'Applying folder mapping…', percent: 85 })
        const updatedFromMappings = await applyDocumentsListMappings(mappings)

        setProgress({ active: true, stage: 'Refreshing library…', percent: 95 })
        await onImported()

        const result = {
          added,
          updated: updated + updatedFromMappings,
          skipped,
          failed: 0,
        }

        setSummary(result)
        setProgress({ active: true, stage: 'Done', percent: 100 })
        return result
      } finally {
        setIsImporting(false)
        window.setTimeout(() => {
          setProgress({ active: false, stage: 'Ready', percent: 0 })
        }, 350)
      }
    },
    [onImported],
  )

  return {
    isImporting,
    summary,
    progress,
    importFiles,
  }
}
