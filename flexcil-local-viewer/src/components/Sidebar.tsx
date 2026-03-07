import clsx from 'clsx'
import { ChevronDown, ChevronRight, History, Library } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { CollectionFilter } from '../types'

const SIDEBAR_EXPANDED_KEY = 'flexcil-library-expanded-folders-v1'

function loadExpandedFolders(): Set<string> {
  try {
    const raw = localStorage.getItem(SIDEBAR_EXPANDED_KEY)
    if (!raw) {
      return new Set()
    }

    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return new Set()
    }

    return new Set(parsed.filter((value) => typeof value === 'string'))
  } catch {
    return new Set()
  }
}

function saveExpandedFolders(values: Set<string>) {
  try {
    localStorage.setItem(SIDEBAR_EXPANDED_KEY, JSON.stringify(Array.from(values)))
  } catch {
  }
}

interface SidebarProps {
  selected: CollectionFilter
  onSelect: (next: CollectionFilter) => void
  folderGroups: string[]
}

interface FolderNode {
  name: string
  value: string
  children: FolderNode[]
}

function buildFolderTree(paths: string[]): FolderNode[] {
  const root: FolderNode[] = []

  for (const path of paths) {
    const segments = path.split('/').filter(Boolean)
    let level = root
    let currentPath = ''

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment
      let node = level.find((entry) => entry.name === segment)

      if (!node) {
        node = {
          name: segment,
          value: currentPath,
          children: [],
        }
        level.push(node)
      }

      level = node.children
    }
  }

  const sortTree = (nodes: FolderNode[]): FolderNode[] => {
    return nodes
      .map((node) => ({ ...node, children: sortTree(node.children) }))
      .sort((left, right) => left.name.localeCompare(right.name, 'de'))
  }

  return sortTree(root)
}

function FolderTreeItem({
  node,
  depth,
  selected,
  expanded,
  toggleExpanded,
  onSelect,
}: {
  node: FolderNode
  depth: number
  selected: CollectionFilter
  expanded: Set<string>
  toggleExpanded: (value: string) => void
  onSelect: (next: CollectionFilter) => void
}) {
  const hasChildren = node.children.length > 0
  const isExpanded = expanded.has(node.value)
  const isActive = selected.type === 'folder' && selected.value === node.value

  return (
    <div>
      <div className="flex items-center gap-1">
        {hasChildren ? (
          <button
            type="button"
            onClick={() => toggleExpanded(node.value)}
            className="inline-flex size-6 items-center justify-center rounded hover:bg-muted"
            style={{ marginLeft: `${depth * 12}px` }}
            aria-label={isExpanded ? 'Collapse folder' : 'Expand folder'}
          >
            {isExpanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
        ) : (
          <span style={{ marginLeft: `${depth * 12 + 24}px` }} />
        )}

        <button
          type="button"
          onClick={() => {
            if (hasChildren) {
              toggleExpanded(node.value)
            }
            onSelect({ type: 'folder', value: node.value })
          }}
          className={clsx(
            'flex min-h-8 flex-1 items-center rounded px-2 py-1 text-left text-sm transition',
            isActive ? 'bg-accent text-white' : 'hover:bg-muted',
          )}
        >
          {node.name}
        </button>
      </div>

      {hasChildren && isExpanded && (
        <div className="space-y-0.5">
          {node.children.map((child) => (
            <FolderTreeItem
              key={child.value}
              node={child}
              depth={depth + 1}
              selected={selected}
              expanded={expanded}
              toggleExpanded={toggleExpanded}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ItemButton({
  active,
  label,
  onClick,
  icon,
}: {
  active: boolean
  label: string
  onClick: () => void
  icon: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition',
        active ? 'bg-accent text-white' : 'text-foreground hover:bg-muted',
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  )
}

export function Sidebar({ selected, onSelect, folderGroups }: SidebarProps) {
  const folderTree = useMemo(() => buildFolderTree(folderGroups), [folderGroups])
  const [expanded, setExpanded] = useState<Set<string>>(() => loadExpandedFolders())

  const toggleExpanded = (value: string) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(value)) {
        next.delete(value)
      } else {
        next.add(value)
      }
      saveExpandedFolders(next)
      return next
    })
  }

  return (
    <aside className="w-full border-b border-border bg-card px-3 py-4 md:w-72 md:border-b-0 md:border-r md:px-4">
      <div className="space-y-4">
        <div className="space-y-1">
          <p className="px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Library</p>
          <ItemButton
            active={selected.type === 'all'}
            label="All documents"
            onClick={() => onSelect({ type: 'all' })}
            icon={<Library className="size-4" />}
          />
          <ItemButton
            active={selected.type === 'recent'}
            label="Recently added"
            onClick={() => onSelect({ type: 'recent' })}
            icon={<History className="size-4" />}
          />
        </div>

        {folderTree.length > 0 && (
          <div className="space-y-1">
            <p className="px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Collections
            </p>
            <div className="space-y-0.5">
              {folderTree.map((node) => (
                <FolderTreeItem
                  key={node.value}
                  node={node}
                  depth={0}
                  selected={selected}
                  expanded={expanded}
                  toggleExpanded={toggleExpanded}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </div>
        )}

        {folderTree.length === 0 && (
          <div className="px-3 text-xs text-muted-foreground">
            No folders found in imported metadata.
          </div>
        )}
      </div>
    </aside>
  )
}
