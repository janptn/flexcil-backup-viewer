import { LoaderCircle } from 'lucide-react'

interface ImportProgressPopupProps {
  active: boolean
  stage: string
  percent: number
}

export function ImportProgressPopup({ active, stage, percent }: ImportProgressPopupProps) {
  if (!active) {
    return null
  }

  return (
    <div className="fixed bottom-6 left-1/2 z-50 w-[min(92vw,420px)] -translate-x-1/2 rounded-2xl border border-border bg-card p-4 shadow-xl">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <LoaderCircle className="size-4 animate-spin text-accent" />
        <span>Import in progress…</span>
      </div>

      <p className="mb-3 text-sm text-muted-foreground">{stage}</p>

      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-accent transition-all duration-300"
          style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
        />
      </div>

      <p className="mt-2 text-right text-xs text-muted-foreground">{Math.round(percent)}%</p>
    </div>
  )
}
