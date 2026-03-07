import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useLibraryContext } from '../context/LibraryContext'
import { useWorkspaceStore } from '../hooks/useWorkspaceStore'
import { WorkspacePane } from '../components/workspace/WorkspacePane'
import type { DocumentRecord, WorkspacePaneState, WorkspaceTabState } from '../types'

const SPLIT_RATIO_STORAGE_KEY = 'flexcil-workspace-split-ratio'

function clampSearchIndex(index: number, total: number): number {
  if (total <= 0) {
    return 0
  }
  if (index < 0) {
    return 0
  }
  if (index >= total) {
    return total - 1
  }
  return index
}

export function WorkspacePage() {
  const location = useLocation()
  const { documents, findById } = useLibraryContext()
  const { state, actions, hasSplit, activePane } = useWorkspaceStore()
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const isResizingRef = useRef(false)
  const [resolvedDocumentsById, setResolvedDocumentsById] = useState<Record<string, DocumentRecord>>({})
  const [splitRatio, setSplitRatio] = useState(() => {
    const raw = localStorage.getItem(SPLIT_RATIO_STORAGE_KEY)
    const parsed = raw ? Number(raw) : 50
    if (!Number.isFinite(parsed)) {
      return 50
    }
    return Math.max(20, Math.min(80, parsed))
  })

  const documentMap = useMemo(() => {
    const map = new Map<string, (typeof documents)[number]>()
    for (const document of documents) {
      map.set(document.id, document)
    }
    return map
  }, [documents])

  useEffect(() => {
    const allOpenDocumentIds = Array.from(
      new Set(
        Object.values(state.tabsById)
          .map((tab) => tab.documentId)
          .filter((documentId) => typeof documentId === 'string' && documentId.length > 0),
      ),
    )

    const missingIds = allOpenDocumentIds.filter(
      (documentId) => !documentMap.has(documentId) && !resolvedDocumentsById[documentId],
    )

    if (missingIds.length === 0) {
      return
    }

    let cancelled = false

    const run = async () => {
      const resolvedEntries: Array<[string, DocumentRecord]> = []

      for (const documentId of missingIds) {
        try {
          const found = await findById(documentId)
          if (found) {
            resolvedEntries.push([documentId, found])
          }
        } catch {
        }
      }

      if (cancelled || resolvedEntries.length === 0) {
        return
      }

      setResolvedDocumentsById((previous) => {
        const next = { ...previous }
        for (const [documentId, record] of resolvedEntries) {
          next[documentId] = record
        }
        return next
      })
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [documentMap, findById, resolvedDocumentsById, state.tabsById])

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const documentId = params.get('doc')
    if (!documentId) {
      return
    }

    const document = documentMap.get(documentId)
    if (!document) {
      return
    }

    actions.openDocument(document.id, document.title)
  }, [actions, documentMap, location.search])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isMeta = event.ctrlKey || event.metaKey
      if (!isMeta) {
        return
      }

      if (event.key.toLowerCase() === 'w') {
        const pane = activePane
        if (!pane?.activeTabId) {
          return
        }
        event.preventDefault()
        actions.closeTab(pane.id, pane.activeTabId)
        return
      }

      if (event.key.toLowerCase() === 'f') {
        event.preventDefault()
        actions.setPaneSearchOpen(activePane.id, true)
        return
      }

      if (event.key === 'Tab') {
        const pane = activePane
        if (!pane || pane.tabIds.length < 2) {
          return
        }

        event.preventDefault()
        const currentIndex = pane.activeTabId ? pane.tabIds.indexOf(pane.activeTabId) : 0
        const direction = event.shiftKey ? -1 : 1
        const nextIndex = (currentIndex + direction + pane.tabIds.length) % pane.tabIds.length
        const nextTabId = pane.tabIds[nextIndex]
        if (nextTabId) {
          actions.focusTab(pane.id, nextTabId)
        }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [actions, activePane])

  useEffect(() => {
    localStorage.setItem(SPLIT_RATIO_STORAGE_KEY, String(splitRatio))
  }, [splitRatio])

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      if (!isResizingRef.current || !splitContainerRef.current) {
        return
      }

      const rect = splitContainerRef.current.getBoundingClientRect()
      if (rect.width <= 0) {
        return
      }

      const ratio = ((event.clientX - rect.left) / rect.width) * 100
      const clamped = Math.max(20, Math.min(80, ratio))
      setSplitRatio(clamped)
    }

    const onMouseUp = () => {
      if (!isResizingRef.current) {
        return
      }
      isResizingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)

    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  const panes = state.panes

  const getTabsForPane = (pane: WorkspacePaneState): WorkspaceTabState[] => {
    return pane.tabIds.map((tabId) => state.tabsById[tabId]).filter((tab): tab is WorkspaceTabState => Boolean(tab))
  }

  const renderPane = (pane: WorkspacePaneState) => {
    const tabs = getTabsForPane(pane)
    const activeTab = pane.activeTabId ? state.tabsById[pane.activeTabId] ?? null : null

    const updateSearchState = (patch: Partial<WorkspaceTabState['search']>) => {
      if (!activeTab) {
        return
      }
      actions.updateTabSearchState(activeTab.id, patch)
    }

    return (
      <WorkspacePane
        key={pane.id}
        pane={pane}
        tabs={tabs}
        activeTab={activeTab}
        isActivePane={state.activePaneId === pane.id}
        hasSplit={hasSplit}
        getDocumentById={(documentId) => documentMap.get(documentId) ?? resolvedDocumentsById[documentId]}
        onFocusPane={() => actions.focusPane(pane.id)}
        onSelectTab={(tabId) => actions.focusTab(pane.id, tabId)}
        onCloseTab={(tabId) => actions.closeTab(pane.id, tabId)}
        onCloseOtherTabs={(tabId) => actions.closeOtherTabs(pane.id, tabId)}
        onCloseAllTabs={() => actions.closeAllTabs(pane.id)}
        onSplitRight={() => actions.splitRightWithCurrentTab()}
        onCloseSplit={() => actions.closeSplit()}
        onMoveActiveTabToOtherPane={() => {
          if (!pane.activeTabId) {
            return
          }
          actions.moveTabToOtherPane(pane.id, pane.activeTabId)
        }}
        onBackToLibrary={
          pane.id === panes[0]?.id
            ? () => {
                window.location.assign('/')
              }
            : undefined
        }
        onToggleSearch={() => actions.setPaneSearchOpen(pane.id, !pane.isSearchOpen)}
        onSearchQueryChange={(query) => {
          updateSearchState({
            searchQuery: query,
            selectedMatchIndex: 0,
          })
        }}
        onSearchIndexChange={(index) => {
          if (!activeTab) {
            return
          }
          const safeIndex = clampSearchIndex(index, activeTab.search.searchResults.length)
          updateSearchState({ selectedMatchIndex: safeIndex })
        }}
        onSearchResultsChange={(results) => {
          const safeIndex = clampSearchIndex(activeTab?.search.selectedMatchIndex ?? 0, results.length)
          updateSearchState({
            searchResults: results,
            selectedMatchIndex: safeIndex,
          })
        }}
        onViewStateChange={(viewState) => {
          if (!activeTab) {
            return
          }
          actions.updateTabViewState(activeTab.id, viewState)
        }}
      />
    )
  }

  return (
    <div ref={splitContainerRef} className="flex h-screen min-h-0 flex-1 gap-2 bg-background p-2">
      {!hasSplit && <div className="min-h-0 min-w-0 flex-1 h-full">{panes[0] ? renderPane(panes[0]) : null}</div>}

      {hasSplit && panes[0] && panes[1] && (
        <>
          <div className="min-h-0 min-w-0 h-full" style={{ width: `${splitRatio}%` }}>
            {renderPane(panes[0])}
          </div>

          <div
            className="group relative w-2 shrink-0 cursor-col-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize split panes"
            onMouseDown={(event) => {
              event.preventDefault()
              isResizingRef.current = true
              document.body.style.cursor = 'col-resize'
              document.body.style.userSelect = 'none'
            }}
          >
            <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border group-hover:bg-accent" />
          </div>

          <div className="min-h-0 min-w-0 flex-1 h-full">{renderPane(panes[1])}</div>
        </>
      )}
    </div>
  )
}
