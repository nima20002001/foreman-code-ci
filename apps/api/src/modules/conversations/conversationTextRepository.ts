import { randomUUID } from 'node:crypto'
import { withTransaction } from '../../infrastructure/transaction.js'
import type pg from 'pg'
import { MessageSchema, type ActivityScope } from '@foreman-code/contracts'
import type { ActivityTextOperation } from '@foreman-code/contracts/activity-text'
import type { ActivityMutationFence } from './operatorActivityRepository.js'

export type TextMutationResult = { status: 'committed' | 'ignored' | 'reconciliation_required'; revision: string; messageRevision?: string }
interface Provenance {
  sessionId: string; generation?: string; turnId?: string; itemId: string; partId?: string; parentId?: string; channel: string; final: boolean
  nativeSubmission?: ActivityMutationFence['nativeSubmission']
  source?: ActivityTextOperation['source']
}
interface Owner {
  kind: 'agent' | 'operator'; revision: string; harness: string; workspace_id: string | null; workflow_id: string | null; workflow_node_id: string | null;
  agent_id: string | null; origin_run_id: string | null; origin_execution_id: string | null; native_session_id: string | null; active_native_turn_id: string | null
}
function sameScope(scope: ActivityScope, row: Owner, conversationId: string) {
  if (!('conversationId' in scope) || scope.conversationId !== conversationId) return false
  if (row.kind === 'operator') return scope.kind === 'operator_chat'
  return (scope.kind === 'agent_chat' && row.origin_run_id === null || scope.kind === 'selected_run_chat'
    && scope.selection.runId === row.origin_run_id && scope.selection.executionId === row.origin_execution_id)
    && scope.workspaceId === row.workspace_id && scope.workflowId === row.workflow_id && scope.nodeId === row.workflow_node_id && scope.agentId === row.agent_id
}

/** Exact admitted request/native ownership is locked with the existing message mutation. No provider effects or event log. */
export async function appendConversationTextOperation(pool: pg.Pool, conversationId: string, requestId: string,
  operation: ActivityTextOperation, fence: ActivityMutationFence = {}): Promise<TextMutationResult | undefined> {
  const identity = operation.identity
  if (identity.requestId !== requestId || operation.final && operation.mode !== 'replace') return undefined
  return withTransaction(pool, async (client) => {
    const row = (await client.query<Owner>(`select kind,revision::text,harness,workspace_id,workflow_id,workflow_node_id,agent_id,
      origin_run_id,origin_execution_id,native_session_id,active_native_turn_id from operator_conversations
      where id=$1 and active_request_id=$2 and deleted_at is null for update`, [conversationId, requestId])).rows[0]
    if (!row || !sameScope(identity.scope, row, conversationId) || row.native_session_id !== identity.sessionId
      || row.active_native_turn_id !== (identity.turnId ?? null)
      || fence.nativeGeneration !== undefined && fence.nativeGeneration !== identity.generation
      || fence.connectionId !== undefined && fence.connectionId !== operation.source?.connectionId
      || fence.nativeSessionId !== undefined && fence.nativeSessionId !== row.native_session_id
      || fence.nativeTurnId !== undefined && fence.nativeTurnId !== row.active_native_turn_id) {
      return undefined
    }
    if (row.harness === 'claude') {
      const receipt = fence.nativeSubmission
      const admitted = receipt?.kind === 'message' && identity.turnId === undefined && fence.nativeTurnId === undefined
        && receipt.nativeSessionId === identity.sessionId
        && (await client.query(`select 1 from operator_conversation_turns where conversation_id=$1 and request_id=$2
          and payload->'nativeSubmission'=$3::jsonb for update`, [conversationId, requestId, JSON.stringify(receipt)])).rowCount
      if (!admitted) return undefined
    }
    if (identity.scope.kind === 'selected_run_chat') {
      const selected = identity.scope.selection
      const exact = await client.query(`select 1 from runs r join harness_executions e on e.run_id=r.id
        where r.id=$1 and r.workflow_version_id=$2 and e.id=$3 and e.attempt::text=$4`,
      [selected.runId, selected.workflowVersionId, selected.executionId, selected.attemptKey])
      if (!exact.rowCount) return undefined
    }
    const nativeId = identity.itemId
    const prior = (await client.query<{ id: string; record: Record<string, unknown>; content: string; text_provenance: Provenance | null; revision: string }>(
      `select id,record,content,text_provenance,activity_record_revision::text as revision from operator_conversation_messages
        where conversation_id=$1 and native_message_id=$2 for update`, [conversationId, nativeId])).rows[0]
    const stored = prior?.text_provenance
    const result = (status: TextMutationResult['status']): TextMutationResult => ({ status, revision: row.revision,
      ...(prior ? { messageRevision: prior.revision } : {}) })
    if (prior && (prior.record.requestId !== requestId || prior.record.nativeParentMessageId !== undefined && prior.record.nativeParentMessageId !== identity.parentId || stored && (stored.sessionId !== identity.sessionId || stored.generation !== identity.generation
      || stored.turnId !== identity.turnId || JSON.stringify(stored.nativeSubmission) !== JSON.stringify(fence.nativeSubmission) || stored.itemId !== identity.itemId || stored.partId !== identity.partId
      || stored.parentId !== identity.parentId || stored.channel !== identity.channel))) {
      return undefined
    }
    const source = operation.source
    const previous = stored?.source
    const comparableNative = source?.nativeSequence !== undefined && previous?.nativeSequence !== undefined
    const comparableTransport = source?.connectionId !== undefined && source.connectionId === previous?.connectionId
      && source.sequence !== undefined && previous?.sequence !== undefined
    const stale = source?.eventId !== undefined && source.eventId === previous?.eventId
      || comparableNative && BigInt(source!.nativeSequence!) <= BigInt(previous!.nativeSequence!)
      || comparableTransport && source!.sequence! <= previous!.sequence!
    const alreadyFinal = prior && (stored?.final === true || prior.record.nativeMessageComplete !== false)
    if (stale || alreadyFinal && !operation.final) {
      return result('ignored')
    }
    if (alreadyFinal && prior?.content !== operation.text && !fence.authoritativeReconciliation) {
      return result('reconciliation_required')
    }
    // Append requires a proven order. A new/changed connection is not a source sequence.
    const orderedFirst = !prior && (source?.nativeSequence !== undefined || source?.connectionId !== undefined && source.sequence !== undefined)
    if (operation.mode === 'append' && !orderedFirst && !comparableNative && !comparableTransport
      || prior && !operation.final && !comparableNative && !comparableTransport) {
      return result('reconciliation_required')
    }
    const content = operation.mode === 'append' ? (prior?.content ?? '') + operation.text : operation.text
    const provenance: Provenance = { ...identity, ...(fence.nativeSubmission ? { nativeSubmission: fence.nativeSubmission } : {}), final: operation.final, ...(source ? { source } : {}) }
    if (prior && content === prior.content && operation.final === alreadyFinal
      && JSON.stringify(operation.truncation) === JSON.stringify(prior.record.truncation)) {
      if (source && (comparableNative || comparableTransport)) await client.query(`update operator_conversation_messages set text_provenance=$3::jsonb
        where conversation_id=$1 and native_message_id=$2`, [conversationId, nativeId, JSON.stringify(provenance)])
      return result('ignored')
    }
    const boundary = prior?.record.afterActivitySequence ?? (await client.query<{ sequence: string }>(
      'select coalesce(max(sequence),0)::text as sequence from operator_conversation_activity where conversation_id=$1 and request_id=$2', [conversationId, requestId])).rows[0]!.sequence
    const now = new Date().toISOString()
    const { attachmentRefs, publicationRefs, ...existing } = prior?.record ?? {}
    const message = MessageSchema.parse({ ...existing, id: prior?.id ?? randomUUID(), conversationId, requestId,
      activityNative: { harness: row.harness, sessionId: identity.sessionId, ...(identity.generation ? { generation: identity.generation } : {}), ...(identity.turnId ? { turnId: identity.turnId } : {}),
        itemId: identity.itemId, ...(identity.partId ? { partId: identity.partId } : {}), ...(identity.parentId ? { parentItemId: identity.parentId } : {}) },
      role: identity.channel === 'user' ? 'user' : 'assistant', activityChannel: identity.channel, content, nativeMessageId: nativeId,
      nativeMessageComplete: operation.final, ...(operation.truncation ? { truncation: operation.truncation } : {}), ...(identity.parentId ? { nativeParentMessageId: identity.parentId } : {}),
      afterActivitySequence: boundary, createdAt: existing.createdAt ?? now, updatedAt: now })
    const record = { ...message, ...(attachmentRefs ? { attachmentRefs } : {}), ...(publicationRefs ? { publicationRefs } : {}) }
    const written = (await client.query<{ revision: string }>(`insert into operator_conversation_messages
      (id,conversation_id,role,content,native_message_id,record,text_provenance) values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)
      on conflict(conversation_id,native_message_id) where native_message_id is not null do update set content=excluded.content,
        record=excluded.record,text_provenance=excluded.text_provenance returning activity_record_revision::text as revision`,
    [message.id, conversationId, message.role, content, nativeId, JSON.stringify(record), JSON.stringify(provenance)])).rows[0]!
    const revision = (await client.query<{ revision: string }>('update operator_conversations set revision=revision+1,updated_at=now() where id=$1 returning revision::text', [conversationId])).rows[0]!.revision
    return { status: 'committed', revision, messageRevision: written.revision }
  })
}
