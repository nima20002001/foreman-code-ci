import type { SqlQuery } from '../../infrastructure/transaction.js'
import type { BrowserSubjectDetails } from './browserAuthority.js'
import { readCoordinatorCredentialAuthority } from '../access/consultationAuthority.js'
import { DomainError } from '../errors.js'

/** Immutable pins were validated at preparation; each dispatch rechecks only live ownership. */
export async function browserOwnerIsActive(sql: SqlQuery, pins: BrowserSubjectDetails): Promise<boolean> {
  const subject = pins.subject
  if (subject.kind === 'coordinator_consultation') {
    try {
      await readCoordinatorCredentialAuthority(sql, subject.binding)
      return true
    } catch (error) {
      if (error instanceof DomainError && error.code === 'AUTH_REVOKED') return false
      throw error
    }
  }
  if (subject.kind === 'execution') {
    const { execution, agent } = subject
    const result = await sql.query(`select 1 from harness_executions e join runs r on r.id=e.run_id
      where e.id=$1 and r.id=$2 and r.workflow_version_id=$3 and e.agent_id=$4 and e.workflow_node_id=$5
        and e.record->>'agentConfigurationVersionId'=$6 and (e.record->>'attempt')::integer=$7
        and e.work_activation_id is not distinct from $8 and r.stop_requested_at is null
        and r.worker_credentials_closed_at is null and e.worker_credentials_closed_at is null
        and r.execution_state in ('queued','running','waiting')
        and e.record->>'state' in ('queued','starting','running','waiting')`,
    [execution.executionId, execution.runId, execution.workflowVersionId, agent.agentId,
      agent.workflowNodeId, agent.configurationVersionId, execution.attempt, execution.activationId ?? null])
    return result.rowCount === 1
  }
  const owner = await readConversationBrowserOwner(sql, subject)
  return !!owner && owner.active && owner.workflowVersionId === pins.workflowVersionId
    && (!owner.workerBound || owner.computerId === pins.computerId)
}

/** One live read supplies the accepted version as well as the conversation's ownership state. */
export async function readConversationBrowserOwner(sql: SqlQuery,
  subject: Extract<BrowserSubjectDetails['subject'], { kind: 'conversation' }>) {
  const { agent } = subject
  const result = await sql.query<{ version_id: string; computer_id: string | null; worker_bound: boolean; active: boolean }>(`
    select coalesce(accepted.version_id,origin.workflow_version_id,w.current_version_id) as version_id,
      coalesce(c.worker_conversation_binding#>>'{profile,target,hostRef,deviceId}',
        c.worker_conversation_binding#>>'{profile,target,hostRef,mainId}') as computer_id,
      c.worker_conversation_binding is not null as worker_bound,
      c.deleted_at is null and not coalesce((c.record->>'archived')::boolean,false) as active
    from operator_conversations c
    join workflows w on w.id=c.workflow_id and w.workspace_id=c.workspace_id
    left join runs origin on origin.id=c.origin_run_id
    left join lateral (
      select t.payload#>>'{preparedInput,input,conversationContext,workflowVersionId}' as version_id
      from operator_conversation_turns t where t.conversation_id=c.id
        and (t.request_id=c.active_request_id or t.native_turn_id is not null)
      order by (t.request_id=c.active_request_id) desc nulls last,t.turn_sequence desc limit 1
    ) accepted on true
    where c.id=$1 and c.kind='agent'
      and c.workspace_id=$2 and c.workflow_id=$3 and c.workflow_node_id=$4 and c.agent_id=$5
      and c.agent_configuration_version_id=$6`,
  [subject.conversationId, agent.workspaceId, agent.workflowId, agent.workflowNodeId, agent.agentId,
    agent.configurationVersionId])
  const row = result.rows[0]
  return row ? { workflowVersionId: row.version_id, computerId: row.computer_id,
    workerBound: row.worker_bound, active: row.active } : undefined
}
