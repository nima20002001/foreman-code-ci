import { setTimeout as delay } from 'node:timers/promises'
import { canonicalJson, ExecutionResultSchema, type CoordinatorConsultationBinding,
  type NativeHarnessEvent, type NativeSessionReference } from '@foreman-code/contracts'
import type { NativeHarnessSessionManager, NativeHistory } from '../harnesses/port.js'
import { DomainError } from '../errors.js'
import type { ConsultationTransaction } from '../collaboration/consultationBrowser.js'
import { bindCoordinatorConsultationNativeLocked, captureCoordinatorConsultationNativeLocked,
  readCoordinatorConsultationLocked, settleCoordinatorConsultationLocked } from '../collaboration/workflowConsultations.js'
import { markWorkflowControlCommandLocked } from '../collaboration/workflowControlRecords.js'
import type { WorkflowChatNativeTarget, WorkflowConsultationAdmission } from '../collaboration/workflowControlTypes.js'
import { appendConsultationNativeLocked, assertConsultationWriterLocked, type ConsultationWriter } from './workflowConsultationJournal.js'
import { nativePersistenceRedactor } from './nativePersistence.js'
import { reviewTurnEvidence } from './reviewerEvidence.js'
import type { SessionWriteLease, SingleWriterSessionManager } from './sessionWriter.js'

export interface ConsultationObservationInput {
  binding: CoordinatorConsultationBinding
  commandId: string
  agentId: string
  session: NativeSessionReference
  manager: SingleWriterSessionManager
  transaction: ConsultationTransaction
  signal: AbortSignal
  prompt: string
  sessionMode: 'regular' | 'plan'
  /** A captured writer is always reconciled; it is never offered again. */
  captured: WorkflowChatNativeTarget | null
  secrets: readonly string[]
  assertCurrent(): void
  acknowledge(lease: SessionWriteLease, providerId: string): Promise<void>
  beforeSettlement(manager: NativeHarnessSessionManager, lease: SessionWriteLease): Promise<void>
  onSubmitted(): void
}

function nativeTarget(input: ConsultationObservationInput, providerId?: string): WorkflowChatNativeTarget {
  return { nativeSessionId: input.session.nativeSessionId, ownerRequestId: `consultation:${input.binding.consultationId}`,
    sessionMode: input.sessionMode, steer: input.session.harness === 'codex', interruptAndSend: true,
    ...(providerId ? { providerId, ...(input.session.harness === 'codex' ? { nativeTurnId: providerId }
      : { inputMessageId: providerId }) } : {}) }
}

function writer(input: ConsultationObservationInput, lease?: SessionWriteLease): ConsultationWriter {
  const current = lease ?? input.manager.capturedLease(input.session)
  if (!current) throw new DomainError('COORDINATOR_NATIVE_OWNER_CHANGED', 'The original consultation writer is unavailable.', 409)
  return { binding: input.binding, session: input.session, agentId: input.agentId, lease: current,
    assertCurrent: () => { input.assertCurrent(); input.manager.assertCapturedLease(input.session, current) } }
}

async function acknowledge(input: ConsultationObservationInput, providerId: string, lease?: SessionWriteLease) {
  const owned = writer(input, lease)
  await owned.lease.guard.check()
  await input.transaction(async context => {
    await assertConsultationWriterLocked(context.sql, owned)
    await bindCoordinatorConsultationNativeLocked(context.sql, { binding: input.binding,
      nativeTarget: nativeTarget(input, providerId), now: new Date().toISOString() })
  })
  input.onSubmitted()
}

async function offerConsultation(input: ConsultationObservationInput): Promise<void> {
  const safe = nativePersistenceRedactor([...input.secrets])
  const events = input.manager.startTurnBatches(input.session, { prompt: input.prompt,
    sessionMode: input.sessionMode, clientCorrelationId: `consultation:${input.binding.consultationId}`,
    deferSettlement: true,
    onSessionReady: async () => {
      const owned = writer(input)
      await input.transaction(async context => {
        if (context.stopping || context.accepted) throw new DomainError('TARGET_SETTLED', 'The coordinator no longer admits this reply.', 409)
        await assertConsultationWriterLocked(context.sql, owned)
        const current = await readCoordinatorConsultationLocked(context.sql, input.binding.runId, input.binding.waitingActivationId)
        if (current?.nativeTarget || current?.state !== 'admitted') throw new DomainError('CONTROL_ALREADY_OFFERED',
          'This consultation already crossed its native submission boundary.', 409)
        await captureCoordinatorConsultationNativeLocked(context.sql, { binding: input.binding,
          nativeTarget: nativeTarget(input), now: new Date().toISOString() })
        await context.sql.query("update run_coordinator_consultations set state='unknown' where id=$1", [input.binding.consultationId])
        await markWorkflowControlCommandLocked(context.sql, { runId: input.binding.runId,
          commandId: input.commandId, state: 'unknown', now: new Date().toISOString() })
      })
    },
    onSubmitted: providerId => acknowledge(input, providerId),
    onMessageSubmitted: receipt => acknowledge(input, receipt.nativeMessageId),
  }, input.signal)
  for await (const batch of events) {
    input.assertCurrent()
    const owned = writer(input)
    await input.transaction(context => appendConsultationNativeLocked(context.sql, owned,
      { events: batch.map(event => safe.value(event)), now: new Date().toISOString() }))
  }
}

/** Recovery pages may contain earlier session history; only the captured native
 * turn/submission belongs to this consultation's transcript. */
function currentEvents(input: ConsultationObservationInput, history: NativeHistory, providerId: string): NativeHarnessEvent[] {
  const correlation = `consultation:${input.binding.consultationId}`
  return history.events.filter(event => {
    const p = event.payload
    const turn = p.turn && typeof p.turn === 'object' && !Array.isArray(p.turn) ? p.turn as Record<string, unknown> : undefined
    if (typeof p.nativeSessionId === 'string' && p.nativeSessionId !== input.session.nativeSessionId
      || typeof p.threadId === 'string' && p.threadId !== input.session.nativeSessionId) return false
    return p.clientCorrelationId === correlation || p.correlationId === correlation
      || p.nativeTurnId === providerId || p.turnId === providerId || turn?.id === providerId
      || p.nativeMessageId === providerId
  })
}

async function reconcileConsultation(input: ConsultationObservationInput): Promise<WorkflowConsultationAdmission | undefined> {
  const correlation = `consultation:${input.binding.consultationId}`
  const safe = nativePersistenceRedactor([...input.secrets])
  return input.manager.withLane(input.session, correlation, input.signal, async (raw, lease) => {
    const owned = writer(input, lease)
    let providerId = input.captured?.nativeTurnId ?? input.captured?.inputMessageId
    for (;;) {
      input.assertCurrent(); await lease.guard.check()
      let history = await raw.reconcile(input.session, correlation, lease.guard.signal)
      await lease.guard.check()
      const proof = reviewTurnEvidence(input.session, history, correlation, providerId)
      if (proof.identityConflict) throw new DomainError('COORDINATOR_NATIVE_IDENTITY_CONFLICT',
        'The retained native result belongs to another consultation.', 409)
      providerId ??= proof.providerId
      if (providerId) {
        await input.acknowledge(lease, providerId)
        lease.providerId = providerId
        lease.observedStatus = proof.terminal ? 'idle' : proof.nativeBusy ? 'busy' : 'uncertain'
        await acknowledge(input, providerId, lease)
        if (proof.terminal && raw.settleTurn) {
          history = await raw.settleTurn(input.session, correlation, lease.guard.signal)
          await lease.guard.check()
        }
        await input.transaction(context => appendConsultationNativeLocked(context.sql, owned,
          { events: currentEvents(input, history, providerId!).map(event => safe.value(event)),
            history: safe.value({ ...history, events: currentEvents(input, history, providerId!) }), now: new Date().toISOString() }))
      }
      const terminal = reviewTurnEvidence(input.session, history, correlation, providerId)
      if (providerId && terminal.terminal && !terminal.identityConflict) {
        const original = history.terminalTurn?.correlationId === correlation && history.terminalTurn.providerId === providerId
          ? history.terminalTurn.result : history.nativeSubmission?.clientCorrelationId === correlation
            && history.nativeSubmission.nativeMessageId === providerId ? history.terminalResult : undefined
        const result = ExecutionResultSchema.parse(original)
        await raw.retireTurn?.(input.session, correlation)
        await input.beforeSettlement(raw, lease)
        input.assertCurrent(); await lease.guard.check()
        const next = await input.transaction(async context => {
          await assertConsultationWriterLocked(context.sql, owned)
          return settleCoordinatorConsultationLocked(context.sql, { binding: input.binding,
            outcome: result.outcome === 'succeeded' ? 'completed' : result.outcome === 'canceled' ? 'canceled' : 'failed',
            nativeEvidence: { ...nativeTarget(input, providerId), observedAt: new Date().toISOString(), source: 'native_terminal',
              payload: safe.value({ result, terminalTurn: history.terminalTurn ?? null,
                nativeSubmission: history.nativeSubmission ?? null }) }, now: new Date().toISOString() })
        })
        lease.observedStatus = 'idle'
        return next
      }
      await delay(1000, undefined, { signal: lease.guard.signal })
    }
  })
}

/** Exactly one observer, owned by ApprovalExecutionCoordinator's session entry.
 * Consultation output never enters the graph's result/native publication path. */
export async function observeWorkflowConsultation(input: ConsultationObservationInput): Promise<WorkflowConsultationAdmission | undefined> {
  if (!input.captured) await offerConsultation(input)
  else if (canonicalJson(input.captured.nativeSessionId) !== canonicalJson(input.binding.nativeSessionId)) {
    throw new DomainError('COORDINATOR_NATIVE_IDENTITY_CONFLICT', 'The saved consultation session changed.', 409)
  }
  return reconcileConsultation(input)
}
