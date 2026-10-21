import { create } from 'zustand'
import type { RunsWindowRect } from './windowGeometry'

/** Interaction only. Selected identities and server responses never enter Zustand. */
export const useRunsSelectorUi = create<{
  openId: string | null
  setOpen: (id: string | null) => void
  geometry: { scope: string; rect: RunsWindowRect } | null
  setGeometry: (scope: string, rect: RunsWindowRect) => void
}>((set) => ({
  openId: null,
  setOpen: (openId) => set({ openId }),
  geometry: null,
  setGeometry: (scope, rect) => set({ geometry: { scope, rect } }),
}))
