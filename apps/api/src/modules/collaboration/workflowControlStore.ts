import {
  canonicalJson, ChatControlReceiptSchema, ChatDeliveryReceiptSchema, ChatSendRequestSchema, ExecutionRefSchema,
  HarnessExecutionSchema, LogicalWorkRefSchema, WorkflowControlContinuationSchema,
  sameExecution, sameLogicalWork, type ExecutionRef, type WorkflowControlContinuation,
} from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { assertGraphTransaction, type GraphTransactionSql } from '../run-graph/connection.js'
import { releaseHierarchyDirectionLocked } from '../runs/hierarchyDirection.js'
import { assertWorkflowExecutionCapacityLocked } from '../runs/workflowExecutionBudget.js'
import {
  CONTROL_COMMAND_COLUMNS, CONTROL_COMMAND_SUMMARY_COLUMNS, commandReceipt, controlId, readControlCommand,
  updateControlCommand, type ControlCommandRow, type ControlCommandSummary,
} from './workflowControlRecords.js'
import type { WorkflowChatLockedTarget, WorkflowQueuedInput } from './workflowControlTypes.js'
export { readWorkflowControlDispositionLocked } from './workflowControlDisposition.js'
export { closeWorkflowControlInputLocked } from './workflowControlQueue.js'

interface ContinuationRow { record: unknown; reserved_successor_execution_id: string; delivery_id: string }

export async function reserveWorkflowControlContinuationLocked(context: WorkflowChatLockedTarget,
  input: { deliveryId: string; controlCommandId: string; cause: WorkflowControlContinuation['cause']; now: string }) {
  assertGraphTransaction(context.sql)
  if (context.target.kind !== 'workflow_execution' || !context.work || !context.execution || !context.native
    || !context.native.interruptAndSend || !(context.native.nativeTurnId || context.native.inputMessageId)) {
    throw new DomainError('INTERRUPT_CONTINUATION_UNAVAILABLE', 'This native owner cannot qualify a same-work continuation.', 409)
  }
  const persisted = (await context.sql.query<{ accepted: boolean; record: unknown }>(
    'select accepted,record from harness_executions where id=$1 and run_id=$2 for update',
    [context.target.execution.executionId,context.run.id])).rows[0]
  if (!persisted || persisted.accepted || HarnessExecutionSchema.parse(persisted.record).state === 'completed') {
    throw new DomainError('TARGET_SETTLED', 'The selected execution has already published its terminal result.', 409)
  }
  const existing = (await context.sql.query<ContinuationRow>(`select record,reserved_successor_execution_id,delivery_id
    from run_control_continuations where run_id=$1 and work=$2::jsonb and state in ('reserved','waiting_settlement','unknown')`,
  [context.run.id,canonicalJson(context.work)])).rows[0]
  if (existing) throw new DomainError('TARGET_CHANGING', 'A control command already owns this work boundary.', 409)
  const command = await readControlCommand(context.sql,input.deliveryId)
  if (!command || command.kind !== 'delivery') throw new DomainError('CONTROL_RECEIPT_CONFLICT', 'The reserved delivery is missing.', 409)
  await assertWorkflowExecutionCapacityLocked(context.sql, context.run.id, context.version)
  const continuation = WorkflowControlContinuationSchema.parse({
    id: controlId('continuation',context.run.id,input.deliveryId), controlCommandId: input.controlCommandId,
    deliveryReceiptId: input.deliveryId, work: context.work, previousExecution: context.target.execution,
    nativeTarget: { nativeSessionId: context.native.nativeSessionId,ownerRequestId: context.native.ownerRequestId,
      ...(context.native.nativeTurnId ? { nativeTurnId: context.native.nativeTurnId } : {}),
      ...(context.native.inputMessageId ? { inputMessageId: context.native.inputMessageId } : {}) },
    cause: input.cause,state: 'reserved',successorExecution: null,errorCode: null,createdAt: input.now,updatedAt: input.now,
  })
  const successorId = controlId('control-execution',continuation.id)
  await context.sql.query(`insert into run_control_continuations
    (id,run_id,workflow_version_id,previous_execution_id,work,delivery_id,reserved_successor_execution_id,state,record)
    values($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb)`,
  [continuation.id,context.run.id,context.version.id,continuation.previousExecution.executionId,
    canonicalJson(continuation.work),input.deliveryId,successorId,continuation.state,canonicalJson(continuation)])
  const receipt = ChatDeliveryReceiptSchema.parse(command.receipt)
  await updateControlCommand(context.sql,command,{ ...receipt,state: 'submitting',continuationId: continuation.id,
    updatedAt: input.now },input.now,{ continuationId: continuation.id })
  return { continuation,reservedSuccessorExecutionId: successorId }
}

/** B invokes only after its existing native closure proof and input.bind, in the
 * SAME owner transaction. The successor's identity is checked against persisted slots. */
export async function completeWorkflowControlContinuationLocked(sql: GraphTransactionSql, input: {
  runId: string; continuationId: string; successorExecution: ExecutionRef; now: string
}): Promise<WorkflowControlContinuation> {
  assertGraphTransaction(sql)
  const row = (await sql.query<ContinuationRow>(`select record,reserved_successor_execution_id,delivery_id
    from run_control_continuations where run_id=$1 and id=$2 for update`,[input.runId,input.continuationId])).rows[0]
  if (!row) throw new DomainError('CONTROL_CONTINUATION_MISSING','The continuation was not reserved.',409)
  const before = WorkflowControlContinuationSchema.parse(row.record)
  if (before.state === 'admitted') {
    if (!sameExecution(before.successorExecution!,input.successorExecution)) throw new DomainError('CONTROL_SUCCESSOR_CONFLICT','This continuation already admitted another execution.',409)
    return before
  }
  if (!['reserved','waiting_settlement','unknown'].includes(before.state)) throw new DomainError('CONTROL_CONTINUATION_CLOSED','This continuation no longer admits work.',409)
  if (input.successorExecution.executionId !== row.reserved_successor_execution_id) throw new DomainError('CONTROL_SUCCESSOR_CONFLICT','Use the reserved successor identity.',409)
  const stopped = (await sql.query<{ stopped: boolean }>('select stop_requested_at is not null as stopped from runs where id=$1',[input.runId])).rows[0]
  if (!stopped || stopped.stopped) throw new DomainError('TARGET_SETTLED','Stop Run already owns this work.',409)
  const source = (await sql.query<{ record: unknown; accepted: boolean }>(
    'select record,accepted from harness_executions where id=$1 and run_id=$2', [before.previousExecution.executionId,input.runId])).rows[0]
  const successor = (await sql.query<{ record: unknown; slot_id: string; work_activation_id: string | null }>(
    `select e.record,s.slot_id,s.work_activation_id from harness_executions e
      join run_repeat_executions x on x.execution_id=e.id and x.run_id=e.run_id
      join run_repeat_slots s on s.slot_id=x.slot_id and s.run_id=e.run_id where e.id=$1 and e.run_id=$2`,
    [input.successorExecution.executionId,input.runId])).rows[0]
  if (!source || source.accepted || !successor) throw new DomainError('CONTROL_SUCCESSOR_CONFLICT','The native evidence and exact bound successor are required.',409)
  const oldExecution = HarnessExecutionSchema.parse(source.record), nextExecution = HarnessExecutionSchema.parse(successor.record)
  const work = LogicalWorkRefSchema.parse(successor.work_activation_id
    ? { kind:'activation',runId:input.runId,workflowVersionId:input.successorExecution.workflowVersionId,activationId:successor.work_activation_id }
    : { kind:'slot',runId:input.runId,workflowVersionId:input.successorExecution.workflowVersionId,slotId:successor.slot_id })
  if (!sameLogicalWork(work,before.work) || nextExecution.workflowNodeId !== oldExecution.workflowNodeId
    || nextExecution.agentId !== oldExecution.agentId || nextExecution.agentConfigurationVersionId !== oldExecution.agentConfigurationVersionId
    || nextExecution.attempt !== input.successorExecution.attempt || oldExecution.state !== 'completed') {
    throw new DomainError('CONTROL_SUCCESSOR_CONFLICT','A successor must retain the same pinned logical work and settled native predecessor.',409)
  }
  const after = WorkflowControlContinuationSchema.parse({ ...before,state:'admitted',successorExecution:input.successorExecution,updatedAt:input.now })
  await sql.query(`update run_control_continuations set state='admitted',record=$3::jsonb,successor_execution_id=$4,native_evidence=$5::jsonb
    where run_id=$1 and id=$2`,[input.runId,input.continuationId,canonicalJson(after),input.successorExecution.executionId,canonicalJson(oldExecution)])
  const command = (await readControlCommand(sql,row.delivery_id))!
  const receipt = ChatDeliveryReceiptSchema.parse(command.receipt)
  await updateControlCommand(sql,command,{ ...receipt,state:'submitting',continuationExecution:input.successorExecution,
    updatedAt:input.now },input.now,{ deliveredExecution:input.successorExecution })
  const controls = (await sql.query<ControlCommandSummary>(`select ${CONTROL_COMMAND_SUMMARY_COLUMNS} from run_chat_commands
    where run_id=$1 and continuation_id=$2 and kind='stop' and state not in ('completed','failed','canceled')`,
  [input.runId,input.continuationId])).rows
  for (const control of controls) await updateControlCommand(sql,control,{...ChatControlReceiptSchema.parse(control.receipt),
    state:'completed',continuationExecution:input.successorExecution},input.now)
  return after
}

export async function failWorkflowControlContinuationLocked(sql: GraphTransactionSql,
  input: { runId:string; continuationId:string; errorCode:string; now:string }): Promise<void> {
  assertGraphTransaction(sql)
  const row = (await sql.query<ContinuationRow>(`select record,reserved_successor_execution_id,delivery_id
    from run_control_continuations where run_id=$1 and id=$2 for update`,[input.runId,input.continuationId])).rows[0]
  if (!row) return
  const before = WorkflowControlContinuationSchema.parse(row.record)
  if (['failed','canceled'].includes(before.state)) return
  // A bound successor may still fail preparation. Keep its immutable DB/receipt
  // lineage while the canonical failed continuation has no admitted successor.
  const after = WorkflowControlContinuationSchema.parse({ ...before,state:'failed',successorExecution:null,
    errorCode:input.errorCode,updatedAt:input.now })
  await sql.query('update run_control_continuations set state=$3,record=$4::jsonb where run_id=$1 and id=$2',
    [input.runId,input.continuationId,after.state,canonicalJson(after)])
  const command = await readControlCommand(sql,row.delivery_id)
  if (command) await failDelivery(sql,command,input.errorCode,input.now)
  const controls = (await sql.query<ControlCommandSummary>(`select ${CONTROL_COMMAND_SUMMARY_COLUMNS} from run_chat_commands
    where run_id=$1 and continuation_id=$2 and kind='stop' and state not in ('completed','failed','canceled')`,
  [input.runId,input.continuationId])).rows
  for (const control of controls) await updateControlCommand(sql,control,{...ChatControlReceiptSchema.parse(control.receipt),
    state:'failed',errorCode:input.errorCode},input.now)
}

async function failDelivery(sql:GraphTransactionSql,row:ControlCommandSummary,errorCode:string,now:string) {
  if (['completed','failed','canceled'].includes(row.state)) return
  const receipt = ChatDeliveryReceiptSchema.parse(row.receipt)
  await updateControlCommand(sql,row,{ ...receipt,state:'failed',errorCode,updatedAt:now },now)
}

/** Claim one input at an existing input boundary. Repeat of a claimed boundary
 * returns the identical request; B uses commandId for native idempotency. */
export async function claimWorkflowControlInputLocked(sql:GraphTransactionSql,
  input:{execution:ExecutionRef;now:string;claimNew?:boolean}):Promise<WorkflowQueuedInput | undefined> {
  assertGraphTransaction(sql)
  const ref=ExecutionRefSchema.parse(input.execution)
  const retained=(await sql.query<ControlCommandRow>(`select ${CONTROL_COMMAND_COLUMNS} from run_chat_commands
    where run_id=$1 and kind='delivery' and delivered_execution->>'executionId'=$2
      and state in ('submitting','accepted','unknown') order by sequence limit 1`,[ref.runId,ref.executionId])).rows[0]
  if(retained) return queuedInput(retained,ref)
  if(input.claimNew===false) return undefined
  const row=(await sql.query<ControlCommandRow>(`with recursive lineage(id) as (
      select $2::text union select k.previous_execution_id from run_control_continuations k
      join lineage l on l.id=k.successor_execution_id where k.run_id=$1 and k.successor_execution_id is not null
    ) select ${CONTROL_COMMAND_COLUMNS} from run_chat_commands c
    where c.run_id=$1 and c.kind='delivery' and c.state='queued' and c.target->>'kind'='workflow_execution'
      and c.target #>> '{execution,executionId}' in (select id from lineage)
    order by c.sequence limit 1 for update of c`,[ref.runId,ref.executionId])).rows[0]
  if(!row) return undefined
  const receipt=ChatDeliveryReceiptSchema.parse(row.receipt)
  await updateControlCommand(sql,row,{...receipt,state:'submitting',updatedAt:input.now},input.now,{deliveredExecution:ref})
  await releaseHierarchyDirectionLocked(sql,{runId:ref.runId,executionId:ref.executionId,receiptId:row.id})
  return queuedInput(row,ref)
}
function queuedInput(row:ControlCommandRow,execution:ExecutionRef):WorkflowQueuedInput {
  return {receiptId:row.id,commandId:row.id,originalTarget:ChatDeliveryReceiptSchema.parse(row.receipt).target as WorkflowQueuedInput['originalTarget'],
    deliveredExecution:execution,request:ChatSendRequestSchema.parse(row.request),
    ...(row.native_prompt !== null ? {nativePrompt:row.native_prompt} : {})}
}

/** Existing Stop Run calls this under its owner lock before descendant cleanup. */
export async function cancelWorkflowControlsLocked(sql:GraphTransactionSql,runId:string,now:string):Promise<void> {
  assertGraphTransaction(sql)
  const pending = new Set((await sql.query<{id:string}>(`select id from run_control_continuations
    where run_id=$1 and state in ('reserved','waiting_settlement','unknown')`,[runId])).rows.map(row=>row.id))
  const reserved = new Set((await sql.query<{id:string}>(`select reserved_next_consultation_id as id from run_coordinator_mailboxes
    where run_id=$1 and reserved_next_consultation_id is not null`,[runId])).rows.map(row=>row.id))
  const capturedConsultations = new Set((await sql.query<{id:string}>(`select id from run_coordinator_consultations
    where run_id=$1 and native_target is not null and state not in ('completed','failed','canceled')`,[runId])).rows.map(row=>row.id))
  const rows=(await sql.query<ControlCommandSummary>(`select ${CONTROL_COMMAND_SUMMARY_COLUMNS} from run_chat_commands
    where run_id=$1 and state not in ('completed','failed','canceled') order by sequence`,[runId])).rows
  for(const row of rows) {
    const receipt=commandReceipt(row)
    if(row.kind==='delivery') {
      const needsClosure = (!!row.native_target || !!row.consultation_id && capturedConsultations.has(row.consultation_id))
        && !(row.continuation_id && pending.has(row.continuation_id))
        && !(row.consultation_id && reserved.has(row.consultation_id))
      await updateControlCommand(sql,row,{...ChatDeliveryReceiptSchema.parse(receipt),state:needsClosure?'unknown':'canceled',
        errorCode:needsClosure?'RUN_STOPPING':'RUN_STOPPED',updatedAt:now},now)
    } else await updateControlCommand(sql,row,{...ChatControlReceiptSchema.parse(receipt),
      state:row.kind==='stop'?'settling':'completed',errorCode:'RUN_STOPPED'},now)
  }
  const continuations=(await sql.query<{id:string;record:unknown}>(`select id,record from run_control_continuations
    where run_id=$1 and state in ('reserved','waiting_settlement','unknown')`,[runId])).rows
  for(const row of continuations) {
    const record=WorkflowControlContinuationSchema.parse({...WorkflowControlContinuationSchema.parse(row.record),state:'canceled',errorCode:'RUN_STOPPED',updatedAt:now})
    await sql.query("update run_control_continuations set state='canceled',record=$3::jsonb where run_id=$1 and id=$2",[runId,row.id,canonicalJson(record)])
  }
  await sql.query("update run_coordinator_consultations set state='canceled',updated_at=$2 where run_id=$1 and state='admitted' and (native_target is null or id=any($3::text[]))",
    [runId,now,[...reserved]])
  await sql.query("update run_coordinator_mailboxes set state='canceled',active_consultation_id=null,reserved_next_consultation_id=null where run_id=$1 and state not in ('graph','canceled')",[runId])
  // Active native replies still require B's real settlement and cleanup proof.
  await sql.query("update run_coordinator_consultations set state='settling',updated_at=$2 where run_id=$1 and state in ('admitted','active','unknown')",[runId,now])
}
