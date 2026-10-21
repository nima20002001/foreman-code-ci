import { canonicalJson, ChatControlReceiptSchema, ChatDeliveryReceiptSchema,
  type ChatControlReceipt, type ChatQueueCancelRequest, type ChatSendRequest, type ChatStopRequest } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { CONTROL_COMMAND_SUMMARY_COLUMNS, controlDigest, insertControlCommand, readControlCommand,
  updateControlCommand, type ControlCommandRow, type ControlCommandSummary } from './workflowControlRecords.js'
import { claimWorkflowControlInputLocked, readWorkflowControlDispositionLocked,
  reserveWorkflowControlContinuationLocked } from './workflowControlStore.js'
import { readCoordinatorConsultationLocked, reserveCoordinatorConsultationLocked,
  stopCoordinatorConsultationLocked } from './workflowConsultations.js'
import type { WorkflowChatLockedTarget, WorkflowChatOwnerPort } from './workflowControlTypes.js'

interface AdmissionIdentity { id: string; commandId: string; principalId: string; now: string }

async function assertSendable(context: WorkflowChatLockedTarget): Promise<void> {
  if (context.stopping) throw new DomainError('TARGET_SETTLING', 'The selected Run is stopping. Your input was not redirected.', 409)
  if (!['queued', 'running', 'waiting'].includes(context.run.executionState)) {
    throw new DomainError('TARGET_SETTLED', 'This Run no longer accepts input.', 409)
  }
  if (context.target.kind === 'workflow_execution') {
    if (context.accepted) throw new DomainError('TARGET_SETTLED', 'This exact logical work has already been accepted.', 409)
    const directionSource = (await context.sql.query('select 1 from run_hierarchy_direction_waits where run_id=$1 and source_execution_id=$2',
      [context.run.id,context.target.execution.executionId])).rowCount
    if (directionSource) throw new DomainError('TARGET_SETTLED', 'The source execution is closed. Select its recorded direction continuation explicitly.', 409)
    const disposition = await readWorkflowControlDispositionLocked(context.sql, context.run.id, context.target.execution.executionId)
    if (disposition.kind === 'superseded' && ['admitted','failed','canceled'].includes(disposition.continuation.state)) {
      throw new DomainError('TARGET_SETTLED', 'The selected execution has been superseded. Its recorded target and evidence remain unchanged.', 409)
    }
    if (disposition.kind !== 'ordinary') throw new DomainError(disposition.kind === 'stopping' ? 'TARGET_SETTLING' : 'TARGET_CHANGING',
      'A recorded control command already owns this work boundary.', 409)
  } else {
    const stopping = (await context.sql.query<{ id: string }>(`select id from run_chat_commands
      where run_id=$1 and target_key=$2 and kind='stop' and state in ('recorded','settling','unknown') limit 1`,
    [context.run.id, controlDigest(context.target)])).rows[0]
    const active = await readCoordinatorConsultationLocked(context.sql, context.run.id, context.target.waitingActivationId)
    if (stopping || active?.state === 'settling' || active?.state === 'unknown') {
      throw new DomainError('TARGET_SETTLING', 'This consultation is settling its current reply.', 409)
    }
  }
  if (context.state === 'settling') throw new DomainError('TARGET_SETTLING', 'This exact target is settling its current turn.', 409)
}

function appliedIntent(context: WorkflowChatLockedTarget, request: ChatSendRequest) {
  const native = context.native
  if (request.expectedNativeTurnId && request.expectedNativeTurnId !== native?.nativeTurnId) {
    throw new DomainError('TARGET_CHANGED', 'The expected native turn is no longer active.', 409)
  }
  const canSteer = context.state === 'active' && native?.steer && !!native.nativeTurnId
    && !request.attachments.length && (!request.sessionMode || request.sessionMode === native.sessionMode)
  if (request.intent === 'auto') return canSteer ? 'steer' as const : 'next_turn' as const
  if (request.intent === 'steer' && !canSteer) throw new DomainError('STEER_UNAVAILABLE',
    'This exact turn cannot accept uninterrupted text in the requested mode. Choose next turn or interrupt and send.', 409)
  if (request.intent === 'interrupt_and_send' && (!native?.interruptAndSend || context.state !== 'active'
    || !(native.nativeTurnId || native.inputMessageId))) throw new DomainError('INTERRUPT_CONTINUATION_UNAVAILABLE',
    'This exact active native owner cannot qualify interrupt and send.', 409)
  return request.intent
}

export async function qualifyWorkflowChatSendLocked(context: WorkflowChatLockedTarget, request: ChatSendRequest,
  identity: { id: string; principalId: string; channelContext?: string }, owner: WorkflowChatOwnerPort) {
  await assertSendable(context)
  const applied = appliedIntent(context, request)
  const prepared = await owner.validateAdmission(context, request, { ...identity, appliedIntent: applied })
  return { appliedIntent: applied, nativePrompt: prepared.nativePrompt }
}

export async function admitWorkflowChatSendLocked(context: WorkflowChatLockedTarget, request: ChatSendRequest,
  identity: AdmissionIdentity, owner: WorkflowChatOwnerPort) {
  await assertSendable(context)
  const applied = appliedIntent(context, request)
  const prepared = await owner.validateAdmission(context, request, { ...identity, appliedIntent: applied })
  const operation = applied === 'steer' ? 'steer' : applied === 'interrupt_and_send' ? 'interrupt'
    : context.target.kind === 'workflow_coordinator' ? 'consultation' : 'input'
  const receipt = ChatDeliveryReceiptSchema.parse({ id: identity.id, commandId: identity.commandId,
    target: context.target, requestedIntent: request.intent, appliedIntent: applied,
    state: applied === 'next_turn' ? 'queued' : 'submitting',
    ...(request.sourcePostId ? { postId: request.sourcePostId } : {}),
    createdAt: identity.now, updatedAt: identity.now })
  await insertControlCommand(context, { ...identity, digest: controlDigest({ kind: 'delivery', request }),
    request, kind: 'delivery', operation, receipt, nativePrompt: prepared.nativePrompt })
  if (context.target.kind === 'workflow_coordinator') {
    if (applied === 'steer') {
      const active = await readCoordinatorConsultationLocked(context.sql, context.run.id, context.target.waitingActivationId)
      if (!active || active.state !== 'active') throw new DomainError('TARGET_CHANGED', 'The consultation turn changed before admission.', 409)
      const row = (await readControlCommand(context.sql, identity.id))!
      await updateControlCommand(context.sql, row, { ...receipt, consultationId: active.binding.consultationId }, identity.now,
        { consultationId: active.binding.consultationId })
    } else await reserveCoordinatorConsultationLocked(context, { commandId: identity.id,
      interruptActive: applied === 'interrupt_and_send', now: identity.now })
  } else if (applied === 'interrupt_and_send') {
    await reserveWorkflowControlContinuationLocked(context, { deliveryId: identity.id,
      controlCommandId: identity.commandId, cause: 'interrupt_and_send', now: identity.now })
  } else if (applied === 'next_turn' && context.state === 'queued') {
    // The existing queued execution is the input boundary. For held direction this
    // claims its first input and releases the already-reserved activation atomically.
    await claimWorkflowControlInputLocked(context.sql, { execution: context.target.execution, now: identity.now })
  }
  return ChatDeliveryReceiptSchema.parse((await readControlCommand(context.sql, identity.id))!.receipt)
}

async function queuedCommands(context: WorkflowChatLockedTarget, lineage = false): Promise<ControlCommandSummary[]> {
  if (lineage && context.target.kind === 'workflow_execution') {
    return (await context.sql.query<ControlCommandSummary>(`with recursive lineage(id) as (
        select $2::text union select k.previous_execution_id from run_control_continuations k
        join lineage l on l.id=k.successor_execution_id where k.run_id=$1 and k.successor_execution_id is not null
      ) select ${CONTROL_COMMAND_SUMMARY_COLUMNS} from run_chat_commands c where c.run_id=$1
        and c.kind='delivery' and c.state='queued' and c.target->>'kind'='workflow_execution'
        and c.target #>> '{execution,executionId}' in (select id from lineage) order by c.sequence for update of c`,
    [context.run.id,context.target.execution.executionId])).rows
  }
  return (await context.sql.query<ControlCommandSummary>(`select ${CONTROL_COMMAND_SUMMARY_COLUMNS} from run_chat_commands
    where run_id=$1 and target_key=$2 and kind='delivery' and state='queued' order by sequence for update`,
  [context.run.id, controlDigest(context.target)])).rows
}
async function cancelDelivery(context: WorkflowChatLockedTarget, row: ControlCommandSummary, now: string) {
  await updateControlCommand(context.sql, row, { ...ChatDeliveryReceiptSchema.parse(row.receipt), state: 'canceled', updatedAt: now }, now)
}

export async function admitWorkflowChatCancelLocked(context: WorkflowChatLockedTarget, request: ChatQueueCancelRequest,
  identity: AdmissionIdentity): Promise<ChatControlReceipt> {
  const selected = request.selection.kind === 'one'
    ? [await readControlCommand(context.sql, request.selection.receiptId)].filter((row): row is ControlCommandRow => !!row)
    : await queuedCommands(context)
  if (selected.some(row => row.kind !== 'delivery' || canonicalJson(row.target) !== canonicalJson(context.target))) {
    throw new DomainError('CHAT_RECEIPT_TARGET_MISMATCH', 'The receipt does not belong to this exact selected target.', 409)
  }
  if (request.selection.kind === 'one' && !selected.length) throw new DomainError('CHAT_RECEIPT_NOT_FOUND', 'The selected receipt is unavailable.', 404)
  const claimed = selected.find(row => ['submitting', 'accepted', 'unknown'].includes(row.state))
  if (!claimed) for (const row of selected) if (row.state === 'queued') await cancelDelivery(context, row, identity.now)
  const receipt = ChatControlReceiptSchema.parse({ commandId: identity.commandId, target: context.target,
    operation: request.selection.kind === 'one' ? 'cancel_one' : 'cancel_all_queued',
    state: claimed ? 'failed' : 'completed', affectedReceiptIds: selected.map(row => row.id), replayed: false,
    ...(claimed ? { errorCode: 'DELIVERY_ALREADY_SUBMITTING' } : {}) })
  await insertControlCommand(context, { ...identity, digest: controlDigest({ kind: 'cancel', request }), request,
    kind: 'cancel', operation: 'cancel', receipt })
  return receipt
}

export async function admitWorkflowChatStopLocked(context: WorkflowChatLockedTarget, request: ChatStopRequest,
  identity: AdmissionIdentity): Promise<ChatControlReceipt> {
  await assertSendable(context)
  if (request.expectedNativeTurnId && request.expectedNativeTurnId !== context.native?.nativeTurnId) {
    throw new DomainError('TARGET_CHANGED', 'The expected native turn is no longer active.', 409)
  }
  const queued = await queuedCommands(context, true)
  const active = context.state === 'active' && !!context.native
    && !!(context.native.nativeTurnId || context.native.inputMessageId)
  if (request.scope === 'active_and_queued') for (const row of queued) await cancelDelivery(context, row, identity.now)
  const receipt = ChatControlReceiptSchema.parse({ commandId: identity.commandId, target: context.target,
    operation: request.scope === 'active_turn' ? 'stop_active' : 'stop_active_and_queued',
    state: active ? 'settling' : 'completed', replayed: false,
    affectedReceiptIds: request.scope === 'active_and_queued' ? queued.map(row => row.id) : [],
    ...(!active ? { errorCode: 'NO_ACTIVE_TURN' } : {}) })
  await insertControlCommand(context, { ...identity, digest: controlDigest({ kind: 'stop', request }), request,
    kind: 'stop', operation: 'stop', receipt })
  if (!active) return receipt
  const next = request.scope === 'active_turn' ? queued[0] : undefined
  if (context.target.kind === 'workflow_coordinator') {
    const consultation = await stopCoordinatorConsultationLocked(context, { nextCommandId: next?.id, now: identity.now })
    receipt.consultationId = consultation.consultationId
    if (next) receipt.affectedReceiptIds = [next.id]
  } else if (next) {
    const reserved = await reserveWorkflowControlContinuationLocked(context, { deliveryId: next.id,
      controlCommandId: identity.commandId, cause: 'stop_with_queued', now: identity.now })
    receipt.continuationId = reserved.continuation.id
    receipt.affectedReceiptIds = [next.id]
  }
  await updateControlCommand(context.sql, (await readControlCommand(context.sql, identity.id))!, receipt, identity.now,
    { ...(receipt.continuationId ? { continuationId: receipt.continuationId } : {}),
      ...(receipt.consultationId ? { consultationId: receipt.consultationId } : {}) })
  return receipt
}
