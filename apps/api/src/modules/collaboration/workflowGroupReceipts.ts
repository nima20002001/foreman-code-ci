import { enqueueGroupChatFact } from './groupChatFacts.js'
import { AgentIdentitySchema, canonicalJson, ChatDeliveryReceiptSchema, type ChatDeliveryReceipt } from '@foreman-code/contracts'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'

/** Run receipt updates join the same transaction as the channel journal. */
export async function synchronizeGroupDelivery(sql: GraphTransactionSql, receipt: ChatDeliveryReceipt) {
  const stored = (await sql.query<{ receipt: unknown; owner_admission: string; owner_binding: { agentIdentity?: unknown } }>(
    'select receipt,owner_admission,owner_binding from chat_delivery_commands where id=$1 for update', [receipt.id])).rows[0]
  if (!stored) return
  const previous = ChatDeliveryReceiptSchema.parse(stored.receipt)
  const identity = (value: ChatDeliveryReceipt) => [value.commandId, value.target, value.postId,
    value.requestedIntent, value.appliedIntent, value.createdAt]
  if (stored.owner_admission !== 'owner_admitted' || canonicalJson(identity(previous)) !== canonicalJson(identity(receipt))) {
    throw new DomainError('CHAT_OWNER_RECEIPT_CONFLICT', 'The Run receipt does not match its accepted Group delivery.', 409)
  }
  const next = { ...receipt, ...(previous.replyPostId ? { replyPostId: previous.replyPostId } : {}) }
  if (canonicalJson(previous) === canonicalJson(next)) return
  const updated = (await sql.query<{ revision: string }>(`update chat_delivery_commands
    set receipt=$2::jsonb,revision=revision+1,updated_at=now() where id=$1 returning revision::text`,
  [receipt.id, canonicalJson(next)])).rows[0]!
  if (next.state === 'completed' && next.postId && next.nativeTurnId) await enqueueReply(sql, next)
  await sql.query(`update workflow_chat_channels set revision=revision+1 where id=(
    select channel_id from chat_delivery_commands where id=$1)`, [receipt.id])
  if (next.postId) await enqueueGroupChatFact(sql, { kind: 'receipt_changed',
    sourceEventKey: `group-receipt:${receipt.id}:${updated.revision}`, createdAt: next.updatedAt,
    agent: AgentIdentitySchema.parse(stored.owner_binding.agentIdentity), receiptId: receipt.id })
}


async function enqueueReply(sql: GraphTransactionSql, receipt: ChatDeliveryReceipt) {
  const target = receipt.target
  if (target.kind === 'agent_conversation' || target.kind === 'operator_conversation') return
  const command = (await sql.query<{ owner_binding: { agentIdentity?: unknown } }>(
    'select owner_binding from chat_delivery_commands where id=$1', [receipt.id])).rows[0]!
  const agent = AgentIdentitySchema.parse(command.owner_binding.agentIdentity)
  const execution = target.kind === 'workflow_execution' ? receipt.continuationExecution ?? target.execution : undefined
  const sourceId = execution?.executionId ?? receipt.consultationId
  if (!sourceId) throw new DomainError('CHAT_REPLY_TARGET_MISMATCH', 'The completed reply has no retained native owner.', 409)
  const row = (await sql.query<{ native_message_id: string; native_session: string; created_at: string }>(`
    select jsonb_build_array(i.source_id,coalesce(e.record->>'nativeSessionId',c.binding->>'nativeSessionId'),
      i.message_key::jsonb->0,i.message_key::jsonb->1,i.message_key::jsonb->2)::text as native_message_id,
      coalesce(e.record->>'nativeSessionId',c.binding->>'nativeSessionId') as native_session,
      coalesce(e.record->>'finishedAt',c.updated_at::text) as created_at
    from workflow_native_chat_items i left join harness_executions e on i.kind='execution' and e.id=i.source_id
    left join run_coordinator_consultations c on i.kind='consultation' and c.id=i.source_id
    where i.source_id=$1 and i.kind=$2 and i.message_key::jsonb->>0=$3
    order by i.sequence desc limit 1`, [sourceId, execution ? 'execution' : 'consultation', receipt.nativeTurnId])).rows[0]
  if (!row?.native_session) return
  await enqueueGroupChatFact(sql, { kind: 'reply', sourceEventKey: `group-reply:${receipt.id}`,
    createdAt: new Date(row.created_at).toISOString(), agent, commandId: receipt.commandId, receiptId: receipt.id,
    nativeMessageId: row.native_message_id, nativeSessionId: row.native_session, nativeTurnId: receipt.nativeTurnId,
    ...(execution ? { execution } : { consultationId: receipt.consultationId! }) })
}
