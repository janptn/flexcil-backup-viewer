import { useMemo } from 'react'
import { FileText } from 'lucide-react'
import { PdfViewer } from '../PdfViewer'
import { PaneSearchBar } from './PaneSearchBar'
import { WorkspaceTabBar } from './WorkspaceTabBar'
import type { DocumentRecord, WorkspacePaneState, WorkspaceTabState } from '../../types'

interface WorkspacePaneProps {
  pane: WorkspacePaneState
  tabs: WorkspaceTabState[]
  activeTab: WorkspaceTabState | null
  isActivePane: boolean
  hasSplit: boolean
  getDocumentById: (documentId: string) => DocumentRecord | undefined
  onFocusPane: () => void
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onCloseOtherTabs: (tabId: string) => void
  onCloseAllTabs: () => void
  onSplitRight: () => void
  onCloseSplit: () => void
  onMoveActiveTabToOtherPane: () => void
  onBackToLibrary?: () => void
  onToggleSearch: () => void
  onSearchQueryChange: (query: string) => void
  onSearchIndexChange: (index: number) => void
  onSearchResultsChange: (results: WorkspaceTabState['search']['searchResults']) => void
  onViewStateChange: (state: WorkspaceTabState['view']) => void
}

export function WorkspacePane({
  pane,
  tabs,
  activeTab,
  isActivePane,
  hasSplit,
  getDocumentById,
  onFocusPane,
  onSelectTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseAllTabs,
  onSplitRight,
  onCloseSplit,
  onMoveActiveTabToOtherPane,
  onBackToLibrary,
  onToggleSearch,
  onSearchQueryChange,
  onSearchIndexChange,
  onSearchResultsChange,
  onViewStateChange,
}: WorkspacePaneProps) {
  const activeDocument = activeTab ? getDocumentById(activeTab.documentId) : undefined

  const searchResultCount = activeTab?.search.searchResults.length ?? 0
  const selectedMatchIndex = activeTab?.search.selectedMatchIndex ?? 0

  const canNavigateResults = searchResultCount > 0

  const onNextMatch = () => {
    if (!activeTab || !canNavigateResults) {
      return
    }
    onSearchIndexChange((selectedMatchIndex + 1) % searchResultCount)
  }

  const onPrevMatch = () => {
    if (!activeTab || !canNavigateResults) {
      return
    }
    const nextIndex = selectedMatchIndex - 1 < 0 ? searchResultCount - 1 : selectedMatchIndex - 1
    onSearchIndexChange(nextIndex)
  }

  const content = useMemo(() => {
    if (!activeTab) {
      return (
        <div className="flex h-full items-center justify-center p-6">
          <div className="max-w-sm rounded-xl border border-dashed border-border bg-card/60 p-6 text-center">
            <FileText className="mx-auto mb-3 size-8 text-muted-foreground" />
            <p className="text-sm font-medium">No document open</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Open a document from the library or split the current workspace.
            </p>
          </div>
        </div>
      )
    }

    if (!activeDocument) {
      return (
        <div className="flex h-full items-center justify-center p-6">
          <div className="max-w-sm rounded-xl border border-border bg-card/70 p-6 text-center">
            <p className="text-sm font-medium">Document unavailable</p>
            <p className="mt-1 text-xs text-muted-foreground">
              This tab references a document that is not currently in the library.
            </p>
          </div>
        </div>
      )
    }

    return (
      <PdfViewer
        key={activeTab.id}
        document={activeDocument}
        showToolbar={true}
        showBackButton={false}
        showSearchInput={false}
        showSearchSidebar={false}
        viewportMode="fill"
        externalSearchQuery={activeTab.search.searchQuery}
        onExternalSearchQueryChange={onSearchQueryChange}
        externalSelectedMatchIndex={activeTab.search.selectedMatchIndex}
        onExternalSelectedMatchIndexChange={onSearchIndexChange}
        onSearchHitsChange={onSearchResultsChange}
        initialViewState={activeTab.view}
        onViewStateChange={onViewStateChange}
      />
    )
  }, [
    activeDocument,
    activeTab,
    onSearchIndexChange,
    onSearchQueryChange,
    onSearchResultsChange,
    onViewStateChange,
  ])

  return (
    <section
      className={`flex h-full min-h-0 flex-col border border-border ${isActivePane ? 'shadow-sm' : 'opacity-95'}`}
      onMouseDown={onFocusPane}
    >
      <WorkspaceTabBar
        pane={pane}
        tabs={tabs}
        isActivePane={isActivePane}
        canSplit={hasSplit}
        onFocusPane={onFocusPane}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onCloseOtherTabs={onCloseOtherTabs}
        onCloseAllTabs={onCloseAllTabs}
        onToggleSearch={onToggleSearch}
        onSplitRight={onSplitRight}
        onCloseSplit={onCloseSplit}
        onMoveActiveTabToOtherPane={onMoveActiveTabToOtherPane}
        onBackToLibrary={onBackToLibrary}
      />

      {pane.isSearchOpen && activeTab && (
        <PaneSearchBar
          query={activeTab.search.searchQuery}
          resultCount={searchResultCount}
          selectedIndex={selectedMatchIndex}
          onQueryChange={onSearchQueryChange}
          onPrev={onPrevMatch}
          onNext={onNextMatch}
          onClose={onToggleSearch}
        />
      )}

      <div className="min-h-0 flex-1 bg-background">{content}</div>
    </section>
  )
}
