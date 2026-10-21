import { create } from 'zustand'
import type { MemoryBoardMutation, MemoryCard, MemoryNote, MemoryCardWorkSelection } from '@foreman-code/contracts'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { identityEpoch } from '../../shared/api/protectedChatStorage'

export type CardFields = Extract<MemoryBoardMutation, { kind: 'card_create' }>['card']
export interface CardDraft {
  kind: 'card'
  original?: MemoryCard
  fields: CardFields
  workSelections: MemoryCardWorkSelection[]
  sourcePostId?: string
  resolutionRequired?: boolean
  dirty: boolean
}
export interface NoteDraft {
  kind: 'note'
  original?: MemoryNote
  text: string
  rank: string
  sourcePostId?: string
  dirty: boolean
}
export type MemoryDraft = CardDraft | NoteDraft
const draftKey = (boardId: string) => `${identityEpoch()}:${sessionGeneration()}:${boardId}`
export const useMemoryDrafts = create<{
  entries: Record<string, MemoryDraft | undefined>
  set(boardId: string, draft?: MemoryDraft): void
}>((set) => ({ entries: {}, set: (boardId, draft) => set((state) => ({ entries: { ...state.entries, [draftKey(boardId)]: draft } })) }))
export function useMemoryDraft(boardId: string): MemoryDraft | undefined {
  return useMemoryDrafts((state) => state.entries[draftKey(boardId)])
}
export function setMemoryDraft(boardId: string, draft?: MemoryDraft): void {
  useMemoryDrafts.getState().set(boardId, draft)
}
export function newCardDraft(sourcePostId?: string): CardDraft {
  return { kind: 'card', fields: { title: '', body: '', status: 'todo', completionKind: null, reason: null, assignee: null, linkedNodes: [] },
    workSelections: [], sourcePostId, dirty: false }
}
export function editCardDraft(card: MemoryCard): CardDraft {
  const { title, body, status, completionKind, reason, assignee, linkedNodes } = card
  return { kind: 'card', original: card, fields: { title, body, status, completionKind, reason, assignee, linkedNodes }, workSelections: [], dirty: false }
}
export function editNoteDraft(note?: MemoryNote, sourcePostId?: string): NoteDraft {
  return { kind: 'note', original: note, text: note?.text ?? '', rank: note ? String(note.rank) : '', sourcePostId, dirty: false }
}
