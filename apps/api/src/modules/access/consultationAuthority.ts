import { AgentIdentitySchema, AgentSubjectSchema, canonicalJson, CoordinatorConsultationBindingSchema,
  HarnessExecutionSchema, type CoordinatorConsultationBinding } from '@foreman-code/contracts'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'

/** Aliases b/he/r are the existing worker binding, source execution and Run.
 * The source execution remains closed. Only this separate, current mailbox grants authority. */
export const CONSULTATION_BINDING_ELIGIBLE = `b.purpose='consultation' and r.stop_requested_at is null
  and exists(select 1 from run_coordinator_consultations c
    join run_coordinator_mailboxes m on m.run_id=c.run_id and m.waiting_activation_id=c.waiting_activation_id
    join run_hierarchy_groups g on g.run_id=m.run_id and g.group_id=m.group_id
    where c.id=b.consultation_id and c.binding=b.consultation_binding and c.run_id=b.run_id
      and c.state in ('admitted','active','settling','unknown') and m.state='consultation' and m.active_consultation_id=c.id
      and m.source_execution->>'executionId'=he.id and m.workflow_node_id=he.workflow_node_id
      and m.agent->>'agentId'=b.agent_id and m.agent->>'workspaceId'=b.workspace_id
      and m.agent->>'workflowId'=b.workflow_id and m.agent->>'configurationVersionId'=he.record->>'agentConfigurationVersionId'
      and m.agent->>'productRole' in ('master','orchestrator')
      and c.binding->>'nativeSessionId'=m.native_session_id and m.native_session_id=he.record->>'nativeSessionId'
      and c.binding->>'workflowVersionId'=r.workflow_version_id and m.workflow_version_id=r.workflow_version_id
      and c.binding->>'delegationGroupId'=m.group_id and c.binding->>'waitingActivationId'=m.waiting_activation_id
      and g.parent_execution_id=he.id and g.parent_activation_id=m.waiting_activation_id
      and g.state in ('waiting','ready') and he.record->>'state'='completed')`

export async function readCoordinatorCredentialAuthority(sql: GraphSqlClient, raw: CoordinatorConsultationBinding,
  lock = false) {
  const binding = CoordinatorConsultationBindingSchema.parse(raw)
  if (lock) await sql.query('select id from runs where id=$1 for no key update', [binding.runId])
  const row = (await sql.query<{ binding: unknown; agent: unknown; execution: unknown; run_id: string;
    workspace_id: string; workflow_id: string; source_execution_id: string }>(`select c.binding,m.agent,e.record as execution,
      r.id as run_id,r.workspace_id,r.workflow_id,e.id as source_execution_id
    from run_coordinator_consultations c
    join run_coordinator_mailboxes m on m.run_id=c.run_id and m.waiting_activation_id=c.waiting_activation_id
    join run_hierarchy_groups g on g.run_id=m.run_id and g.group_id=m.group_id
    join harness_executions e on e.id=g.parent_execution_id and e.run_id=g.run_id
    join runs r on r.id=c.run_id join workflow_versions v on v.id=r.workflow_version_id
    join agent_configuration_versions a on a.id=e.record->>'agentConfigurationVersionId'
    join execution_native_sessions s on s.execution_id=e.id
    where c.id=$1 and c.run_id=$2 and c.binding=$3::jsonb and c.state in ('admitted','active','settling','unknown')
      and m.state='consultation' and m.active_consultation_id=c.id and m.native_session_id=$4
      and c.binding->>'delegationGroupId'=m.group_id and c.binding->>'waitingActivationId'=m.waiting_activation_id
      and m.source_execution->>'executionId'=e.id and m.waiting_activation_id=g.parent_activation_id
      and m.workflow_node_id=e.workflow_node_id and m.workflow_version_id=r.workflow_version_id
      and m.agent->>'configurationVersionId'=a.id and a.agent_id=e.agent_id and a.workspace_id=r.workspace_id
      and a.record->>'productRole'=m.agent->>'productRole' and a.record->>'productRole' in ('master','orchestrator')
      and v.execution_semantics_version=3 and v.workspace_id=r.workspace_id and v.workflow_id=r.workflow_id
      and r.workflow_version_id=$5 and r.stop_requested_at is null and r.worker_credentials_closed_at is null
      and r.execution_state in ('running','waiting') and r.record->>'outcome'='pending'
      and e.record->>'state'='completed' and e.record->>'nativeSessionId'=$4
      and s.reference->>'nativeSessionId'=$4 and g.state in ('waiting','ready')
    ${lock ? 'for share of e,m,c,g' : ''}`,
  [binding.consultationId,binding.runId,canonicalJson(binding),binding.nativeSessionId,binding.workflowVersionId])).rows[0]
  if (!row) throw new DomainError('AUTH_REVOKED', 'This consultation no longer owns the coordinator mailbox.', 401)
  const agent = AgentIdentitySchema.parse(row.agent), execution = HarnessExecutionSchema.parse(row.execution)
  if (agent.agentId !== execution.agentId || agent.workflowNodeId !== execution.workflowNodeId
    || agent.workspaceId !== row.workspace_id || agent.workflowId !== row.workflow_id
    || execution.runId !== row.run_id || execution.id !== row.source_execution_id) {
    throw new DomainError('AUTH_REVOKED', 'The consultation identity is inconsistent.', 401)
  }
  return { ...row, execution, subject: AgentSubjectSchema.parse({ kind: 'coordinator_consultation', agent, binding }) }
}

/** Shared A/B/C feature services derive their public subject from this binding;
 * they never trust a caller-supplied Run, node, consultation or native address. */
export async function readConsultationCredentialSubject(sql: GraphSqlClient, principalId: string) {
  const row = (await sql.query<{ consultation_binding: unknown; execution_id: string; agent_id: string }>(
    `select b.consultation_binding,b.execution_id,b.agent_id from worker_credential_bindings b
    join management_principals p on p.id=b.principal_id join harness_executions he on he.id=b.execution_id
    join runs r on r.id=b.run_id where b.principal_id=$1 and b.revoked_at is null and p.revoked_at is null
      and p.expires_at>clock_timestamp() and p.audience='worker' and p.agent_id=b.agent_id
      and b.environment_variable='GRAPHQL_MCP_TOKEN' and r.worker_credentials_closed_at is null
      and r.execution_state in ('running','waiting') and r.record->>'outcome'='pending'
      and he.run_id=b.run_id and he.agent_id=b.agent_id and r.workspace_id=b.workspace_id and r.workflow_id=b.workflow_id
      and ${CONSULTATION_BINDING_ELIGIBLE}`, [principalId])).rows[0]
  if (!row) throw new DomainError('AUTH_REVOKED', 'The consultation credential is no longer active.', 401)
  const authority = await readCoordinatorCredentialAuthority(sql, CoordinatorConsultationBindingSchema.parse(row.consultation_binding))
  if (authority.source_execution_id !== row.execution_id || authority.subject.agent.agentId !== row.agent_id) {
    throw new DomainError('AUTH_REVOKED', 'The consultation credential does not match its source.', 401)
  }
  return authority.subject
}
