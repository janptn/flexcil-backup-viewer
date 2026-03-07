import { ArrowLeft, SplitSquareHorizontal, Search, X, MoreHorizontal, PanelRightClose, MoveRight } from 'lucide-react'
import type { WorkspacePaneState, WorkspaceTabState } from '../../types'

interface WorkspaceTabBarProps {
  pane: WorkspacePaneState
  tabs: WorkspaceTabState[]
  isActivePane: boolean
  canSplit: boolean
  onFocusPane: () => void
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onCloseOtherTabs: (tabId: string) => void
  onCloseAllTabs: () => void
  onToggleSearch: () => void
  onSplitRight: () => void
  onCloseSplit: () => void
  onMoveActiveTabToOtherPane: () => void
  onBackToLibrary?: () => void
}

export function WorkspaceTabBar({
  pane,
  tabs,
  isActivePane,
  canSplit,
  onFocusPane,
  onSelectTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseAllTabs,
  onToggleSearch,
  onSplitRight,
  onCloseSplit,
  onMoveActiveTabToOtherPane,
  onBackToLibrary,
}: WorkspaceTabBarProps) {
  return (
    <div
      className={`flex items-center border-b border-border px-2 py-1.5 ${isActivePane ? 'bg-card' : 'bg-card/70'}`}
      onMouseDown={onFocusPane}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.length === 0 ? (
          <div className="px-3 py-1.5 text-xs text-muted-foreground">No tab open</div>
        ) : (
          tabs.map((tab) => {
            const active = tab.id === pane.activeTabId
            return (
              <div
                key={tab.id}
                className={`group flex max-w-[240px] shrink-0 items-center gap-1 rounded-t-md border px-2 py-1 text-sm transition ${
                  active
                    ? 'border-border bg-background text-foreground shadow-sm'
                    : 'border-transparent bg-muted/60 text-muted-foreground hover:bg-muted'
                }`}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left"
                  onClick={() => onSelectTab(tab.id)}
                  title={tab.title}
                >
                  {tab.title}
                </button>
                <button
                  type="button"
                  className="inline-flex size-5 items-center justify-center rounded hover:bg-muted"
                  onClick={() => onCloseTab(tab.id)}
                  title="Close tab"
                >
                  <X className="size-3.5" />
                </button>
                <div className="relative">
                  <button
                    type="button"
                    className="inline-flex size-5 items-center justify-center rounded opacity-0 transition group-hover:opacity-100 hover:bg-muted"
                    onClick={() => onCloseOtherTabs(tab.id)}
                    title="Close others"
                  >
                    <MoreHorizontal className="size-3.5" />
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>

      <div className="ml-2 flex shrink-0 items-center gap-1">
        {onBackToLibrary && (
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-muted"
            onClick={onBackToLibrary}
            title="Back to library"
          >
            <ArrowLeft className="size-3.5" />
            Library
          </button>
        )}

        <button
          type="button"
          className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-muted"
          onClick={onToggleSearch}
          title="Toggle pane search"
        >
          <Search className="size-3.5" />
          Search
        </button>

        <button
          type="button"
          className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-muted"
          onClick={onMoveActiveTabToOtherPane}
          title="Move active tab"
          disabled={!pane.activeTabId}
        >
          <MoveRight className="size-3.5" />
          Move
        </button>

        {canSplit ? (
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-muted"
            onClick={onCloseSplit}
            title="Close split"
          >
            <PanelRightClose className="size-3.5" />
            Close Split
          </button>
        ) : (
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-muted"
            onClick={onSplitRight}
            title="Split right"
            disabled={!pane.activeTabId}
          >
            <SplitSquareHorizontal className="size-3.5" />
            Split Right
          </button>
        )}

        <button
          type="button"
          className="inline-flex h-8 items-center rounded-md border border-border px-2 text-xs hover:bg-muted"
          onClick={onCloseAllTabs}
          disabled={tabs.length === 0}
          title="Close all tabs"
        >
          Close All
        </button>
      </div>
    </div>
  )
}
