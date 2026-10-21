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
      try { drafts[decodeURIComponent(key.slice(prefix.length))] = localStorage.getItem(key) ?? '' } catch { /* Ignore a malformed key. */ }
    }
  } catch { /* Drafts can remain in memory when storage is unavailable. */ }
  return drafts
}
export interface ConversationDraftState {
  drafts: Record<string, string>
  setDraft(conversationId: string, value: string): void
  clearDraft(conversationId: string, expectedContent?: string): void
  clearAllDrafts(): void
}

/** Each conversation has an independent storage key; another tab cannot overwrite its neighbors. */
export const useConversationDraftStore = create<ConversationDraftState>((set) => ({
  drafts: loadDrafts(),
  setDraft: (id, value) => {
    if (!available()) return
    try { window.localStorage.setItem(protectedKey('draft', id), value) } catch { /* Storage is optional for drafting. */ }
    set((state) => ({ drafts: { ...state.drafts, [id]: value } }))
  },
  clearDraft: (id, expectedContent) => {
    if (!available()) return
    set((state) => {
      let latest = state.drafts[id]
      try { latest = window.localStorage.getItem(protectedKey('draft', id)) ?? latest } catch { /* Use the in-memory draft. */ }
      if (expectedContent !== undefined && latest?.trim() !== expectedContent.trim()) return state
      const drafts = { ...state.drafts }; delete drafts[id]
      try { window.localStorage.removeItem(protectedKey('draft', id)) } catch { /* Storage is optional for drafting. */ }
      return { drafts }
    })
  },
  clearAllDrafts: () => set({ drafts: {} }),
}))

if (typeof window !== 'undefined') {
  window.addEventListener(identityChangedEvent, () => useConversationDraftStore.setState({ drafts: {} }))
  window.addEventListener('storage', (event) => {
    if (!available()) return
    if (event.key === null) { useConversationDraftStore.setState({ drafts: {} }); return }
    if (!event.key.startsWith(prefix)) return
    let id: string
    try { id = decodeURIComponent(event.key.slice(prefix.length)) } catch { return }
    useConversationDraftStore.setState((state) => {
      const drafts = { ...state.drafts }
      let latest = event.newValue
      try { latest = window.localStorage.getItem(event.key!) } catch { /* Use the storage event when reads are unavailable. */ }
      if (latest === null) delete drafts[id]
      else drafts[id] = latest
      return { drafts }
    })
  })
}
export function getConversationDraft(id: string): string { return useConversationDraftStore.getState().drafts[id] ?? '' }
