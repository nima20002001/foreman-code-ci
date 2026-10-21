import { create } from 'zustand'
import { identityChangedEvent, identityEpoch, protectedKey } from '../../shared/api/protectedChatStorage'
import { sessionIsSwitching } from '../../shared/api/sessionBoundary'

const documentEpoch = identityEpoch()
const prefix = protectedKey('draft')
function available(): boolean { return !sessionIsSwitching() && identityEpoch() === documentEpoch }
function loadDrafts(): Record<string, string> {
  const drafts: Record<string, string> = {}
  if (typeof window === 'undefined') return drafts
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(prefix)) continue
      try { drafts[decodeURIComponent(key.slice(prefix.length))] = localStorage.getItem(key) ?? '' } catch { /* ignore: malformed storage keys are not drafts. */ }
    }
  } catch { /* ignore: drafting remains available in memory. */ }
  return drafts
}
export interface ConversationDraftState {
  drafts: Record<string, string>
  versions: Record<string, number>
  setDraft(conversationId: string, value: string): void
  clearDraft(conversationId: string, expectedContent?: string): void
  clearExactDraft(conversationId: string, expectedContent: string, expectedVersion: number): void
  clearAllDrafts(): void
}

/** Each conversation has an independent storage key; another tab cannot overwrite its neighbors. */
export const useConversationDraftStore = create<ConversationDraftState>((set) => ({
  drafts: loadDrafts(),
  versions: {},
  setDraft: (id, value) => {
    if (!available()) return
    try { window.localStorage.setItem(protectedKey('draft', id), value) } catch { /* ignore: drafting remains available in memory. */ }
    set((state) => ({ drafts: { ...state.drafts, [id]: value }, versions: { ...state.versions, [id]: (state.versions[id] ?? 0) + 1 } }))
  },
  clearDraft: (id, expectedContent) => {
    if (!available()) return
    set((state) => {
      let latest = state.drafts[id]
      try { latest = window.localStorage.getItem(protectedKey('draft', id)) ?? latest } catch { /* ignore: use the current in-memory draft. */ }
      if (expectedContent !== undefined && latest?.trim() !== expectedContent.trim()) return state
      const drafts = { ...state.drafts }; delete drafts[id]
      try { window.localStorage.removeItem(protectedKey('draft', id)) } catch { /* ignore: this view retains the cleared state. */ }
      return { drafts, versions: { ...state.versions, [id]: (state.versions[id] ?? 0) + 1 } }
    })
  },
  clearExactDraft: (id, expectedContent, expectedVersion) => {
    if (!available()) return
    set(state => {
      let latest = state.drafts[id]
      try { latest = window.localStorage.getItem(protectedKey('draft', id)) ?? latest }
      catch { /* ignore: the in-memory draft remains available. */ }
      if (latest !== expectedContent || state.drafts[id] !== expectedContent || (state.versions[id] ?? 0) !== expectedVersion) return state
      const drafts = { ...state.drafts }; delete drafts[id]
      try { window.localStorage.removeItem(protectedKey('draft', id)) }
      catch { /* ignore: this view retains the cleared state. */ }
      return { drafts, versions: { ...state.versions, [id]: expectedVersion + 1 } }
    })
  },
  clearAllDrafts: () => set({ drafts: {}, versions: {} }),
}))

if (typeof window !== 'undefined') {
  window.addEventListener(identityChangedEvent, () => useConversationDraftStore.setState({ drafts: {}, versions: {} }))
  window.addEventListener('storage', (event) => {
    if (!available()) return
    if (event.key === null) { useConversationDraftStore.setState({ drafts: {}, versions: {} }); return }
    if (!event.key.startsWith(prefix)) return
    let id: string
    try { id = decodeURIComponent(event.key.slice(prefix.length)) } catch { return /* ignore: malformed storage keys are not drafts. */ }
    useConversationDraftStore.setState((state) => {
      const drafts = { ...state.drafts }
      let latest = event.newValue
      try { latest = window.localStorage.getItem(event.key!) } catch { /* ignore: the storage event carries the latest available draft. */ }
      if (latest === null) delete drafts[id]
      else drafts[id] = latest
      return { drafts, versions: { ...state.versions, [id]: (state.versions[id] ?? 0) + 1 } }
    })
  })
}
export function getConversationDraft(id: string): string { return useConversationDraftStore.getState().drafts[id] ?? '' }
