import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react'

interface PaneSearchBarProps {
  query: string
  resultCount: number
  selectedIndex: number
  onQueryChange: (value: string) => void
  onPrev: () => void
  onNext: () => void
  onClose: () => void
}

export function PaneSearchBar({
  query,
  resultCount,
  selectedIndex,
  onQueryChange,
  onPrev,
  onNext,
  onClose,
}: PaneSearchBarProps) {
  const safeResultCount = Math.max(0, resultCount)
  const label =
    safeResultCount === 0
      ? '0'
      : `${Math.min(selectedIndex + 1, safeResultCount)} / ${safeResultCount}`

  return (
    <div className="flex items-center gap-2 border-b border-border bg-card/90 px-3 py-2">
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search in pane…"
          className="h-9 w-full rounded-md border border-border bg-background pl-8 pr-3 text-sm"
          autoFocus
        />
      </div>

      <span className="w-16 text-center text-xs text-muted-foreground">{label}</span>

      <button
        type="button"
        className="inline-flex size-8 items-center justify-center rounded-md border border-border hover:bg-muted"
        onClick={onPrev}
        disabled={safeResultCount === 0}
        title="Previous match"
      >
        <ChevronLeft className="size-4" />
      </button>
      <button
        type="button"
        className="inline-flex size-8 items-center justify-center rounded-md border border-border hover:bg-muted"
        onClick={onNext}
        disabled={safeResultCount === 0}
        title="Next match"
      >
        <ChevronRight className="size-4" />
      </button>

      <button
        type="button"
        className="inline-flex size-8 items-center justify-center rounded-md border border-border hover:bg-muted"
        onClick={onClose}
        title="Close search"
      >
        <X className="size-4" />
      </button>
    </div>
  )
}
