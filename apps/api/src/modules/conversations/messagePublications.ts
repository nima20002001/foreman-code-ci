import { readClaudeMessagePublicationReceipts, type ClaudeMessagePublicationReceipt } from '../harnesses/claudeSdk/publications.js'
import type pg from 'pg'
import { MessageAttachmentRefSchema, type MessageAttachmentRef } from '@foreman-code/contracts/files'
import { bindingIdentity } from '../files/tools/context.js'
import { MessagePublicationRefsSchema, mergeMessagePins } from './messagePins.js'

export { MessagePublicationRefsSchema, mergeMessagePins }

/** Read recovery after process loss, including a canceled publish whose final
 * authentication failed. Reconstruct bindings from persisted chat facts, never
 * a live token, mutable host path, current selection, or caller-provided context.
 * This projects already-finalized facts; it cannot authorize another write. */
export async function readCodexMessagePublications(query: Pick<pg.PoolClient, 'query'>,
  conversationId: string, messageIds: string[], onReceipt?: (receipt: CodexMessagePublicationReceipt) => void): Promise<Map<string, MessageAttachmentRef[]>> {
  const result = new Map<string, MessageAttachmentRef[]>()
  if (!messageIds.length) return result
  const turns = (await query.query<{
    message_id: string; native_turn_id: string; owner_principal_id: string; native_session_id: string
    kind: 'agent' | 'operator'; operator_id: string | null
    workspace_id: string | null; workflow_id: string | null; agent_id: string | null
    origin_run_id: string | null; origin_execution_id: string | null
  }>(`select t.message_id,t.native_turn_id,
      case when c.kind='operator' then c.owner_principal_id else t.payload->>'ownerPrincipalId' end as owner_principal_id,
      c.kind,c.operator_id,c.native_session_id,c.workspace_id,c.workflow_id,c.agent_id,c.origin_run_id,c.origin_execution_id
    from operator_conversations c join operator_conversation_turns t on t.conversation_id=c.id
    join operator_conversation_messages m on m.id=t.message_id and m.conversation_id=c.id
      and m.client_request_id=t.request_id and m.role='user'
    where c.id=$1 and c.kind in ('agent','operator') and c.harness='codex' and c.deleted_at is null
      and (c.kind='operator' or t.intent<>'steer') and t.message_id=any($2::text[]) and t.native_turn_id is not null
      and c.native_session_id is not null
      and to_regclass('file_tool_publications') is not null
      and to_regclass('file_allocations') is not null
      and ((c.kind='agent' and t.payload->>'ownerPrincipalId' is not null)
        or (c.kind='operator' and c.owner_principal_id is not null and c.operator_id is not null
          and c.workspace_id is null and c.workflow_id is null and c.agent_id is null
          and c.origin_run_id is null and c.origin_execution_id is null
          and t.payload->>'attachmentIdentity' is not null))`,
  [conversationId, messageIds])).rows
  const bindings = new Map(turns.map((turn) => [bindingIdentity({
    ownerPrincipalId: turn.owner_principal_id, nativeSessionId: turn.native_session_id,
    turnId: turn.native_turn_id, messageId: turn.message_id, allowMutation: false, allowedTools: [],
    scope: { kind: 'temporary', chat: turn.kind === 'operator'
      ? { kind: 'operator', conversationId, ownerPrincipalId: turn.owner_principal_id, operatorId: turn.operator_id! }
      : { kind: 'agent', conversationId, agentId: turn.agent_id!,
        workspaceId: turn.workspace_id!, workflowId: turn.workflow_id!,
        ...(turn.origin_run_id !== null && turn.origin_execution_id !== null
          ? { runId: turn.origin_run_id, executionId: turn.origin_execution_id } : {}) } },
  }), turn]))
  if (!bindings.size) return result
  const published = (await query.query<{ binding: string; owner_principal_id: string; file_id: string; revision_id: string; request_id: string; file_activity_revision: string; file_state: string }>(`
    select p.binding,p.owner_principal_id,p.file_id,p.revision_id,p.request_id,f.activity_record_revision::text as file_activity_revision,
      f.state as file_state from file_tool_publications p
    join files f on f.file_id=p.file_id and f.owner_principal_id=p.owner_principal_id
    join file_allocations a on a.owner_principal_id=p.owner_principal_id and a.request_id=p.request_id
      and a.file_id=p.file_id and a.revision_id=p.revision_id and a.state='finalized'
    where p.binding=any($1::text[]) order by p.request_id`, [[...bindings.keys()]])).rows
  for (const publication of published) {
    const turn = bindings.get(publication.binding)
    if (!turn || publication.owner_principal_id !== turn.owner_principal_id) continue
    const refs = result.get(turn.message_id) ?? []
    refs.push(MessageAttachmentRefSchema.parse({ fileId: publication.file_id, revisionId: publication.revision_id }))
    result.set(turn.message_id, refs)
    onReceipt?.({ receiptId: publication.request_id, messageId: turn.message_id, fileId: publication.file_id, fileRevisionId: publication.revision_id,
      nativeSessionId: turn.native_session_id, nativeTurnId: turn.native_turn_id, fileActivityRevision: publication.file_activity_revision, fileState: publication.file_state })
  }
  return result
}

export interface CodexMessagePublicationReceipt {
  receiptId: string; messageId: string; fileId: string; fileRevisionId: string; nativeSessionId: string; nativeTurnId: string; fileActivityRevision: string; fileState: string
}
export type ConversationPublicationReceipt = CodexMessagePublicationReceipt | ClaudeMessagePublicationReceipt
/** Reuse the same exact receipt/binding/owner checks as attachment hydration. */
export async function readConversationPublicationReceipts(query: Pick<pg.PoolClient, 'query'>, conversationId: string, messageIds: string[]) {
  const receipts: ConversationPublicationReceipt[] = []
  await readCodexMessagePublications(query, conversationId, messageIds, (receipt) => receipts.push(receipt))
  receipts.push(...await readClaudeMessagePublicationReceipts(query, conversationId, messageIds))
  return receipts
}
