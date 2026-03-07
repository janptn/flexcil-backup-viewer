import { useCallback, useEffect, useMemo, useReducer } from 'react'
import type { PdfSearchHit, TabSearchState, TabViewState, WorkspacePaneState, WorkspaceState, WorkspaceTabState } from '../types'

const WORKSPACE_STORAGE_KEY = 'flexcil-workspace-v1'
const PRIMARY_PANE_ID = 'pane-primary'
const SECONDARY_PANE_ID = 'pane-secondary'

function createTabId(): string {
  const random = Math.random().toString(36).slice(2, 8)
  return `tab-${Date.now()}-${random}`
}

function createDefaultViewState(): TabViewState {
  return {
    currentPage: 1,
    zoomPercent: 100,
    scrollPosition: 0,
  }
}

function createDefaultSearchState(): TabSearchState {
  return {
    searchQuery: '',
    selectedMatchIndex: 0,
    searchResults: [],
  }
}

function createTab(documentId: string, title: string): WorkspaceTabState {
  return {
    id: createTabId(),
    documentId,
    title,
    view: createDefaultViewState(),
    search: createDefaultSearchState(),
  }
}

function createInitialWorkspaceState(): WorkspaceState {
  return {
    panes: [
      {
        id: PRIMARY_PANE_ID,
        activeTabId: null,
        tabIds: [],
        isSearchOpen: false,
      },
    ],
    tabsById: {},
    activePaneId: PRIMARY_PANE_ID,
  }
}

function getPaneById(state: WorkspaceState, paneId: string): WorkspacePaneState | undefined {
  return state.panes.find((pane) => pane.id === paneId)
}

function getPaneContainingTab(state: WorkspaceState, tabId: string): WorkspacePaneState | undefined {
  return state.panes.find((pane) => pane.tabIds.includes(tabId))
}

function withPaneUpdated(state: WorkspaceState, paneId: string, updater: (pane: WorkspacePaneState) => WorkspacePaneState): WorkspaceState {
  return {
    ...state,
    panes: state.panes.map((pane) => (pane.id === paneId ? updater(pane) : pane)),
  }
}

function removeTabFromPane(state: WorkspaceState, paneId: string, tabId: string): WorkspaceState {
  return withPaneUpdated(state, paneId, (pane) => {
    const nextTabIds = pane.tabIds.filter((value) => value !== tabId)
    const wasActive = pane.activeTabId === tabId
    const fallbackActive = wasActive ? nextTabIds[Math.max(0, nextTabIds.length - 1)] ?? null : pane.activeTabId

    return {
      ...pane,
      tabIds: nextTabIds,
      activeTabId: fallbackActive,
      isSearchOpen: fallbackActive ? pane.isSearchOpen : false,
    }
  })
}

type WorkspaceAction =
  | { type: 'openDocument'; documentId: string; title: string; paneId?: string; forceNewTab?: boolean }
  | { type: 'focusPane'; paneId: string }
  | { type: 'focusTab'; paneId: string; tabId: string }
  | { type: 'closeTab'; paneId: string; tabId: string }
  | { type: 'closeOtherTabs'; paneId: string; tabId: string }
  | { type: 'closeAllTabs'; paneId: string }
  | { type: 'splitRightWithCurrentTab' }
  | { type: 'moveTabToOtherPane'; paneId: string; tabId: string }
  | { type: 'closeSplit' }
  | { type: 'setPaneSearchOpen'; paneId: string; isOpen: boolean }
  | { type: 'updateTabViewState'; tabId: string; patch: Partial<TabViewState> }
  | { type: 'updateTabSearchState'; tabId: string; patch: Partial<TabSearchState> }
  | { type: 'hydrate'; state: WorkspaceState }

function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  if (action.type === 'hydrate') {
    return action.state
  }

  if (action.type === 'focusPane') {
    if (!getPaneById(state, action.paneId)) {
      return state
    }
    return {
      ...state,
      activePaneId: action.paneId,
    }
  }

  if (action.type === 'openDocument') {
    const targetPaneId = action.paneId ?? state.activePaneId
    const targetPane = getPaneById(state, targetPaneId)
    if (!targetPane) {
      return state
    }

    if (!action.forceNewTab) {
      for (const pane of state.panes) {
        const existingTabId = pane.tabIds.find((tabId) => state.tabsById[tabId]?.documentId === action.documentId)
        if (existingTabId) {
          return {
            ...state,
            panes: state.panes.map((value) =>
              value.id === pane.id
                ? {
                    ...value,
                    activeTabId: existingTabId,
                    isSearchOpen: value.isSearchOpen || (state.tabsById[existingTabId]?.search.searchQuery.trim().length ?? 0) > 0,
                  }
                : value,
            ),
            activePaneId: pane.id,
          }
        }
      }
    }

    const tab = createTab(action.documentId, action.title)
    return {
      ...state,
      activePaneId: targetPaneId,
      tabsById: {
        ...state.tabsById,
        [tab.id]: tab,
      },
      panes: state.panes.map((pane) =>
        pane.id === targetPaneId
          ? {
              ...pane,
              tabIds: [...pane.tabIds, tab.id],
              activeTabId: tab.id,
              isSearchOpen: false,
            }
          : pane,
      ),
    }
  }

  if (action.type === 'focusTab') {
    const pane = getPaneById(state, action.paneId)
    if (!pane || !pane.tabIds.includes(action.tabId)) {
      return state
    }

    return {
      ...state,
      activePaneId: action.paneId,
      panes: state.panes.map((value) =>
        value.id === action.paneId
          ? {
              ...value,
              activeTabId: action.tabId,
            }
          : value,
      ),
    }
  }

  if (action.type === 'closeTab') {
    const pane = getPaneById(state, action.paneId)
    if (!pane || !pane.tabIds.includes(action.tabId)) {
      return state
    }

    const nextState = removeTabFromPane(state, action.paneId, action.tabId)
    const nextTabsById = { ...nextState.tabsById }
    delete nextTabsById[action.tabId]

    return {
      ...nextState,
      tabsById: nextTabsById,
    }
  }

  if (action.type === 'closeOtherTabs') {
    const pane = getPaneById(state, action.paneId)
    if (!pane || !pane.tabIds.includes(action.tabId)) {
      return state
    }

    const keepSet = new Set([action.tabId])
    const nextTabsById = { ...state.tabsById }
    for (const tabId of pane.tabIds) {
      if (!keepSet.has(tabId)) {
        delete nextTabsById[tabId]
      }
    }

    return {
      ...state,
      tabsById: nextTabsById,
      panes: state.panes.map((value) =>
        value.id === action.paneId
          ? {
              ...value,
              tabIds: [action.tabId],
              activeTabId: action.tabId,
              isSearchOpen: state.tabsById[action.tabId]?.search.searchQuery.trim().length > 0,
            }
          : value,
      ),
    }
  }

  if (action.type === 'closeAllTabs') {
    const pane = getPaneById(state, action.paneId)
    if (!pane) {
      return state
    }

    const nextTabsById = { ...state.tabsById }
    for (const tabId of pane.tabIds) {
      delete nextTabsById[tabId]
    }

    return {
      ...state,
      tabsById: nextTabsById,
      panes: state.panes.map((value) =>
        value.id === action.paneId
          ? {
              ...value,
              tabIds: [],
              activeTabId: null,
              isSearchOpen: false,
            }
          : value,
      ),
    }
  }

  if (action.type === 'splitRightWithCurrentTab') {
    const currentPane = getPaneById(state, state.activePaneId)
    if (!currentPane?.activeTabId) {
      if (state.panes.length > 1) {
        return {
          ...state,
          activePaneId: SECONDARY_PANE_ID,
        }
      }

      return {
        ...state,
        panes: [
          ...state.panes,
          {
            id: SECONDARY_PANE_ID,
            activeTabId: null,
            tabIds: [],
            isSearchOpen: false,
          },
        ],
        activePaneId: SECONDARY_PANE_ID,
      }
    }

    const activeTab = state.tabsById[currentPane.activeTabId]
    if (!activeTab) {
      return state
    }

    const rightPane = getPaneById(state, SECONDARY_PANE_ID)
    const nextState = rightPane
      ? state
      : {
          ...state,
          panes: [
            ...state.panes,
            {
              id: SECONDARY_PANE_ID,
              activeTabId: null,
              tabIds: [],
              isSearchOpen: false,
            },
          ],
        }

    return workspaceReducer(nextState, {
      type: 'openDocument',
      paneId: SECONDARY_PANE_ID,
      documentId: activeTab.documentId,
      title: activeTab.title,
    })
  }

  if (action.type === 'moveTabToOtherPane') {
    const sourcePane = getPaneById(state, action.paneId)
    if (!sourcePane || !sourcePane.tabIds.includes(action.tabId)) {
      return state
    }

    const targetPaneId = action.paneId === PRIMARY_PANE_ID ? SECONDARY_PANE_ID : PRIMARY_PANE_ID
    const targetPaneExists = Boolean(getPaneById(state, targetPaneId))
    const targetState = targetPaneExists
      ? state
      : {
          ...state,
          panes: [
            ...state.panes,
            {
              id: targetPaneId,
              activeTabId: null,
              tabIds: [],
              isSearchOpen: false,
            },
          ],
        }

    const movedTab = targetState.tabsById[action.tabId]
    if (!movedTab) {
      return targetState
    }

    const withoutSource = removeTabFromPane(targetState, action.paneId, action.tabId)
    return {
      ...withoutSource,
      panes: withoutSource.panes.map((pane) =>
        pane.id === targetPaneId
          ? {
              ...pane,
              tabIds: [...pane.tabIds, action.tabId],
              activeTabId: action.tabId,
              isSearchOpen: pane.isSearchOpen || movedTab.search.searchQuery.trim().length > 0,
            }
          : pane,
      ),
      activePaneId: targetPaneId,
    }
  }

  if (action.type === 'closeSplit') {
    if (state.panes.length < 2) {
      return state
    }

    const primaryPane = getPaneById(state, PRIMARY_PANE_ID)
    const secondaryPane = getPaneById(state, SECONDARY_PANE_ID)
    if (!primaryPane || !secondaryPane) {
      return state
    }

    const mergedTabIds = [...primaryPane.tabIds]
    for (const tabId of secondaryPane.tabIds) {
      if (!mergedTabIds.includes(tabId)) {
        mergedTabIds.push(tabId)
      }
    }

    const nextActiveTabId =
      state.activePaneId === SECONDARY_PANE_ID
        ? secondaryPane.activeTabId ?? primaryPane.activeTabId
        : primaryPane.activeTabId ?? secondaryPane.activeTabId

    return {
      ...state,
      activePaneId: PRIMARY_PANE_ID,
      panes: [
        {
          ...primaryPane,
          tabIds: mergedTabIds,
          activeTabId: nextActiveTabId,
          isSearchOpen:
            primaryPane.isSearchOpen ||
            secondaryPane.isSearchOpen ||
            Boolean((nextActiveTabId && state.tabsById[nextActiveTabId]?.search.searchQuery.trim().length) ?? 0),
        },
      ],
    }
  }

  if (action.type === 'setPaneSearchOpen') {
    return withPaneUpdated(state, action.paneId, (pane) => ({
      ...pane,
      isSearchOpen: action.isOpen,
    }))
  }

  if (action.type === 'updateTabViewState') {
    const current = state.tabsById[action.tabId]
    if (!current) {
      return state
    }

    return {
      ...state,
      tabsById: {
        ...state.tabsById,
        [action.tabId]: {
          ...current,
          view: {
            ...current.view,
            ...action.patch,
          },
        },
      },
    }
  }

  if (action.type === 'updateTabSearchState') {
    const current = state.tabsById[action.tabId]
    if (!current) {
      return state
    }

    return {
      ...state,
      tabsById: {
        ...state.tabsById,
        [action.tabId]: {
          ...current,
          search: {
            ...current.search,
            ...action.patch,
          },
        },
      },
    }
  }

  return state
}

function sanitizePersistedState(input: unknown): WorkspaceState {
  if (!input || typeof input !== 'object') {
    return createInitialWorkspaceState()
  }

  const maybe = input as WorkspaceState
  if (!Array.isArray(maybe.panes) || typeof maybe.tabsById !== 'object' || maybe.tabsById === null) {
    return createInitialWorkspaceState()
  }

  const panes = maybe.panes
    .map((pane) => {
      if (!pane || typeof pane !== 'object') {
        return null
      }
      const typedPane = pane as WorkspacePaneState
      const tabIds = Array.isArray(typedPane.tabIds) ? typedPane.tabIds.filter((tabId) => typeof tabId === 'string') : []

      return {
        id: typeof typedPane.id === 'string' ? typedPane.id : createTabId(),
        activeTabId:
          typeof typedPane.activeTabId === 'string' && tabIds.includes(typedPane.activeTabId)
            ? typedPane.activeTabId
            : tabIds[0] ?? null,
        tabIds,
        isSearchOpen: Boolean(typedPane.isSearchOpen),
      } as WorkspacePaneState
    })
    .filter((pane): pane is WorkspacePaneState => pane !== null)

  const tabsById: Record<string, WorkspaceTabState> = {}
  for (const [tabId, tab] of Object.entries(maybe.tabsById)) {
    if (!tab || typeof tab !== 'object') {
      continue
    }

    const typed = tab as WorkspaceTabState
    if (typeof typed.documentId !== 'string' || typed.documentId.length === 0) {
      continue
    }

    tabsById[tabId] = {
      id: tabId,
      documentId: typed.documentId,
      title: typeof typed.title === 'string' && typed.title.length > 0 ? typed.title : typed.documentId,
      view: {
        currentPage: Number.isFinite(typed.view?.currentPage) ? typed.view.currentPage : 1,
        zoomPercent: Number.isFinite(typed.view?.zoomPercent) ? typed.view.zoomPercent : 100,
        scrollPosition: Number.isFinite(typed.view?.scrollPosition) ? typed.view.scrollPosition : 0,
      },
      search: {
        searchQuery: typeof typed.search?.searchQuery === 'string' ? typed.search.searchQuery : '',
        selectedMatchIndex: Number.isFinite(typed.search?.selectedMatchIndex)
          ? typed.search.selectedMatchIndex
          : 0,
        searchResults: Array.isArray(typed.search?.searchResults)
          ? (typed.search.searchResults as PdfSearchHit[]).filter(
              (hit) =>
                typeof hit?.id === 'string' &&
                Number.isFinite(hit?.pageNumber) &&
                typeof hit?.snippet === 'string',
            )
          : [],
      },
    }
  }

  const filteredPanes = panes.reduce<WorkspacePaneState[]>((result, pane) => {
    if (pane.id !== PRIMARY_PANE_ID && pane.id !== SECONDARY_PANE_ID) {
      return result
    }

    const tabIds = pane.tabIds.filter((tabId) => Boolean(tabsById[tabId]))
    const activeTabId = pane.activeTabId && tabIds.includes(pane.activeTabId) ? pane.activeTabId : tabIds[0] ?? null

    result.push({
      ...pane,
      tabIds,
      activeTabId,
    })

    return result
  }, [])

  if (filteredPanes.length === 0) {
    return createInitialWorkspaceState()
  }

  const activePaneId =
    typeof maybe.activePaneId === 'string' && filteredPanes.some((pane) => pane.id === maybe.activePaneId)
      ? maybe.activePaneId
      : filteredPanes[0].id

  return {
    panes: filteredPanes,
    tabsById,
    activePaneId,
  }
}

export function useWorkspaceStore() {
  const [state, dispatch] = useReducer(
    workspaceReducer,
    undefined,
    () => {
      try {
        const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY)
        return raw ? sanitizePersistedState(JSON.parse(raw)) : createInitialWorkspaceState()
      } catch {
        return createInitialWorkspaceState()
      }
    },
  )

  useEffect(() => {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(state))
  }, [state])

  const actions = useMemo(
    () => ({
      openDocument: (documentId: string, title: string, paneId?: string) =>
        dispatch({ type: 'openDocument', documentId, title, paneId }),
      openDocumentInNewTab: (documentId: string, title: string, paneId?: string) =>
        dispatch({ type: 'openDocument', documentId, title, paneId, forceNewTab: true }),
      splitRightWithCurrentTab: () => dispatch({ type: 'splitRightWithCurrentTab' }),
      moveTabToOtherPane: (paneId: string, tabId: string) => dispatch({ type: 'moveTabToOtherPane', paneId, tabId }),
      closeSplit: () => dispatch({ type: 'closeSplit' }),
      closeTab: (paneId: string, tabId: string) => dispatch({ type: 'closeTab', paneId, tabId }),
      closeOtherTabs: (paneId: string, tabId: string) => dispatch({ type: 'closeOtherTabs', paneId, tabId }),
      closeAllTabs: (paneId: string) => dispatch({ type: 'closeAllTabs', paneId }),
      focusTab: (paneId: string, tabId: string) => dispatch({ type: 'focusTab', paneId, tabId }),
      focusPane: (paneId: string) => dispatch({ type: 'focusPane', paneId }),
      setPaneSearchOpen: (paneId: string, isOpen: boolean) => dispatch({ type: 'setPaneSearchOpen', paneId, isOpen }),
      updateTabViewState: (tabId: string, patch: Partial<TabViewState>) =>
        dispatch({ type: 'updateTabViewState', tabId, patch }),
      updateTabSearchState: (tabId: string, patch: Partial<TabSearchState>) =>
        dispatch({ type: 'updateTabSearchState', tabId, patch }),
    }),
    [],
  )

  const derived = useMemo(() => {
    const activePane = state.panes.find((pane) => pane.id === state.activePaneId) ?? state.panes[0]
    return {
      activePane,
      hasSplit: state.panes.length > 1,
    }
  }, [state.activePaneId, state.panes])

  const getPaneContainingTabId = useCallback(
    (tabId: string): string | undefined => getPaneContainingTab(state, tabId)?.id,
    [state],
  )

  return {
    state,
    actions,
    ...derived,
    getPaneContainingTabId,
    primaryPaneId: PRIMARY_PANE_ID,
    secondaryPaneId: SECONDARY_PANE_ID,
  }
}
