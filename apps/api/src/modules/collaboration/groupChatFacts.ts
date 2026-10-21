import { canonicalJson } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { TransactionSql } from '../../infrastructure/transaction.js'
import type { CommittedWorkflowChatFact } from '../workflow-chat/projection.js'
import { DomainError } from '../errors.js'

export async function enqueueGroupChatFact(sql: TransactionSql, fact: CommittedWorkflowChatFact) {
  const prior = (await sql.query<{ input_hash: string }>(
    'select input_hash from workflow_chat_projection_keys where source_event_key=$1', [fact.sourceEventKey])).rows[0]
  if (prior) {
    if (prior.input_hash !== commandInputHash(fact)) throw new DomainError('CHAT_PROJECTION_SOURCE_CONFLICT',
      'The committed Group source changed.', 409)
    return
  }
  const pending = (await sql.query<{ fact: unknown }>(`insert into workflow_chat_projection_pending
    (source_event_key,workspace_id,workflow_id,fact) values($1,$2,$3,$4::jsonb)
    on conflict(source_event_key) do update set source_event_key=excluded.source_event_key returning fact`,
  [fact.sourceEventKey, fact.agent.workspaceId, fact.agent.workflowId, canonicalJson(fact)])).rows[0]!
  if (canonicalJson(pending.fact) !== canonicalJson(fact)) throw new DomainError('CHAT_PROJECTION_SOURCE_CONFLICT',
    'The pending Group source changed.', 409)
}
