import { create } from 'zustand'

export { applyStoredOrder, moveItemRelative, moveItemToIndex } from '../../shared/ui/listOrder'

/** Order key for the workspace entries that share the Workspaces parent. */
export const WORKSPACES_ORDER_KEY = 'workspaces'

/** Order key for the top-level destinations outside the workspace tree. */
export const GLOBAL_NAVIGATION_ORDER_KEY = 'global-navigation'

/** Order key for the sections that share one workspace parent. */
export function workspaceSectionsOrderKey(workspaceId: string): string {
  return `workspace:${workspaceId}:sections`
}

export interface NavigationReorderAnnouncement {
  message: string
  nonce: number
}

interface NavigationOrderStore {
  /** Sibling order per parent key: this is local interaction state, not URL or server state. */
  orders: Readonly<Record<string, readonly string[]>>
  announcement: NavigationReorderAnnouncement | null
  setOrder: (parentKey: string, ids: readonly string[]) => void
  announce: (message: string) => void
  reset: () => void
}

/**
 * Sibling order for the sidebar menus. Zustand keeps it stable across route
 * remounts in the current session; it is intentionally not persisted, not in
 * the URL, and not in Query.
 */
export const useNavigationOrderStore = create<NavigationOrderStore>((set) => ({
  orders: {},
  announcement: null,
  setOrder: (parentKey, ids) =>
    set((state) => ({ orders: { ...state.orders, [parentKey]: [...ids] } })),
  announce: (message) =>
    set((state) => ({
      announcement: { message, nonce: (state.announcement?.nonce ?? 0) + 1 },
    })),
  reset: () => set({ orders: {}, announcement: null }),
}))
