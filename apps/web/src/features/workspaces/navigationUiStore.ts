import { create } from 'zustand'

export const DEFAULT_NAVIGATION_WIDTH = 264
export const COLLAPSED_NAVIGATION_WIDTH = 60
export const MIN_NAVIGATION_WIDTH = 192
export const MAX_NAVIGATION_WIDTH = 360

const COLLAPSED_STORAGE_KEY = 'graphql-navigation-collapsed'
const WIDTH_STORAGE_KEY = 'graphql-navigation-width'

type ExpandableWorkspaceSection = 'agents' | 'workflows'
type NavigationMotion = 'instant' | 'manual'

interface NavigationUiState {
  collapsed: boolean
  width: number
  /** Pointer preview; saved expanded widths retain their normal bounds. */
  resizeWidth: number | null
  motion: NavigationMotion
  activeWorkspaceId?: string
  workspacesExpanded: boolean
  expandedWorkspaceIds: Readonly<Record<string, boolean>>
  expandedSections: Readonly<Record<string, Partial<Record<ExpandableWorkspaceSection, boolean>>>>
  setCollapsed: (collapsed: boolean, motion?: NavigationMotion) => void
  setWidth: (width: number, motion?: NavigationMotion) => void
  setResizeWidth: (width: number) => void
  rememberWorkspace: (workspaceId: string) => void
  setWorkspacesExpanded: (expanded: boolean) => void
  setWorkspaceExpanded: (workspaceId: string, expanded: boolean) => void
  setSectionExpanded: (
    workspaceId: string,
    section: ExpandableWorkspaceSection,
    expanded: boolean,
  ) => void
  removeWorkspaceState: (workspaceId: string) => void
  reset: () => void
}

function getSessionStorage(): Storage | undefined {
  try {
    return globalThis.sessionStorage
  } catch {
    return undefined
  }
}

function writeSessionValue(key: string, value: string): void {
  try {
    getSessionStorage()?.setItem(key, value)
  } catch {
    // Navigation remains usable when browser storage is unavailable or full.
  }
}

function removeSessionValue(key: string): void {
  try {
    getSessionStorage()?.removeItem(key)
  } catch {
    // Resetting in-memory state is still sufficient for the current page.
  }
}

function readCollapsed(): boolean {
  return getSessionStorage()?.getItem(COLLAPSED_STORAGE_KEY) === 'true'
}

function clampWidth(width: number): number {
  return Math.min(MAX_NAVIGATION_WIDTH, Math.max(MIN_NAVIGATION_WIDTH, Math.round(width)))
}

function readWidth(): number {
  const stored = Number(getSessionStorage()?.getItem(WIDTH_STORAGE_KEY))
  return Number.isFinite(stored) && stored > 0 ? clampWidth(stored) : DEFAULT_NAVIGATION_WIDTH
}

function initialState() {
  return {
    collapsed: readCollapsed(),
    width: readWidth(),
    resizeWidth: null,
    motion: 'instant' as const,
    activeWorkspaceId: undefined,
    workspacesExpanded: true,
    expandedWorkspaceIds: {},
    expandedSections: {},
  }
}

/**
 * Local interaction state for the left navigation. Keeping this outside route
 * components prevents expansion, collapse, width, and workspace context from
 * resetting whenever the active page swaps one shell route for another.
 */
export const useNavigationUiStore = create<NavigationUiState>((set) => ({
  ...initialState(),
  setCollapsed: (collapsed, motion = 'instant') => {
    writeSessionValue(COLLAPSED_STORAGE_KEY, String(collapsed))
    set((state) => state.collapsed === collapsed && state.motion === motion && state.resizeWidth === null
      ? state : { collapsed, motion, resizeWidth: null })
  },
  setWidth: (width, motion = 'instant') => {
    const nextWidth = clampWidth(width)
    writeSessionValue(WIDTH_STORAGE_KEY, String(nextWidth))
    set((state) => state.width === nextWidth && state.motion === motion && state.resizeWidth === null
      ? state : { width: nextWidth, motion, resizeWidth: null })
  },
  setResizeWidth: (resizeWidth) => set({ resizeWidth, motion: 'manual' }),
  rememberWorkspace: (workspaceId) => {
    set((state) => state.activeWorkspaceId === workspaceId
      ? state
      : { activeWorkspaceId: workspaceId, expandedWorkspaceIds: {} })
  },
  setWorkspacesExpanded: (workspacesExpanded) =>
    set((state) => state.workspacesExpanded === workspacesExpanded ? state : { workspacesExpanded }),
  setWorkspaceExpanded: (workspaceId, expanded) =>
    set((state) => state.expandedWorkspaceIds[workspaceId] === expanded
      ? state
      : { expandedWorkspaceIds: { ...state.expandedWorkspaceIds, [workspaceId]: expanded } }),
  setSectionExpanded: (workspaceId, section, expanded) =>
    set((state) => state.expandedSections[workspaceId]?.[section] === expanded
      ? state
      : {
          expandedSections: {
            ...state.expandedSections,
            [workspaceId]: { ...state.expandedSections[workspaceId], [section]: expanded },
          },
        }),
  removeWorkspaceState: (workspaceId) =>
    set((state) => {
      const expandedWorkspaceIds = { ...state.expandedWorkspaceIds }
      const expandedSections = { ...state.expandedSections }
      delete expandedWorkspaceIds[workspaceId]
      delete expandedSections[workspaceId]
      return {
        activeWorkspaceId: state.activeWorkspaceId === workspaceId
          ? undefined
          : state.activeWorkspaceId,
        expandedWorkspaceIds,
        expandedSections,
      }
    }),
  reset: () => {
    removeSessionValue(COLLAPSED_STORAGE_KEY)
    removeSessionValue(WIDTH_STORAGE_KEY)
    set({
      collapsed: false,
      width: DEFAULT_NAVIGATION_WIDTH,
      resizeWidth: null,
      motion: 'instant',
      activeWorkspaceId: undefined,
      workspacesExpanded: true,
      expandedWorkspaceIds: {},
      expandedSections: {},
    })
  },
}))
