import { z } from 'zod'
import type pg from 'pg'
import { ChatDeliveryReceiptSchema, CoordinatorConsultationBindingSchema, EngineChatReadbackSchema,
  WorkflowExecutionChatReadRequestSchema, validateEngineChatReadback,
  type ChatDeliveryReceipt, type CoordinatorConsultationBinding, type EngineChatReadback } from '@foreman-code/contracts'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import { withExclusiveGraphConnection, type GraphSqlClient } from '../run-graph/connection.js'
import type { Principal } from './ports.js'
import { asWorkflowChatTarget, controlDigest, workflowTargetRunId } from './workflowControlRecords.js'
import { readWorkflowChatIdentity } from './workflowChatIdentity.js'
import type { WorkflowChatOwnerPort, WorkflowChatTarget } from './workflowControlTypes.js'

const Cursor = z.object({ target: z.string(), native: z.string().nullable(), nativeDone: z.boolean(),
  beforeReceipt: z.string().regex(/^\d+$/).nullable(), receiptsDone: z.boolean() }).strict()
type PageCursor = z.infer<typeof Cursor>
function readCursor(target: WorkflowChatTarget, value?: string): PageCursor {
  if (!value) return { target: controlDigest(target), native: null, nativeDone: false, beforeReceipt: null, receiptsDone: false }
  try {
    const cursor = Cursor.parse(JSON.parse(Buffer.from(value, 'base64url').toString()))
    if (cursor.target !== controlDigest(target)) throw new Error('scope')
    return cursor
  } catch { throw new DomainError('INVALID_CURSOR', 'Use this chat cursor with its original exact target.', 400) }
}
export function authorizeWorkflowChat(principal: Principal, target: WorkflowChatTarget,
  action: 'agent_chat:read' | 'agent_chat:write' | 'agent_chat:cancel') {
  const scope = { workspaceId: target.agent.workspaceId, workflowId: target.agent.workflowId, runId: workflowTargetRunId(target) }
  requireAuthorization(principal, 'agent_chat:read', scope)
  requireAuthorization(principal, action, scope)
}
export async function withWorkflowChatRead<T>(pool: pg.Pool, principal: Principal, target: WorkflowChatTarget,
  action: 'agent_chat:read' | 'agent_chat:write' | 'agent_chat:cancel', work: (sql: GraphSqlClient) => Promise<T>): Promise<T> {
  authorizeWorkflowChat(principal, target, action)
  return withExclusiveGraphConnection(pool, connection => connection.transaction(async sql => {
    authorizeWorkflowChat(await readLiveManagementPrincipal(sql, principal.id), target, action)
    return work(sql)
  }, true))
}

async function receiptPage(sql: GraphSqlClient, target: WorkflowChatTarget, cursor: PageCursor, limit: number) {
  const candidates = cursor.receiptsDone ? [] : (await sql.query<{ bytes: number; sequence: string }>(
    `select octet_length(receipt::text) as bytes,sequence::text from run_chat_commands where run_id=$1 and target_key=$2 and kind='delivery'
      and ($3::bigint is null or sequence<$3) order by sequence desc limit $4`,
  [workflowTargetRunId(target), controlDigest(target), cursor.beforeReceipt, limit + 1])).rows
  const selected:string[]=[]
  let bytes=0
  for(const row of candidates.slice(0,limit)) {
    if(bytes+row.bytes>48*1024) break
    selected.push(row.sequence);bytes+=row.bytes
  }
  if(candidates.length&&!selected.length) throw new DomainError('CHAT_RECEIPT_READ_LIMIT',
    'This receipt identity exceeds the bounded page. Replay the original command to read its exact receipt.',409)
  const page=selected.length?(await sql.query<{receipt:unknown;sequence:string}>(
    'select receipt,sequence::text from run_chat_commands where run_id=$1 and sequence=any($2::bigint[]) order by sequence desc',
    [workflowTargetRunId(target),selected])).rows:[]
  const hasMore=candidates.length>page.length
  const revision = (await sql.query<{ revision: string }>(
    'select coalesce(max(sequence),0)::text as revision from run_activity where run_id=$1', [workflowTargetRunId(target)])).rows[0]!.revision
  return { receipts: page.map(row => ChatDeliveryReceiptSchema.parse(row.receipt)).reverse(),
    hasMore, before: hasMore ? page.at(-1)!.sequence : null, revision: Number(revision) }
}
async function currentBindings(sql: GraphSqlClient, target: WorkflowChatTarget): Promise<CoordinatorConsultationBinding[]> {
  if (target.kind !== 'workflow_coordinator') return []
  return (await sql.query<{ binding: unknown }>(`select binding from run_coordinator_consultations
    where run_id=$1 and waiting_activation_id=$2 order by created_at desc,id desc limit 100`,
  [target.runId, target.waitingActivationId])).rows.map(row => CoordinatorConsultationBindingSchema.parse(row.binding))
}
async function pageBindings(sql: GraphSqlClient, target: WorkflowChatTarget, readback: EngineChatReadback) {
  if (target.kind !== 'workflow_coordinator') return []
  const ids = new Set(readback.messages.flatMap(message => message.provenance.kind === 'consultation'
    ? [message.provenance.binding.consultationId] : []))
  for (const receipt of readback.receipts) if (receipt.consultationId) ids.add(receipt.consultationId)
  if (!ids.size) return []
  const bindings = (await sql.query<{ binding: unknown }>(`select binding from run_coordinator_consultations
    where run_id=$1 and waiting_activation_id=$2 and id=any($3::text[])`,
  [target.runId, target.waitingActivationId, [...ids]])).rows.map(row => CoordinatorConsultationBindingSchema.parse(row.binding))
  if (bindings.length !== ids.size) throw new DomainError('CHAT_PROVENANCE_MISMATCH', 'Native history references an unrecorded consultation.', 409)
  return bindings
}

export async function readWorkflowExecutionChat(pool: pg.Pool, owner: WorkflowChatOwnerPort, principal: Principal,
  raw: unknown): Promise<EngineChatReadback> {
  const request = WorkflowExecutionChatReadRequestSchema.parse(raw), target = asWorkflowChatTarget(request.target)
  const cursor = readCursor(target, request.cursor)
  const stored = await withWorkflowChatRead(pool, principal, target, 'agent_chat:read', async sql => ({
    identity: await readWorkflowChatIdentity(sql, target), page: await receiptPage(sql, target, cursor, request.limit),
    bindings: await currentBindings(sql, target),
  }))
  const native = cursor.nativeDone ? { messages: [], nextCursor: null, hasMore: false, revision: 0 }
    : await owner.readNative(target, { ...(cursor.native ? { cursor: cursor.native } : {}), limit: request.limit, bindings: stored.bindings })
  const observation = await owner.observe(target)
  const hasMore = native.hasMore || stored.page.hasMore
  const next: PageCursor = { target: cursor.target, native: native.nextCursor, nativeDone: !native.hasMore,
    beforeReceipt: stored.page.before, receiptsDone: !stored.page.hasMore }
  const result = EngineChatReadbackSchema.parse({ target, state: stored.identity.state,
    capabilities: stored.identity.state === 'idle' || stored.identity.state === 'settling'
      ? { steer: 'unavailable', queue: false, interruptAndSend: false } : observation.capabilities,
    ...(stored.identity.state === 'active' && observation.nativeTurnId ? { nativeTurnId: observation.nativeTurnId } : {}),
    messages: native.messages, receipts: stored.page.receipts, hasMore,
    nextCursor: hasMore ? Buffer.from(JSON.stringify(next)).toString('base64url') : null,
    revision: Math.max(stored.page.revision, native.revision) })
  return withWorkflowChatRead(pool, principal, target, 'agent_chat:read', async sql => {
    const bindings = await pageBindings(sql, target, result)
    if (target.kind === 'workflow_execution') return validateEngineChatReadback({
      subject: { kind: 'execution', agent: stored.identity.agent, execution: target.execution }, readback: result })
    // Reading an unopened mailbox must not fabricate a consultation binding.
    if (!bindings.length) return result
    return validateEngineChatReadback({ subject: { kind: 'coordinator_consultation', agent: stored.identity.agent,
      binding: bindings[0]! }, readback: result, consultationBindings: bindings })
  })
}

export async function readWorkflowDeliveryReceipt(sql: GraphSqlClient, id: string): Promise<ChatDeliveryReceipt | undefined> {
  const row = (await sql.query<{ receipt: unknown }>('select receipt from run_chat_commands where id=$1 and kind=\'delivery\'', [id])).rows[0]
  return row ? ChatDeliveryReceiptSchema.parse(row.receipt) : undefined
}
