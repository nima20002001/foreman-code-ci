import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import type { MemoryBoardMutation, MemoryCardWorkSelection } from '@foreman-code/contracts'
import type { CardDraft, CardFields } from './drafts'
import { nodeKey } from './presentation'

export function selectionKey(selection: MemoryCardWorkSelection): string {
  if (selection.kind === 'next_activation') return `next:${nodeKey(selection.node)}`
  const work = selection.work
  return `${work.kind}:${work.runId}:${work.workflowVersionId}:${work.kind === 'activation' ? work.activationId : work.slotId}`
}
export function cardDraftProblem(draft: CardDraft): { field: 'title' | 'reason'; message: string } | undefined {
  if (!draft.fields.title.trim()) return { field: 'title', message: 'Write a title for this card.' }
  const reasonRequired = draft.fields.status === 'blocked' || draft.fields.status === 'waiting_for_user' || draft.fields.completionKind === 'dropped'
    || draft.original?.status === 'done' && draft.fields.status !== 'done' || draft.resolutionRequired
  if (reasonRequired && !draft.fields.reason?.trim()) return { field: 'reason', message: 'Add a reason for this change.' }
  return undefined
}
export function cardDraftCommand(boardId: string, draft: CardDraft): MemoryBoardMutation {
  const fields = { ...draft.fields, title: draft.fields.title.trim() }
  if (!draft.original) return { kind: 'card_create', boardId, card: fields,
    ...(draft.sourcePostId ? { sourcePostId: draft.sourcePostId } : {}),
    ...(draft.workSelections.length ? { workSelections: draft.workSelections } : {}) }
  const original = draft.original
  const patch: Partial<CardFields> = {}
  for (const key of Object.keys(fields) as Array<keyof CardFields>) {
    if (!sameWorkflowValue(fields[key], original[key])) Object.assign(patch, { [key]: fields[key] })
  }
  // An explicit unchanged field lets the service return its canonical no-op receipt.
  if (Object.keys(patch).length === 0 && draft.workSelections.length === 0) patch.title = fields.title
  return { kind: 'card_update', boardId, cardId: original.id, patch, expectedRevision: original.revision,
    ...(draft.workSelections.length ? { workSelections: draft.workSelections } : {}) }
}
