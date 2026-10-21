import { MemoryBoardMutationSchema } from '@foreman-code/contracts'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import type { RetainedMemoryCommand } from './commandRecovery'
import { cardDraftCommand } from './cardEditing'
import { noteDraftCommand } from './noteEditing'
import type { MemoryDraft } from './drafts'

/** A receipt clears only the exact submitted editor, never a later local draft. */
export function memoryDraftMatchesCommand(draft: MemoryDraft | undefined, command: RetainedMemoryCommand | undefined): boolean {
  if (!draft || !command) return false
  const candidate = draft.kind === 'card' ? cardDraftCommand(command.boardId, draft) : noteDraftCommand(command.boardId, draft)
  const parsed = MemoryBoardMutationSchema.safeParse({ ...candidate, commandId: command.commandId })
  return parsed.success && sameWorkflowValue(parsed.data, command)
}
