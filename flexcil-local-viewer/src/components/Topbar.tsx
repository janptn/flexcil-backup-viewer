import { Moon, Search, Sun } from 'lucide-react'
import { useState } from 'react'

interface TopbarProps {
  query: string
  onQueryChange: (next: string) => void
  onBackupSelect: () => void
  onBackupDrop: (files: FileList | File[]) => void
  onToggleTheme: () => void
  isDarkMode: boolean
  isImporting: boolean
}

export function Topbar({
  query,
  onQueryChange,
  onBackupSelect,
  onBackupDrop,
  onToggleTheme,
  isDarkMode,
  isImporting,
}: TopbarProps) {
  const [isBackupDragActive, setIsBackupDragActive] = useState(false)

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-card/90 backdrop-blur">
      <div className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between md:px-6">
        <div className="relative w-full md:max-w-lg">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search documents..."
            className="h-10 w-full rounded-xl border border-border bg-background pl-9 pr-3 text-sm outline-none ring-accent/40 transition focus:ring-2"
          />
        </div>

        <div className="flex items-center gap-2">
          <div
            role="button"
            tabIndex={0}
            onClick={onBackupSelect}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onBackupSelect()
              }
            }}
            onDragEnter={(event) => {
              event.preventDefault()
              event.stopPropagation()
              if (!isImporting) {
                setIsBackupDragActive(true)
              }
            }}
            onDragOver={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onDragLeave={(event) => {
              event.preventDefault()
              event.stopPropagation()
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setIsBackupDragActive(false)
              }
            }}
            onDrop={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setIsBackupDragActive(false)
              if (!isImporting) {
                onBackupDrop(event.dataTransfer.files)
              }
            }}
            className={`inline-flex h-10 cursor-pointer items-center rounded-xl border border-dashed px-3 text-xs transition ${
              isBackupDragActive ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-background text-muted-foreground hover:bg-muted'
            }`}
          >
            Drop ZIP/FLX/LIST (or folder) here
          </div>

          <button
            type="button"
            onClick={onToggleTheme}
            className="inline-flex size-10 items-center justify-center rounded-xl border border-border bg-background transition hover:bg-muted"
            aria-label="Toggle dark mode"
          >
            {isDarkMode ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
        </div>
      </div>
    </header>
  )
}
