import { synchronizeGroupDelivery } from './workflowGroupReceipts.js'
import { createHash } from 'node:crypto'
import {
  canonicalJson, ChatControlReceiptSchema, ChatDeliveryReceiptSchema, ChatSendRequestSchema,
  CoordinatorConsultationBindingSchema, DeliveryTargetSchema, ExecutionRefSchema,
  type ChatControlReceipt, type ChatDeliveryReceipt, type LogicalWorkRef,
} from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { assertGraphTransaction, type GraphSqlClient, type GraphTransactionSql } from '../run-graph/connection.js'
import type { WorkflowChatLockedTarget, WorkflowChatNativeTarget, WorkflowChatTarget, WorkflowControlCommand } from './workflowControlTypes.js'

export function controlDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
export function controlId(kind: string, ...parts: string[]): string {
  return `${kind}-${controlDigest(parts)}`
}
export function workflowTargetRunId(target: WorkflowChatTarget): string {
  return target.kind === 'workflow_execution' ? target.execution.runId : target.runId
}
export function asWorkflowChatTarget(raw: unknown): WorkflowChatTarget {
  const target = DeliveryTargetSchema.parse(raw)
  if (target.kind !== 'workflow_execution' && target.kind !== 'workflow_coordinator') {
    throw new DomainError('INVALID_CHAT_TARGET', 'Use the existing conversation service for this target.', 400)
  }
  return target
}

export interface ControlCommandRow {
  id: string; command_id: string; principal_id: string; run_id: string; target: unknown
  kind: WorkflowControlCommand['kind']; operation: WorkflowControlCommand['operation']
  state: WorkflowControlCommand['state']; input_digest: string; request: unknown; native_prompt: string | null; native_target: unknown
  receipt: unknown; work: LogicalWorkRef | null; continuation_id: string | null; consultation_id: string | null
  delivered_execution: unknown; sequence: string; revision: string
}
export const CONTROL_COMMAND_COLUMNS = `id,command_id,principal_id,run_id,target,kind,operation,state,input_digest,
  request,native_prompt,native_target,receipt,work,continuation_id,consultation_id,delivered_execution,sequence::text,revision::text`
/** Queue/cleanup scans retain receipts, never every queued attachment/text body. */
export type ControlCommandSummary = Omit<ControlCommandRow, 'command_id' | 'principal_id' | 'input_digest' | 'request' | 'native_prompt' | 'work'>
export const CONTROL_COMMAND_SUMMARY_COLUMNS = `id,run_id,target,kind,operation,state,native_target,receipt,
  continuation_id,consultation_id,delivered_execution,sequence::text,revision::text`

export async function readControlCommand(sql: GraphSqlClient, id: string): Promise<ControlCommandRow | undefined> {
  return (await sql.query<ControlCommandRow>(`select ${CONTROL_COMMAND_COLUMNS} from run_chat_commands where id=$1`, [id])).rows[0]
}
export async function replayControlCommand(sql: GraphSqlClient, principalId: string, commandId: string,
  digest: string): Promise<ControlCommandRow | undefined> {
  const row = (await sql.query<ControlCommandRow>(`select ${CONTROL_COMMAND_COLUMNS} from run_chat_commands
    where principal_id=$1 and command_id=$2`, [principalId, commandId])).rows[0]
  if (row && row.input_digest !== digest) throw new DomainError('COMMAND_CONFLICT', 'This command ID already records different input or a different target.', 409)
  return row
}
export function commandReceipt(row: Pick<ControlCommandRow, 'kind' | 'receipt'>): ChatDeliveryReceipt | ChatControlReceipt {
  return row.kind === 'delivery' ? ChatDeliveryReceiptSchema.parse(row.receipt) : ChatControlReceiptSchema.parse(row.receipt)
}

export async function insertControlCommand(context: WorkflowChatLockedTarget, input: {
  id: string; principalId: string; commandId: string; digest: string; request: unknown
  nativePrompt?: string
  kind: WorkflowControlCommand['kind']; operation: WorkflowControlCommand['operation']
  receipt: ChatDeliveryReceipt | ChatControlReceipt; now: string
}): Promise<void> {
  assertGraphTransaction(context.sql)
  await context.sql.query(`insert into run_chat_commands
    (id,command_id,principal_id,run_id,workflow_version_id,workflow_node_id,target,target_key,work,kind,operation,
      input_digest,request,native_target,state,receipt,created_at,updated_at,native_prompt)
    values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16::jsonb,$17,$17,$18)`,
  [input.id,input.commandId,input.principalId,context.run.id,context.version.id,context.agent.workflowNodeId,
    canonicalJson(context.target),controlDigest(context.target),context.work ? canonicalJson(context.work) : null,
    input.kind,input.operation,input.digest,canonicalJson(input.request),context.native && ['steer','interrupt','stop'].includes(input.operation) ? canonicalJson(context.native) : null,
    input.receipt.state,canonicalJson(input.receipt),input.now,input.nativePrompt ?? null])
  await projectControlReceipt(context.sql, context.run.id, input.id, 0, input.receipt, input.now)
}

export async function updateControlCommand(sql: GraphTransactionSql, row: ControlCommandSummary,
  receipt: ChatDeliveryReceipt | ChatControlReceipt, now: string, extra: {
    state?: WorkflowControlCommand['state']; continuationId?: string; consultationId?: string
    deliveredExecution?: unknown; nativeTarget?: unknown
  } = {}): Promise<void> {
  assertGraphTransaction(sql)
  const parsed = row.kind === 'delivery' ? ChatDeliveryReceiptSchema.parse(receipt) : ChatControlReceiptSchema.parse(receipt)
  const state = extra.state ?? parsed.state
  if (canonicalJson(row.receipt) === canonicalJson(parsed) && row.state === state && !Object.keys(extra).length) return
  await sql.query(`update run_chat_commands set receipt=$2::jsonb,state=$3,
    continuation_id=coalesce(continuation_id,$4),consultation_id=coalesce(consultation_id,$5),
    delivered_execution=coalesce(delivered_execution,$6::jsonb),native_target=coalesce(native_target,$7::jsonb),
    revision=revision+1,updated_at=$8 where id=$1`,
  [row.id,canonicalJson(parsed),state,extra.continuationId ?? null,extra.consultationId ?? null,
    extra.deliveredExecution ? canonicalJson(extra.deliveredExecution) : null,
    extra.nativeTarget ? canonicalJson(extra.nativeTarget) : null,now])
  await projectControlReceipt(sql,row.run_id,row.id,Number(row.revision)+1,parsed,now)
}

async function projectControlReceipt(sql: GraphTransactionSql, runId: string, id: string, revision: number,
  receipt: ChatDeliveryReceipt | ChatControlReceipt, now: string) {
  if ('requestedIntent' in receipt) await synchronizeGroupDelivery(sql, receipt)
  await sql.query(`insert into run_activity(run_id,source,kind,occurred_at,payload)
    values($1,'backend','workflow_chat_receipt',$2::timestamptz,$3::jsonb)`,
  [runId,now,canonicalJson({ sourceEventKey: `workflow-chat:${id}:${revision}`, revision, receipt })])
}

/** Native adapters load only a committed command; all target and input identities
 * here were reserved by the service under the existing Run owner transaction. */
export async function readWorkflowControlCommandLocked(sql: GraphTransactionSql, runId: string,
  id: string): Promise<WorkflowControlCommand | undefined> {
  assertGraphTransaction(sql)
  const row = await readControlCommand(sql,id)
  if (!row || row.run_id !== runId) return undefined
  const consultation = row.consultation_id ? (await sql.query<{ binding: unknown }>(
    'select binding from run_coordinator_consultations where id=$1 and run_id=$2', [row.consultation_id,runId])).rows[0] : undefined
  return { id: row.id, runId: row.run_id, principalId: row.principal_id, target: asWorkflowChatTarget(row.target),
    kind: row.kind, operation: row.operation, state: row.state,
    request: row.kind === 'delivery' ? ChatSendRequestSchema.parse(row.request) : null,
    ...(row.native_prompt !== null ? { nativePrompt: row.native_prompt } : {}),
    nativeTarget: row.native_target as WorkflowControlCommand['nativeTarget'], receipt: commandReceipt(row),
    continuationId: row.continuation_id,
    consultation: consultation ? CoordinatorConsultationBindingSchema.parse(consultation.binding) : null,
    deliveredExecution: row.delivered_execution ? ExecutionRefSchema.parse(row.delivered_execution) : null }
}

/** Persist the exact original-session writer and submission ID BEFORE native I/O.
 * B's existing native owner alone calls this after rechecking its dispatch fence. */
export async function captureWorkflowControlNativeLocked(sql: GraphTransactionSql, input: {
  runId: string; commandId: string; nativeTarget: WorkflowChatNativeTarget; now: string
}): Promise<void> {
  assertGraphTransaction(sql)
  const row = await readControlCommand(sql, input.commandId)
  if (!row || row.run_id !== input.runId || ['completed', 'failed', 'canceled'].includes(row.state)) {
    throw new DomainError('TARGET_SETTLED', 'This command no longer admits native delivery.', 409)
  }
  if (!(input.nativeTarget.nativeTurnId || input.nativeTarget.inputMessageId)) {
    throw new DomainError('NATIVE_IDENTITY_REQUIRED', 'Capture the exact turn or submission identity before native I/O.', 409)
  }
  if (row.native_target) {
    if (canonicalJson(row.native_target) !== canonicalJson(input.nativeTarget)) {
      throw new DomainError('NATIVE_IDENTITY_CONFLICT', 'The command already captured another native owner.', 409)
    }
    return
  }
  await updateControlCommand(sql, row, commandReceipt(row), input.now, { nativeTarget: input.nativeTarget })
}

/** Called from the existing native observer with its actual acknowledgement.
 * A transport failure is unknown, never evidence that a turn stopped. */
export async function markWorkflowControlCommandLocked(sql: GraphTransactionSql, input: {
  runId: string; commandId: string; state: 'submitting' | 'accepted' | 'completed' | 'failed' | 'unknown'
  nativeTurnId?: string; errorCode?: string; now: string
}): Promise<void> {
  assertGraphTransaction(sql)
  const row = await readControlCommand(sql,input.commandId)
  if (!row || row.run_id !== input.runId || ['completed','failed','canceled'].includes(row.state)) return
  const receipt = commandReceipt(row)
  if (row.kind === 'delivery') {
    const delivery = ChatDeliveryReceiptSchema.parse(receipt)
    await updateControlCommand(sql,row,{ ...delivery,state: input.state,updatedAt: input.now,
      ...(input.nativeTurnId ? { nativeTurnId: input.nativeTurnId } : {}),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}) },input.now)
  } else {
    const control = ChatControlReceiptSchema.parse(receipt)
    const state = input.state === 'completed' ? 'completed' : input.state === 'failed' ? 'failed'
      : input.state === 'unknown' ? 'unknown' : 'settling'
    await updateControlCommand(sql,row,{ ...control,state,
      ...(input.errorCode ? { errorCode: input.errorCode } : {}) },input.now,{ state })
  }
}
