import { createStore } from 'zustand'

/** Local selection only; revision/identity snapshots are captured when a card is selected. */
export function createResourceSelection<T = number>() {
  return createStore<{
    selecting: boolean
    selected: Record<string, T>
    confirming: boolean
    notice: string
    start: () => void
    toggle: (id: string, revision: T) => void
    selectMany: (items: readonly { id: string; revision: T }[]) => void
    deselectAll: () => void
    confirm: (open: boolean) => void
    clear: (notice?: string) => void
  }>((set) => ({
    selecting: false, selected: {}, confirming: false, notice: '',
    start: () => set({ selecting: true, selected: {}, notice: '' }),
    toggle: (id, revision) => set((state) => {
      const selected = { ...state.selected }
      if (id in selected) delete selected[id]
      else if (Object.keys(selected).length < 100) selected[id] = revision
      return { selected }
    }),
    selectMany: (items) => set((state) => ({
      selected: Object.fromEntries(items.slice(0, 100).map(({ id, revision }) => [id, state.selected[id] ?? revision])),
    })),
    deselectAll: () => set({ selected: {} }),
    confirm: (confirming) => set({ confirming }),
    clear: (notice = '') => set({ selecting: false, selected: {}, confirming: false, notice }),
  }))
}
