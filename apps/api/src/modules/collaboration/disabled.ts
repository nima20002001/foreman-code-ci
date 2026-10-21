import type { BoardApplicationReceipt } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import type { BrowserLifecyclePort, CollaborationPorts, ExecutionChatPort, MemoryBoardPort } from './ports.js'

function unavailable(feature: string): never {
  throw new DomainError('COLLABORATION_UNAVAILABLE', `${feature} is not available.`, 503, { retryable: false })
}

/** A disabled callback has no ledger entry. The sentinel cannot be mistaken for a stored effect. */
function noBoardApplication(sourceEventKey: string): BoardApplicationReceipt {
  return { applicationId: `disabled:${sourceEventKey}`, sourceEventKey, commandIds: [],
    changedCardIds: [], boardRevisions: [], replayed: false }
}

export const disabledMemoryBoardPort: MemoryBoardPort = {
  readDigest: async () => ({ text: '', cardIds: [], byteLength: 0, omittedCount: 0 }),
  applyResultLocked: async (_tx, input) => {
    if (input.result.kind !== 'none') unavailable('Memory board effects')
    if (input.result.appliedCommandIds?.length) unavailable('Memory board command readback')
    return noBoardApplication(input.sourceEventKey)
  },
  applyLifecycleLocked: async (_tx, fact) => noBoardApplication(fact.sourceEventKey),
}

export const disabledExecutionChatPort: ExecutionChatPort = {
  deliver: async () => unavailable('Run chat delivery'),
  read: async () => unavailable('Run chat readback'),
  stop: async () => unavailable('Run chat control'),
  cancel: async () => unavailable('Run chat queue control'),
}

export const disabledBrowserLifecyclePort: BrowserLifecyclePort = {
  prepare: async () => ({ kind: 'unavailable', reason: 'disabled', retryable: false }),
  // A disabled implementation has never acquired leases. Do not claim cleanup of a live session.
  release: async () => unavailable('Browser session cleanup'),
}

/** No database/native reads, installs, subscriptions or background tasks are started here. */
export const disabledCollaborationPorts: CollaborationPorts = {
  memoryBoards: disabledMemoryBoardPort,
  executionChat: disabledExecutionChatPort,
  browser: disabledBrowserLifecyclePort,
}
