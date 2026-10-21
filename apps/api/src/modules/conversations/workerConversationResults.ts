import { isDeepStrictEqual } from 'node:util'
import type { CompactionState, ExecutionResult } from '@foreman-code/contracts'
import type { WorkerConversationReceipt } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeHarnessSessionManager } from '../harnesses/port.js'
import { DomainError } from '../errors.js'

function unavailable(message: string): never {
  throw new DomainError('WORKER_CONVERSATION_RECOVERY_REQUIRED', message, 409)
}

/** Read recorded native outcomes without submitting or replaying work. */
export async function readWorkerConversationResults(record: WorkerConversationReceipt,
  manager: NativeHarnessSessionManager, signal: AbortSignal,
  readCompaction?: (state: CompactionState) => Promise<CompactionState>) {
  const session = record.session
  if (!session) unavailable('The persisted chat has no recoverable native session.')
  const recoveredTurns: Array<{ correlationId: string; result: ExecutionResult }> = []
  for (const turn of record.turns) {
    if (turn.status === 'rejected') continue
    const history = await manager.reconcile(session, turn.correlationId, signal)
    let terminal = history.correlationId === turn.correlationId ? history.terminalResult : undefined
    if (history.terminalTurn?.correlationId === turn.correlationId) terminal = history.terminalTurn.result
    // Claude transcripts retain the input receipt, while the completed result lives in the journal.
    if (!terminal && session.harness === 'claude' && turn.status === 'completed'
      && history.correlationId === turn.correlationId && turn.nativeSubmission
      && isDeepStrictEqual(history.nativeSubmission, turn.nativeSubmission)) {
      terminal = turn.result ?? undefined
    }
    const nativeId = history.nativeTurnId ?? history.nativeSubmission?.nativeMessageId
    const acceptedId = turn.nativeTurnId ?? turn.nativeSubmission?.nativeMessageId
    if (!terminal || !acceptedId || nativeId !== acceptedId
      || turn.status === 'completed' && (!turn.result || !isDeepStrictEqual(terminal, turn.result))
      || turn.result && !isDeepStrictEqual(terminal, turn.result)
      || turn.nativeSubmission && !isDeepStrictEqual(history.nativeSubmission, turn.nativeSubmission)
      || history.pendingInteraction || history.pendingInteractions?.length) {
      unavailable('The recorded native turn could not be recovered on its original session.')
    }
    if (turn.status !== 'completed') recoveredTurns.push({ correlationId: turn.correlationId, result: terminal })
  }
  const recoveredCompactions: CompactionState[] = []
  for (const control of record.compactions) {
    if (['completed', 'failed', 'no-op'].includes(control.state.status)) continue
    if (control.state.dispatchPhase !== 'dispatched') unavailable('The native compaction was not dispatched.')
    if (!readCompaction) unavailable('This native driver cannot read a compaction result.')
    const state = await readCompaction(control.state)
    if (state.requestId !== control.state.requestId || state.nativeSessionId !== session.nativeSessionId
      || control.state.nativeOperationId && state.nativeOperationId !== control.state.nativeOperationId
      || !['completed', 'failed', 'no-op'].includes(state.status)) {
      unavailable('The dispatched native compaction has no confirmed result on its original session.')
    }
    recoveredCompactions.push(state)
  }
  return { recoveredTurns, recoveredCompactions }
}
