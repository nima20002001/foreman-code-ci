import type { MemoryBoardMutation } from '@foreman-code/contracts'
import type { NoteDraft } from './drafts'

export function noteDraftCommand(boardId: string, draft: NoteDraft): MemoryBoardMutation {
  const rank = draft.rank === '' ? undefined : Number(draft.rank)
  return draft.original
    ? { kind: 'note_update', boardId, noteId: draft.original.id, expectedRevision: draft.original.revision,
      patch: { text: draft.text, ...(rank === undefined ? {} : { rank }) } }
    : { kind: 'note_create', boardId, text: draft.text, ...(rank === undefined ? {} : { rank }),
      ...(draft.sourcePostId ? { sourcePostId: draft.sourcePostId } : {}) }
}
