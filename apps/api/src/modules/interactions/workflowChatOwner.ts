import { canonicalJson, type EngineChatReadback, type HarnessExecution,
  type NativeSessionReference } from '@foreman-code/contracts'
import type { GraphSqlClient, GraphTransactionSql } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'
import type { PostgresRunRepository } from '../runs/postgres.js'
import type { RunOwnership } from '../runs/ownership.js'
import { markWorkflowControlCommandLocked, readWorkflowControlCommandLocked } from '../collaboration/workflowControlRecords.js'
import type { WorkflowChatNativeTarget, WorkflowChatOwnerPort,
  WorkflowChatTarget, WorkflowControlCommand } from '../collaboration/workflowControlTypes.js'
import type { SessionWriteLease, SingleWriterSessionManager } from './sessionWriter.js'
import { readWorkflowNativeChat } from './workflowChatNativeRead.js'
import { admittedWorkflowChatPrompt } from './workflowChatInput.js'

export interface WorkflowChatNativeCapture {
  native: WorkflowChatNativeTarget
  session: NativeSessionReference
  manager: SingleWriterSessionManager
  lease: SessionWriteLease
  assertCurrent(): void
}
export interface WorkflowChatNativeOwnerDependencies {
  sql: GraphSqlClient
  runs: PostgresRunRepository
  withOwner<T>(target: WorkflowChatTarget,
    work: (owner: RunOwnership, source: HarnessExecution) => Promise<T>): Promise<T>
  capture(target: WorkflowChatTarget, source: HarnessExecution): WorkflowChatNativeCapture | undefined
  captureForRead(target: WorkflowChatTarget): WorkflowChatNativeCapture | undefined
  validateAdmission: WorkflowChatOwnerPort['validateAdmission']
  dispatchConsultation(target: WorkflowChatTarget, command: WorkflowControlCommand,
    owner: RunOwnership, source: HarnessExecution): Promise<void>
}

async function assertCapturedWriterLocked(sql: GraphTransactionSql, capture: WorkflowChatNativeCapture,
  agentId: string): Promise<void> {
  capture.assertCurrent()
  const { lease, native, session } = capture
  const row = (await sql.query<{ valid: boolean }>(`select (owner_agent_id=$2 and harness=$3 and native_session_id=$4
      and record->>'leaseOwner'=$2 and record->>'leaseToken'=$5
      and record->>'connectionGeneration'=$6 and record->>'correlationId'=$7
      and record->>'currentTurnOrMessageId'=$8
      and (record->>'leaseExpiresAt')::timestamptz>clock_timestamp()) as valid
    from native_session_lanes where id=$1 for update`,
  [lease.fence.id, agentId, session.harness, session.nativeSessionId, lease.fence.token,
    String(lease.previous.connectionGeneration), native.ownerRequestId,
    native.nativeTurnId ?? native.inputMessageId])).rows[0]
  if (!row?.valid) throw new DomainError('CHAT_NATIVE_TARGET_CHANGED', 'The captured native writer no longer owns this exact turn.', 409)
  capture.assertCurrent()
}

function sameNative(a: WorkflowChatNativeTarget | null, b: WorkflowChatNativeTarget): boolean {
  return !!a && a.nativeSessionId === b.nativeSessionId && a.ownerRequestId === b.ownerRequestId
    && a.nativeTurnId === b.nativeTurnId && a.inputMessageId === b.inputMessageId
}

/** A thin adapter over the existing coordinator and Run owner. It neither owns
 * a session nor observes a stream, and cannot create a graph successor. */
export function createWorkflowChatOwner(deps: WorkflowChatNativeOwnerDependencies): WorkflowChatOwnerPort {
  const transaction: WorkflowChatOwnerPort['transaction'] = (target, work) => deps.withOwner(target, async (owner, source) => {
    const captured = deps.capture(target, source)
    const store = await deps.runs.repeat(owner)
    return store.workflowChatTransaction(target, captured?.native, () => captured?.assertCurrent(), async context => {
      if (captured) await assertCapturedWriterLocked(context.sql, captured, source.agentId)
      return work(context)
    })
  })
  return {
    transaction,
    readNative: (target, input) => readWorkflowNativeChat(deps.sql, target, input),
    observe: async target => {
      const capture = deps.captureForRead(target)
      const capabilities: EngineChatReadback['capabilities'] = { queue: true,
        steer: capture?.native.steer ? 'native_expected_turn' : 'unavailable',
        interruptAndSend: capture?.native.interruptAndSend ?? false }
      capture?.assertCurrent()
      return { capabilities, ...(capture?.native.nativeTurnId ? { nativeTurnId: capture.native.nativeTurnId } : {}) }
    },
    validateAdmission: deps.validateAdmission,
    dispatch: (target, id) => deps.withOwner(target, async (owner, source) => {
      const store = await deps.runs.repeat(owner)
      const command = await store.workflowChatTransaction(target, undefined, () => owner.assertOwned(),
        context => readWorkflowControlCommandLocked(context.sql, owner.runId, id))
      if (!command || canonicalJson(command.target) !== canonicalJson(target)
        || ['completed','failed','canceled'].includes(command.state) || command.operation === 'cancel') return
      if (command.operation === 'input') return
      if (target.kind === 'workflow_coordinator' && command.consultation) {
        await deps.dispatchConsultation(target, command, owner, source)
        if (command.operation === 'consultation') return
      }
      const capture = deps.capture(target, source)
      if (!capture || !sameNative(command.nativeTarget, capture.native)) return
      if (command.state === 'unknown' || command.state === 'accepted') {
        await reconcileControl(store, target, command, capture, source.agentId)
        return
      }
      let offered = false
      const beforeDispatch = async (signal: AbortSignal) => {
        signal.throwIfAborted(); capture.assertCurrent(); owner.assertOwned()
        await store.workflowChatTransaction(target, capture.native, capture.assertCurrent, async context => {
          await assertCapturedWriterLocked(context.sql, capture, source.agentId)
          const current = await readWorkflowControlCommandLocked(context.sql, owner.runId, id)
          if (!current || !sameNative(current.nativeTarget, capture.native)
            || ['unknown','accepted','completed','failed','canceled'].includes(current.state)) {
            throw new DomainError('CONTROL_ALREADY_OFFERED', 'This control already crossed its native dispatch boundary.', 409)
          }
          // A lost reply or crash is never permission to offer this control a
          // second time. The existing observer reconciles the same receipt.
          await markWorkflowControlCommandLocked(context.sql, { runId: owner.runId, commandId: id,
            state: 'unknown', now: new Date().toISOString() })
        })
        offered = true
        signal.throwIfAborted(); capture.assertCurrent(); owner.assertOwned()
      }
      if (command.operation === 'steer') {
        if (!command.request || !capture.native.nativeTurnId) throw new DomainError('STEER_UNAVAILABLE', 'No exact native turn remains.', 409)
        const accepted = await capture.manager.steerQualified(capture.session, {
          prompt: admittedWorkflowChatPrompt(command), expectedTurnId: capture.native.nativeTurnId,
          clientCorrelationId: command.id, controlCommandId: command.id, ownerRequestId: capture.native.ownerRequestId,
        }, beforeDispatch, capture.lease.guard.signal)
        if (accepted.nativeTurnId !== capture.native.nativeTurnId || !offered) throw new DomainError('NATIVE_CONTROL_RECEIPT_CONFLICT',
          'The native steering acknowledgement names another turn.', 409)
        await markAccepted(store, target, command, capture, source.agentId, accepted.nativeTurnId)
      } else {
        await capture.manager.cancelQualified(capture.session, { controlCommandId: command.id,
          ownerRequestId: capture.native.ownerRequestId,
          ...(capture.native.nativeTurnId ? { nativeTurnId: capture.native.nativeTurnId } : {}),
          ...(capture.native.inputMessageId ? { inputMessageId: capture.native.inputMessageId } : {}) },
        beforeDispatch, capture.lease.guard.signal)
        // Cancel ACK is only dispatch progress. Native terminal/closure and the
        // existing acceptance transaction own settlement and any successor.
      }
    }),
  }
}

async function markAccepted(store: Awaited<ReturnType<PostgresRunRepository['repeat']>>, target: WorkflowChatTarget,
  command: WorkflowControlCommand, capture: WorkflowChatNativeCapture, agentId: string, nativeTurnId: string) {
  await store.workflowChatTransaction(target, capture.native, capture.assertCurrent, async context => {
    await assertCapturedWriterLocked(context.sql, capture, agentId)
    await markWorkflowControlCommandLocked(context.sql, { runId: command.runId, commandId: command.id,
      state: 'accepted', nativeTurnId, now: new Date().toISOString() })
  })
}

async function reconcileControl(store: Awaited<ReturnType<PostgresRunRepository['repeat']>>, target: WorkflowChatTarget,
  command: WorkflowControlCommand, capture: WorkflowChatNativeCapture, agentId: string) {
  if (command.operation !== 'steer' || !capture.native.nativeTurnId || !capture.manager.reconcileSteers) return
  capture.assertCurrent()
  const receipts = await capture.manager.reconcileSteers(capture.session, [{ clientCorrelationId: command.id,
    expectedTurnId: capture.native.nativeTurnId }], capture.lease.guard.signal)
  capture.assertCurrent()
  const accepted = receipts.find(receipt => receipt.correlationId === command.id
    && receipt.nativeSessionId === capture.native.nativeSessionId && receipt.nativeTurnId === capture.native.nativeTurnId)
  if (accepted) await markAccepted(store, target, command, capture, agentId, accepted.nativeTurnId)
}
