import { CONSULTATION_BINDING_ELIGIBLE } from './consultationAuthority.js'
/** Shared durable eligibility; aliases b/p/he/r name binding/principal/execution/Run.
 * Expiry is checked separately at authentication. A paused, still-owned lease can
 * be renewed; expiry alone is not terminal cleanup or authority revocation.
 */
export const WORKER_BINDING_ELIGIBLE = `
  b.revoked_at is null and p.revoked_at is null
  and p.audience='worker' and p.agent_id=b.agent_id
  and b.environment_variable='GRAPHQL_MCP_TOKEN'
  and r.worker_credentials_closed_at is null
  and ((b.purpose='workflow' and he.worker_credentials_closed_at is null
      and he.record->>'state' in ('starting','running','waiting')
      and not exists(select 1 from approval_execution_state s where s.execution_id=he.id and s.stopped_at is not null))
    or (b.purpose='reviewer' and he.record->>'state'='completed'
      and r.record->'approval'->>'handler'='orchestrator'
      and r.record->'approval'->>'designatedOrchestratorAgentId'=b.agent_id
      and exists(select 1 from execution_native_sessions ns
        join agent_configuration_versions c on c.id=he.record->>'agentConfigurationVersionId'
        where ns.execution_id=he.id and ns.workflow_finalized_at is not null
          and ns.reference->>'nativeSessionId'=he.record->>'nativeSessionId'
          and c.record->>'productRole' in ('master','orchestrator')))
    or (${CONSULTATION_BINDING_ELIGIBLE}))
  and he.id=b.execution_id and he.run_id=b.run_id and he.agent_id=b.agent_id
  and r.id=b.run_id and r.workspace_id=b.workspace_id and r.workflow_id=b.workflow_id
  and r.execution_state in ('running','waiting')
  and r.record->>'executionState'=r.execution_state and r.record->>'outcome'='pending'
  and he.record->>'id'=he.id and he.record->>'runId'=r.id and he.record->>'agentId'=b.agent_id
  and r.record->>'id'=r.id and r.record->>'workspaceId'=b.workspace_id
  and r.record->>'workflowId'=b.workflow_id
`
