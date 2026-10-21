import { create } from 'zustand'

/** Only local disclosure state; no Run data, selection, cursor or lifecycle. */
export const useInspectionPresentation = create<{
  open: Record<string, boolean>
  setOpen(key: string, value: boolean): void
}>((set) => ({
  open: {},
  setOpen: (key, value) => set((state) => {
    const open = { ...state.open }
    if (value) open[key] = true
    else delete open[key]
    return { open }
  }),
}))
