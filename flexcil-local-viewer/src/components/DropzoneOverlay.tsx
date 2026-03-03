import { UploadCloud } from 'lucide-react'

export function DropzoneOverlay({ active }: { active: boolean }) {
  if (!active) {
    return null
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-accent/10">
      <div className="rounded-xl bg-card px-6 py-4 shadow-lg">
        <div className="flex items-center gap-3 text-sm font-medium">
          <UploadCloud className="size-5 text-accent" />
          <span>Drop .flx files to import</span>
        </div>
      </div>
    </div>
  )
}
