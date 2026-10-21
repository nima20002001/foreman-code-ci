import { asRecord } from '../../shared/records.js'
import type { HarnessExecution, NativeSessionReference } from '@foreman-code/contracts'
import type { NativeHistory } from '../harnesses/port.js'
import { DomainError } from '../errors.js'

function outcome(status: unknown): 'succeeded' | 'failed' | 'canceled' | undefined {
  return status === 'completed' ? 'succeeded' : status === 'failed' ? 'failed' : status === 'interrupted' ? 'canceled' : undefined
}

export function workflowProviderId(session: NativeSessionReference, history: NativeHistory): string | undefined {
  if (session.harness !== 'claude') return history.nativeTurnId
  const submission = history.nativeSubmission
  if (submission?.kind !== 'message' || submission.nativeSessionId !== session.nativeSessionId
    || submission.clientCorrelationId !== history.correlationId) return undefined
  return submission.nativeMessageId
}

/** Used only AFTER private original-source capture verification. Convenience
 * NativeHistory terminal fields and abort ACKs are not positive provider proof.
 * Require the matching original terminal frame without rewriting its source. */
export function assertOriginalWorkflowTerminal(execution: Pick<HarnessExecution, 'id' | 'agentId'>,
  session: NativeSessionReference, history: NativeHistory, command = `execution:${execution.id}`): void {
  const terminal = history.terminalTurn
  const fail = (): never => { throw new DomainError('NATIVE_TERMINAL_SOURCE_REQUIRED',
    'The exact original native terminal frame and pinned turn are required.', 409) }
  if (!terminal || terminal.correlationId !== command || history.correlationId !== command
    || !terminal.providerId || terminal.providerId !== workflowProviderId(session, history)
    || history.pendingInteraction || history.pendingInteractions.length) return fail()
  if (session.harness === 'claude') {
    for (const event of history.events) {
      const payload = asRecord(event.payload)
      const raw = asRecord(payload.nativeResult)
      const prompts = Array.isArray(raw.user_message_uuids) ? raw.user_message_uuids : [raw.user_message_uuid]
      if (event.type !== 'claude.result' || payload.clientCorrelationId !== command
        || raw.type !== 'result' || raw.session_id !== session.nativeSessionId || raw.parent_tool_use_id != null
        || typeof raw.uuid !== 'string' || !raw.uuid || asRecord(payload.source).eventId !== raw.uuid
        || !prompts.includes(terminal.providerId) || raw.deferred_tool_use != null) continue
      if (raw.subtype === 'success' && raw.is_error === false && terminal.result.outcome === 'succeeded'
        && raw.result === terminal.result.output) return
      if (raw.is_error === true && ['error_during_execution', 'error_max_turns', 'error_max_budget_usd',
        'error_max_structured_output_retries'].includes(String(raw.subtype))
        && terminal.result.outcome === 'failed' && terminal.result.error?.code === 'CLAUDE_NATIVE_RESULT_ERROR') return
    }
    return fail()
  }
  if (session.harness !== 'codex') return fail()
  for (const event of history.events) {
    const payload = asRecord(event.payload), turn = asRecord(payload.turn)
    if ((event.type === 'turn.completed' || event.type === 'turn/completed')
      && payload.threadId === session.nativeSessionId
      && (payload.turnId ?? turn.id) === terminal.providerId
      && (payload.clientCorrelationId === undefined || payload.clientCorrelationId === command)
      && outcome(payload.status ?? turn.status) === terminal.result.outcome) return
    if (event.type !== 'thread.reconciled' && event.type !== 'thread.attached') continue
    const thread = asRecord(payload.thread)
    if (thread.id !== session.nativeSessionId || !Array.isArray(thread.turns)) continue
    for (const raw of thread.turns) {
      const current = asRecord(raw)
      if (current.id === terminal.providerId && outcome(current.status) === terminal.result.outcome
        && (current.clientUserMessageId === undefined || current.clientUserMessageId === command)) return
    }
  }
  return fail()
}
