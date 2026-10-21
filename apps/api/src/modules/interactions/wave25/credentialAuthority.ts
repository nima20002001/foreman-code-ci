import { AgentConfigurationVersionSchema, HarnessExecutionSchema, NativeSessionReferenceSchema } from '@foreman-code/contracts'
import { WorkflowRunV3Schema, WorkflowVersionV3Schema, canonicalGraphJson } from '@foreman-code/contracts/wave25'
import type { GraphSqlClient } from '../../run-graph/connection.js'
import { resolveImmutableApprovalRoute, usesNativeSelfReview } from '../../workflows/approvalRoutes.js'
import { validateReviewerBootstrap } from '../../workflows/reviewerBootstrap.js'
import { fail } from './context.js'
import { readRecoverableRemoteReviewer } from '../retainedRemoteReviewer.js'

type Purpose = 'workflow' | 'reviewer'
interface WorkerCredentialBinding {
  execution_id: string
  run_id: string
  purpose: Purpose
  workspace_id: string
  workflow_id: string
  agent_id: string
  approval_review_job_id: string | null
  approval_review_lease_fence: string | null
  approval_native_session_id: string | null
  approval_connection_generation: string | null
  live: boolean
  environment_variable: string
  execution_semantics_version: number
}
export async function credentialAuthority(
  sql: GraphSqlClient, executionId: string, purpose: Purpose, principalId?: string,
) {
  const row = (await sql.query<{ run: unknown; version: unknown; execution: unknown; configuration: unknown;
    attempt: number; stopped: boolean; execution_closed: boolean; native_reference: unknown; finalized: boolean;
    generation: string | null; native_owner: string | null; budget_active: boolean;
    authority_binding: WorkerCredentialBinding | null }>(
    `select r.record as run,v.record as version,e.record as execution,c.record as configuration,e.attempt,
      r.stop_requested_at is not null or r.worker_credentials_closed_at is not null as stopped,
      e.worker_credentials_closed_at is not null as execution_closed,s.reference as native_reference,
      s.workflow_finalized_at is not null as finalized,l.record->>'connectionGeneration' as generation,
      l.owner_agent_id as native_owner,coalesce(b.stopped_at is null and b.active_elapsed_ms+
        coalesce(extract(epoch from(clock_timestamp()-b.active_started_at))*1000,0)<b.active_timeout_ms,false) as budget_active
      ${principalId ? `,case when credential.principal_id is not null then to_jsonb(credential) || jsonb_build_object(
        'approval_connection_generation',credential.approval_connection_generation::text,
        'approval_review_lease_fence',credential.approval_review_lease_fence::text,
        'live',principal.revoked_at is null and credential.revoked_at is null
          and principal.expires_at>clock_timestamp() and principal.audience='worker' and principal.agent_id=credential.agent_id,
        'execution_semantics_version',v.execution_semantics_version) end as authority_binding` : ''}
     from harness_executions e join runs r on r.id=e.run_id join workflow_versions v on v.id=r.workflow_version_id
     join agent_configuration_versions c on c.id=e.record->>'agentConfigurationVersionId'
     left join execution_native_sessions s on s.execution_id=e.id
     left join native_session_lanes l on l.harness=s.reference->>'harness' and l.native_session_id=s.reference->>'nativeSessionId'
     left join approval_execution_state b on b.execution_id=e.id
     ${principalId ? `left join worker_credential_bindings credential on credential.execution_id=e.id and credential.principal_id=$2
     left join management_principals principal on principal.id=credential.principal_id` : ''}
     where e.id=$1 and v.execution_semantics_version=3`, principalId ? [executionId, principalId] : [executionId])).rows[0]
  if (!row) return fail('AUTH_REVOKED')
  const r = WorkflowRunV3Schema.parse(row.run), v = WorkflowVersionV3Schema.parse(row.version)
  const e = HarnessExecutionSchema.parse(row.execution), c = AgentConfigurationVersionSchema.parse(row.configuration)
  // Retry admission owns the budget. Credentials bind to that exact persisted
  // execution/attempt, not an attempt-one-only workflow or a reused credential.
  if (row.stopped || !['running','waiting','queued'].includes(r.executionState) || r.outcome !== 'pending'
    || e.id !== executionId || e.runId !== r.id || e.attempt !== row.attempt || r.workflowVersionId !== v.id
    || v.workspaceId !== r.workspaceId || v.workflowId !== r.workflowId || c.workspaceId !== r.workspaceId
    || c.agentId !== e.agentId || c.id !== e.agentConfigurationVersionId || !c.productRole
    || r.agentConfigurationVersionIds[e.agentId] !== c.id || v.agentConfigurationVersionIds[e.agentId] !== c.id
    || canonicalGraphJson(r.approval) !== canonicalGraphJson(v.approval)
    || !v.definition.nodes.some((node) => node.id === e.workflowNodeId && node.kind !== 'job' && node.agentId === e.agentId)) return fail('AUTH_REVOKED')
  if (purpose === 'workflow' && (row.execution_closed || !['starting','running','waiting'].includes(e.state)
    || e.state !== 'starting' && !row.budget_active)) return fail('AUTH_REVOKED')
  const designated = v.approval.handler === 'orchestrator' && v.approval.designatedOrchestratorAgentId === e.agentId
    && v.entryNodeId === e.workflowNodeId && (c.productRole === 'master' || c.productRole === 'orchestrator')
  if (designated) validateReviewerBootstrap(v.definition, v.approval, c.harness, v.entryNodeId)
  let canRespond = false
  if (designated) {
    const configurations = (await sql.query<{ record: unknown }>(
      'select record from agent_configuration_versions where workspace_id=$1 and id=any($2::text[])',
      [r.workspaceId, Object.values(v.agentConfigurationVersionIds)])).rows.map((item) => AgentConfigurationVersionSchema.parse(item.record))
    canRespond = v.definition.nodes.some((node) => {
      if (node.kind === 'job') return false
      const configuration = configurations.find((item) => item.id === v.agentConfigurationVersionIds[node.agentId])
      return configuration?.workspaceId === r.workspaceId && configuration.agentId === node.agentId
        && !usesNativeSelfReview(configuration.harness)
        && resolveImmutableApprovalRoute(v, node.id, node.agentId)?.orchestratorNodeId === e.workflowNodeId
    })
  }
  const session = NativeSessionReferenceSchema.safeParse(row.native_reference)
  if (purpose === 'reviewer' && (!designated || !canRespond || e.state !== 'completed' || e.result?.outcome !== 'succeeded'
    || !row.finalized || !session.success || row.generation === null)) return fail('REVIEWER_EXECUTION_NOT_READY')
  if (session.success) {
    if (session.data.nativeSessionId !== e.nativeSessionId || session.data.harness !== c.harness.harness
      || row.native_owner !== e.agentId || row.generation === null) return fail('AUTH_REVOKED')
  } else if (purpose !== 'workflow' || e.state !== 'starting' || e.nativeSessionId) return fail('AUTH_REVOKED')
  return { run: r, execution: e, canRespond, nativeSessionId: session.success ? session.data.nativeSessionId : null,
    generation: session.success ? row.generation : null, binding: row.authority_binding }
}

/** Additional check on the real authenticated App endpoint. The legacy predicate
 * remains in force; typed-route/session/generation eligibility is additive. */
export async function assertWave25WorkerBinding(sql: GraphSqlClient, principalId: string): Promise<void> {
  const row = (await sql.query<WorkerCredentialBinding>(
    `select b.*,b.approval_connection_generation::text,b.approval_review_lease_fence::text,p.revoked_at is null and b.revoked_at is null
      and p.expires_at>clock_timestamp() and p.audience='worker' and p.agent_id=b.agent_id as live,v.execution_semantics_version
     from worker_credential_bindings b join management_principals p on p.id=b.principal_id
     join runs r on r.id=b.run_id join workflow_versions v on v.id=r.workflow_version_id where b.principal_id=$1`, [principalId])).rows[0]
  if (!row) return fail('AUTH_REVOKED')
  if (row.execution_semantics_version !== 3) return fail('AUTH_REVOKED')
  if (!row.live || !['workflow','reviewer'].includes(row.purpose) || row.environment_variable !== 'GRAPHQL_MCP_TOKEN') return fail('AUTH_REVOKED')
  if (row.purpose === 'reviewer' && row.approval_review_job_id) {
    const epoch = await sql.query(`select 1 from review_jobs where id=$1 and execution_id=$2 and lease_fence=$3::bigint`,
    [row.approval_review_job_id, row.execution_id, row.approval_review_lease_fence])
    if (epoch.rowCount !== 1) {
      const execution = (await sql.query<{ record: unknown }>('select record from harness_executions where id=$1',
        [row.execution_id])).rows[0]
      const retained = execution && await readRecoverableRemoteReviewer(sql, HarnessExecutionSchema.parse(execution.record))
      // Recovery preserves the principal; its stale App binding remains denied until rebinding.
      if (retained?.principalId === principalId) return fail('REVIEWER_BINDING_REBIND_REQUIRED')
      return fail('AUTH_REVOKED')
    }
  }
  // Session publication changes the execution and binding together. Compare them from one SQL snapshot.
  const authority = await credentialAuthority(sql, row.execution_id, row.purpose, principalId)
  const binding = authority.binding
  if (!binding?.live || binding.purpose !== row.purpose || binding.environment_variable !== 'GRAPHQL_MCP_TOKEN'
    || binding.execution_semantics_version !== 3 || authority.execution.id !== binding.execution_id
    || authority.run.id !== binding.run_id || authority.run.workspaceId !== binding.workspace_id
    || authority.run.workflowId !== binding.workflow_id || authority.execution.agentId !== binding.agent_id
    || authority.nativeSessionId !== binding.approval_native_session_id
    || authority.generation !== binding.approval_connection_generation) {
    const retained = row.purpose === 'reviewer' && await readRecoverableRemoteReviewer(sql, authority.execution)
    if (retained && retained.principalId === principalId) return fail('REVIEWER_BINDING_REBIND_REQUIRED')
    return fail('AUTH_REVOKED')
  }
}
