import { create } from 'zustand'
import type { WorkspaceRootSelection } from '@foreman-code/contracts/workspace-root-policies'

export type RootCandidate = { relativePath: string; accessMode: WorkspaceRootSelection['accessMode']; locationRevision: number; rootPolicyRevision: number }
export type RootPickerDraft = { open: boolean; selected?: string; candidates: Record<string, RootCandidate>; editVersion: number; notice?: string; conflict?: boolean }
export const emptyRootPicker = (): RootPickerDraft => ({ open: false, candidates: {}, editVersion: 0 })
/** Unsubmitted paths are isolated by access session, workspace, host installation and approved base. */
export const useBoundLocationDraftStore = create<{ pickers: Record<string, RootPickerDraft | undefined>; reset(): void; update(scope: string, apply: (previous: RootPickerDraft) => RootPickerDraft): void }>(set => ({
  pickers: {}, reset: () => set({ pickers: {} }),
  update: (scope, apply) => set(state => ({ pickers: { ...state.pickers, [scope]: apply(state.pickers[scope] ?? emptyRootPicker()) } })),
}))
