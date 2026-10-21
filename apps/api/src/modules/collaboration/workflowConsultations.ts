import {
  AgentIdentitySchema, canonicalJson, ChatControlReceiptSchema, ChatDeliveryReceiptSchema, ChatSendRequestSchema,
  CoordinatorConsultationBindingSchema, ExecutionRefSchema,
  type CoordinatorConsultationBinding,
} from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { assertGraphTransaction, type GraphTransactionSql } from '../run-graph/connection.js'
import { CONTROL_COMMAND_COLUMNS, CONTROL_COMMAND_SUMMARY_COLUMNS, controlId, readControlCommand, updateControlCommand,
  type ControlCommandRow, type ControlCommandSummary } from './workflowControlRecords.js'
import type { WorkflowChatLockedTarget, WorkflowChatNativeTarget, WorkflowConsultationAdmission,
  WorkflowConsultationSettlementEvidence } from './workflowControlTypes.js'

interface MailboxRow {
  run_id:string;waiting_activation_id:string;group_id:string;workflow_version_id:string;workflow_node_id:string
  native_session_id:string;agent:unknown;source_execution:unknown;state:'idle'|'consultation'|'graph'|'canceled'
  active_consultation_id:string|null;reserved_next_consultation_id:string|null
}
interface ConsultationRow { id:string;binding:unknown;state:string;command_id:string;
  native_target:WorkflowChatNativeTarget|null;native_turn_id:string|null;native_evidence:unknown }

async function mailbox(sql:GraphTransactionSql,runId:string,waitingActivationId:string) {
  return (await sql.query<MailboxRow>('select * from run_coordinator_mailboxes where run_id=$1 and waiting_activation_id=$2 for update',
    [runId,waitingActivationId])).rows[0]
}
async function ensureMailbox(context:WorkflowChatLockedTarget):Promise<MailboxRow> {
  if(context.target.kind!=='workflow_coordinator'||!context.waiting||context.agent.productRole==='coder') {
    throw new DomainError('COORDINATOR_UNAVAILABLE','A real waiting coordinator and retained native session are required.',409)
  }
  const waiting=context.waiting
  const group=(await context.sql.query<{state:string;parent_node_id:string;parent_activation_id:string;parent_execution_id:string}>(
    'select state,parent_node_id,parent_activation_id,parent_execution_id from run_hierarchy_groups where run_id=$1 and group_id=$2',
    [context.run.id,waiting.delegationGroupId])).rows[0]
  if(!group||['continued','canceled'].includes(group.state)||group.parent_activation_id!==waiting.waitingActivationId
    ||group.parent_node_id!==context.agent.workflowNodeId||group.parent_execution_id!==waiting.sourceExecution.executionId) {
    throw new DomainError('TARGET_SETTLED','The selected waiting barrier no longer owns this coordinator.',409)
  }
  await context.sql.query(`insert into run_coordinator_mailboxes
    (run_id,waiting_activation_id,group_id,workflow_version_id,workflow_node_id,native_session_id,agent,source_execution,state)
    values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,'idle') on conflict(run_id,waiting_activation_id) do nothing`,
  [context.run.id,waiting.waitingActivationId,waiting.delegationGroupId,context.version.id,context.agent.workflowNodeId,
    waiting.nativeSessionId,canonicalJson(context.agent),canonicalJson(waiting.sourceExecution)])
  const row=(await mailbox(context.sql,context.run.id,waiting.waitingActivationId))!
  if(row.group_id!==waiting.delegationGroupId||row.native_session_id!==waiting.nativeSessionId
    ||canonicalJson(row.agent)!==canonicalJson(context.agent)||canonicalJson(row.source_execution)!==canonicalJson(waiting.sourceExecution)) {
    throw new DomainError('COORDINATOR_BINDING_CONFLICT','The retained coordinator identity changed.',409)
  }
  return row
}

/** A reply reserves only this mailbox. It never reserves a graph activation. */
export async function reserveCoordinatorConsultationLocked(context:WorkflowChatLockedTarget,input:{
  commandId:string;interruptActive?:boolean;now:string
}):Promise<WorkflowConsultationAdmission|undefined> {
  assertGraphTransaction(context.sql)
  const row=await ensureMailbox(context)
  if(row.state==='graph'||row.state==='canceled') throw new DomainError('TARGET_SETTLED','The graph continuation already owns this boundary.',409)
  if(row.state==='consultation'&&!input.interruptActive) return undefined
  if(row.reserved_next_consultation_id) throw new DomainError('TARGET_CHANGING','A next consultation already owns this reply boundary.',409)
  const command=await readControlCommand(context.sql,input.commandId)
  if(!command||command.kind!=='delivery') throw new DomainError('CONTROL_RECEIPT_CONFLICT','The consultation input is not durably admitted.',409)
  if(row.state==='idle') {
    const ready=(await context.sql.query<{state:string}>('select state from run_hierarchy_groups where run_id=$1 and group_id=$2',
      [row.run_id,row.group_id])).rows[0]
    if(ready?.state!=='waiting') throw new DomainError('TARGET_SETTLED','The ready graph continuation owns the next turn.',409)
  }
  const admitted=await createConsultation(context.sql,row,command,input.now)
  if(row.state==='consultation') {
    await context.sql.query(`update run_coordinator_mailboxes set reserved_next_consultation_id=$3
      where run_id=$1 and waiting_activation_id=$2`,[row.run_id,row.waiting_activation_id,admitted.binding.consultationId])
    await context.sql.query("update run_coordinator_consultations set state='settling',updated_at=$2 where id=$1 and state not in ('completed','failed','canceled')",
      [row.active_consultation_id,input.now])
  } else await context.sql.query(`update run_coordinator_mailboxes set state='consultation',active_consultation_id=$3
    where run_id=$1 and waiting_activation_id=$2`,[row.run_id,row.waiting_activation_id,admitted.binding.consultationId])
  return admitted
}

async function createConsultation(sql:GraphTransactionSql,row:MailboxRow,command:ControlCommandRow,now:string):Promise<WorkflowConsultationAdmission> {
  const binding=CoordinatorConsultationBindingSchema.parse({runId:row.run_id,workflowVersionId:row.workflow_version_id,
    waitingActivationId:row.waiting_activation_id,delegationGroupId:row.group_id,
    consultationId:controlId('consultation',row.run_id,command.id),nativeSessionId:row.native_session_id,purpose:'consultation'})
  await sql.query(`insert into run_coordinator_consultations(id,run_id,waiting_activation_id,command_id,binding,state,created_at,updated_at)
    values($1,$2,$3,$4,$5::jsonb,'admitted',$6,$6)`,[binding.consultationId,row.run_id,row.waiting_activation_id,command.id,canonicalJson(binding),now])
  const receipt=ChatDeliveryReceiptSchema.parse(command.receipt)
  await updateControlCommand(sql,command,{...receipt,state:'submitting',consultationId:binding.consultationId,updatedAt:now},now,
    {consultationId:binding.consultationId})
  return {binding,agent:AgentIdentitySchema.parse(row.agent),commandId:command.id,
    request:ChatSendRequestSchema.parse(command.request),sourceExecution:ExecutionRefSchema.parse(row.source_execution),
    ...(command.native_prompt !== null ? {nativePrompt:command.native_prompt} : {})}
}

export async function readCoordinatorConsultationLocked(sql:GraphTransactionSql,runId:string,waitingActivationId:string) {
  assertGraphTransaction(sql)
  const row=await mailbox(sql,runId,waitingActivationId)
  if(!row||!row.active_consultation_id) return undefined
  const turn=(await sql.query<ConsultationRow>('select * from run_coordinator_consultations where id=$1 and run_id=$2',
    [row.active_consultation_id,runId])).rows[0]
  return turn?{binding:CoordinatorConsultationBindingSchema.parse(turn.binding),state:turn.state,
    commandId:turn.command_id,nativeTurnId:turn.native_turn_id,nativeTarget:turn.native_target,
    sourceExecution:ExecutionRefSchema.parse(row.source_execution)}:undefined
}

/** The delivery command may target the interrupted old reply. Its next
 * consultation has this separate immutable writer capture before native I/O. */
export async function captureCoordinatorConsultationNativeLocked(sql:GraphTransactionSql,input:{
  binding:CoordinatorConsultationBinding;nativeTarget:WorkflowChatNativeTarget;now:string
}):Promise<void> {
  assertGraphTransaction(sql)
  const binding=CoordinatorConsultationBindingSchema.parse(input.binding)
  const row=await mailbox(sql,binding.runId,binding.waitingActivationId)
  const turn=(await sql.query<ConsultationRow>('select * from run_coordinator_consultations where id=$1 and run_id=$2 for update',
    [binding.consultationId,binding.runId])).rows[0]
  if(!row||!turn||row.state!=='consultation'||row.active_consultation_id!==binding.consultationId
    ||canonicalJson(turn.binding)!==canonicalJson(binding)||!['admitted','active','unknown'].includes(turn.state)
    ||input.nativeTarget.nativeSessionId!==binding.nativeSessionId) {
    throw new DomainError('COORDINATOR_BINDING_CONFLICT','This consultation no longer owns the native mailbox.',409)
  }
  if(!input.nativeTarget.nativeSessionId||!input.nativeTarget.ownerRequestId) {
    throw new DomainError('NATIVE_IDENTITY_REQUIRED','Capture the real consultation session and request correlation before native I/O.',409)
  }
  if(turn.native_target) {
    if(canonicalJson(turn.native_target)!==canonicalJson(input.nativeTarget)) {
      throw new DomainError('NATIVE_IDENTITY_CONFLICT','The consultation already captured another writer.',409)
    }
    return
  }
  await sql.query('update run_coordinator_consultations set native_target=$2::jsonb,updated_at=$3 where id=$1',
    [binding.consultationId,canonicalJson(input.nativeTarget),input.now])
}

/** Stop only this reply. A queued successor is reserved before the interrupt and
 * remains distinct from the graph continuation, even if children finish now. */
export async function stopCoordinatorConsultationLocked(context: WorkflowChatLockedTarget, input: {
  nextCommandId?: string | undefined; now: string
}): Promise<CoordinatorConsultationBinding> {
  if (context.target.kind !== 'workflow_coordinator') throw new DomainError('COORDINATOR_UNAVAILABLE', 'Select a coordinator reply.', 409)
  const active = await readCoordinatorConsultationLocked(context.sql, context.run.id, context.target.waitingActivationId)
  if (!active || active.state !== 'active') throw new DomainError('TARGET_CHANGED', 'The consultation is no longer active.', 409)
  if (input.nextCommandId) await reserveCoordinatorConsultationLocked(context,
    { commandId: input.nextCommandId, interruptActive: true, now: input.now })
  else await context.sql.query("update run_coordinator_consultations set state='settling',updated_at=$2 where id=$1",
    [active.binding.consultationId, input.now])
  return active.binding
}

/** B calls from its qualified original-session admission/observation. */
export async function bindCoordinatorConsultationNativeLocked(sql:GraphTransactionSql,input:{
  binding:CoordinatorConsultationBinding;nativeTarget:WorkflowChatNativeTarget;now:string
}):Promise<void> {
  assertGraphTransaction(sql)
  const binding=CoordinatorConsultationBindingSchema.parse(input.binding)
  const row=await mailbox(sql,binding.runId,binding.waitingActivationId)
  const turn=(await sql.query<ConsultationRow>('select * from run_coordinator_consultations where id=$1',[binding.consultationId])).rows[0]
  if(!row||!turn||row.native_session_id!==input.nativeTarget.nativeSessionId
    ||canonicalJson(turn.binding)!==canonicalJson(binding)) throw new DomainError('COORDINATOR_BINDING_CONFLICT','The consultation binding changed.',409)
  const captured=turn.native_target
  if(!captured||captured.nativeSessionId!==input.nativeTarget.nativeSessionId
    ||captured.ownerRequestId!==input.nativeTarget.ownerRequestId
    ||captured.inputMessageId&&captured.inputMessageId!==input.nativeTarget.inputMessageId
    ||captured.nativeTurnId&&captured.nativeTurnId!==input.nativeTarget.nativeTurnId
    ||turn.native_turn_id&&turn.native_turn_id!==input.nativeTarget.nativeTurnId) {
    throw new DomainError('NATIVE_IDENTITY_CONFLICT','The acknowledgement does not belong to the captured consultation writer.',409)
  }
  if(['completed','failed','canceled'].includes(turn.state)) return
  if(!(row.state==='consultation'&&row.active_consultation_id===binding.consultationId)
    &&!(row.state==='canceled'&&turn.state==='settling')) {
    throw new DomainError('COORDINATOR_BINDING_CONFLICT','This consultation does not own the native mailbox.',409)
  }
  await sql.query("update run_coordinator_consultations set state=case when state='settling' then state else 'active' end,native_turn_id=coalesce(native_turn_id,$2),updated_at=$3 where id=$1",
    [binding.consultationId,input.nativeTarget.nativeTurnId??null,input.now])
  const command=(await readControlCommand(sql,turn.command_id))!
  if (['completed','failed','canceled'].includes(command.state)) return
  const receipt=ChatDeliveryReceiptSchema.parse(command.receipt)
  await updateControlCommand(sql,command,{...receipt,state:'accepted',updatedAt:input.now,
    ...(input.nativeTarget.nativeTurnId?{nativeTurnId:input.nativeTarget.nativeTurnId}:{})},input.now)
}

/** Must run before the existing graph continuation claims native capacity. */
export async function claimWorkflowCoordinatorGraphLocked(sql:GraphTransactionSql,input:{runId:string;groupId:string;now:string}):Promise<boolean> {
  assertGraphTransaction(sql)
  const group=(await sql.query<{state:string}>('select state from run_hierarchy_groups where run_id=$1 and group_id=$2',
    [input.runId,input.groupId])).rows[0]
  if(!group||!['ready','continued'].includes(group.state)) return false
  const row=(await sql.query<MailboxRow>('select * from run_coordinator_mailboxes where run_id=$1 and group_id=$2 for update',
    [input.runId,input.groupId])).rows[0]
  if(!row) return true
  if(row.state==='consultation') return false
  if(row.state==='canceled') return false
  if(row.state==='graph') return true
  await sql.query("update run_coordinator_mailboxes set state='graph' where run_id=$1 and waiting_activation_id=$2",
    [row.run_id,row.waiting_activation_id])
  await closeConsultationQueue(sql,row,input.now)
  return true
}

/** Only an actual native settlement supplied by the existing observer may release
 * the mailbox. No graph result, parent return or F1 lifecycle is published here. */
export async function settleCoordinatorConsultationLocked(sql:GraphTransactionSql,input:{
  binding:CoordinatorConsultationBinding;outcome:'completed'|'failed'|'canceled';nativeEvidence:WorkflowConsultationSettlementEvidence;now:string
}):Promise<WorkflowConsultationAdmission|undefined> {
  assertGraphTransaction(sql)
  const binding=CoordinatorConsultationBindingSchema.parse(input.binding),row=await mailbox(sql,binding.runId,binding.waitingActivationId)
  const turn=(await sql.query<ConsultationRow>('select * from run_coordinator_consultations where id=$1 and run_id=$2 for update',
    [binding.consultationId,binding.runId])).rows[0]
  if(!row||!turn||canonicalJson(turn.binding)!==canonicalJson(binding)) throw new DomainError('COORDINATOR_BINDING_CONFLICT','The settled consultation is not the recorded owner.',409)
  if(['completed','failed','canceled'].includes(turn.state)) return undefined
  const command=(await readControlCommand(sql,turn.command_id))!
  const captured = turn.native_target, evidence = input.nativeEvidence
  if (!captured || !evidence || evidence.nativeSessionId !== captured.nativeSessionId
    || evidence.ownerRequestId !== captured.ownerRequestId
    || captured.nativeTurnId && evidence.nativeTurnId !== captured.nativeTurnId
    || captured.inputMessageId && evidence.inputMessageId !== captured.inputMessageId
    || turn.native_turn_id && evidence.nativeTurnId !== turn.native_turn_id
    || !['native_terminal','confirmed_closure'].includes(evidence.source) || !Number.isFinite(Date.parse(evidence.observedAt))
    || !evidence.payload || typeof evidence.payload !== 'object' || Array.isArray(evidence.payload)) {
    throw new DomainError('NATIVE_SETTLEMENT_REQUIRED','Only the captured writer’s positive native settlement can release this mailbox.',409)
  }
  await sql.query('update run_coordinator_consultations set state=$2,native_evidence=$3::jsonb,updated_at=$4 where id=$1',
    [binding.consultationId,input.outcome,canonicalJson(input.nativeEvidence),input.now])
  if(!['completed','failed','canceled'].includes(command.state)) await updateControlCommand(sql,command,
    {...ChatDeliveryReceiptSchema.parse(command.receipt),state:input.outcome,updatedAt:input.now,
      ...(input.outcome==='completed'?{}:{errorCode:input.outcome==='failed'?'CONSULTATION_FAILED':'CONSULTATION_CANCELED'})},input.now)
  await settleConsultationCommands(sql,binding.consultationId,input.outcome,input.now)
  return releaseConsultationMailbox(sql,row,binding,input.now)
}

/** Preparation failed before the sole owner captured or offered native input.
 * This is a proven unsubmitted reply, not a fabricated native terminal. */
export async function failCoordinatorConsultationPreparationLocked(sql:GraphTransactionSql,input:{
  binding:CoordinatorConsultationBinding;errorCode:string;now:string
}):Promise<WorkflowConsultationAdmission|undefined> {
  assertGraphTransaction(sql)
  const binding=CoordinatorConsultationBindingSchema.parse(input.binding)
  const row=await mailbox(sql,binding.runId,binding.waitingActivationId)
  const turn=(await sql.query<ConsultationRow>('select * from run_coordinator_consultations where id=$1 and run_id=$2 for update',
    [binding.consultationId,binding.runId])).rows[0]
  if(!row||!turn||canonicalJson(turn.binding)!==canonicalJson(binding)) {
    throw new DomainError('COORDINATOR_BINDING_CONFLICT','The preparation does not belong to this consultation.',409)
  }
  if(['completed','failed','canceled'].includes(turn.state)) return undefined
  if(turn.state!=='admitted'||turn.native_target||row.state!=='consultation'||row.active_consultation_id!==binding.consultationId) {
    throw new DomainError('NATIVE_SETTLEMENT_REQUIRED','A captured consultation requires positive native settlement.',409)
  }
  await sql.query("update run_coordinator_consultations set state='failed',preparation_error_code=$2,updated_at=$3 where id=$1",
    [binding.consultationId,input.errorCode,input.now])
  const command=(await readControlCommand(sql,turn.command_id))!
  if(!['completed','failed','canceled'].includes(command.state)) await updateControlCommand(sql,command,
    {...ChatDeliveryReceiptSchema.parse(command.receipt),state:'failed',errorCode:input.errorCode,updatedAt:input.now},input.now)
  return releaseConsultationMailbox(sql,row,binding,input.now)
}

async function releaseConsultationMailbox(sql:GraphTransactionSql,row:MailboxRow,
  binding:CoordinatorConsultationBinding,now:string):Promise<WorkflowConsultationAdmission|undefined> {
  if(row.state==='canceled') return undefined
  if(row.active_consultation_id!==binding.consultationId) throw new DomainError('COORDINATOR_BINDING_CONFLICT','Another consultation owns this boundary.',409)
  if(row.reserved_next_consultation_id) return promoteReservedConsultation(sql,row)
  const group=(await sql.query<{state:string}>('select state from run_hierarchy_groups where run_id=$1 and group_id=$2',
    [row.run_id,row.group_id])).rows[0]
  if(group?.state!=='waiting') {
    await sql.query("update run_coordinator_mailboxes set state='graph',active_consultation_id=null where run_id=$1 and waiting_activation_id=$2",
      [row.run_id,row.waiting_activation_id])
    await closeConsultationQueue(sql,row,now)
    return undefined
  }
  await sql.query("update run_coordinator_mailboxes set state='idle',active_consultation_id=null where run_id=$1 and waiting_activation_id=$2",
    [row.run_id,row.waiting_activation_id])
  const next=(await sql.query<ControlCommandRow>(`select ${CONTROL_COMMAND_COLUMNS} from run_chat_commands where run_id=$1
    and target->>'kind'='workflow_coordinator' and target->>'waitingActivationId'=$2 and kind='delivery' and state='queued'
    order by sequence limit 1 for update`,[row.run_id,row.waiting_activation_id])).rows[0]
  if(!next) return undefined
  const admitted=await createConsultation(sql,row,next,now)
  await sql.query("update run_coordinator_mailboxes set state='consultation',active_consultation_id=$3 where run_id=$1 and waiting_activation_id=$2",
    [row.run_id,row.waiting_activation_id,admitted.binding.consultationId])
  return admitted
}

async function settleConsultationCommands(sql:GraphTransactionSql,consultationId:string,
  outcome:'completed'|'failed'|'canceled',now:string) {
  const related=(await sql.query<ControlCommandSummary>(`select ${CONTROL_COMMAND_SUMMARY_COLUMNS} from run_chat_commands
    where consultation_id=$1 and ((kind='stop' and state not in ('completed','failed','canceled'))
      or (kind='delivery' and operation='steer' and state='accepted')) order by sequence`,[consultationId])).rows
  for(const command of related) {
    const receipt=command.kind==='stop'
      ? {...ChatControlReceiptSchema.parse(command.receipt),state:'completed' as const}
      : {...ChatDeliveryReceiptSchema.parse(command.receipt),state:outcome,updatedAt:now,
        ...(outcome==='completed'?{}:{errorCode:outcome==='failed'?'CONSULTATION_FAILED':'CONSULTATION_CANCELED'})}
    await updateControlCommand(sql,command,receipt,now)
  }
}

async function promoteReservedConsultation(sql:GraphTransactionSql,row:MailboxRow):Promise<WorkflowConsultationAdmission> {
  const turn=(await sql.query<ConsultationRow>('select * from run_coordinator_consultations where id=$1',
    [row.reserved_next_consultation_id])).rows[0]
  if(!turn||turn.state!=='admitted') throw new DomainError('COORDINATOR_BINDING_CONFLICT','The reserved next consultation is unavailable.',409)
  const command=(await readControlCommand(sql,turn.command_id))!
  await sql.query(`update run_coordinator_mailboxes set active_consultation_id=reserved_next_consultation_id,
    reserved_next_consultation_id=null where run_id=$1 and waiting_activation_id=$2`,[row.run_id,row.waiting_activation_id])
  return {binding:CoordinatorConsultationBindingSchema.parse(turn.binding),agent:AgentIdentitySchema.parse(row.agent),
    commandId:command.id,request:ChatSendRequestSchema.parse(command.request),sourceExecution:ExecutionRefSchema.parse(row.source_execution),
    ...(command.native_prompt !== null ? {nativePrompt:command.native_prompt} : {})}
}
async function closeConsultationQueue(sql:GraphTransactionSql,row:MailboxRow,now:string) {
  const queued=(await sql.query<ControlCommandSummary>(`select ${CONTROL_COMMAND_SUMMARY_COLUMNS} from run_chat_commands where run_id=$1
    and target->>'kind'='workflow_coordinator' and target->>'waitingActivationId'=$2 and kind='delivery' and state='queued'
    order by sequence`,[row.run_id,row.waiting_activation_id])).rows
  for(const command of queued) await updateControlCommand(sql,command,{...ChatDeliveryReceiptSchema.parse(command.receipt),
    state:'failed',errorCode:'TARGET_SETTLED',updatedAt:now},now)
}
