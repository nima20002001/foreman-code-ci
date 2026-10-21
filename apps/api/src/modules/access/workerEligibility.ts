import type pg from 'pg'
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

/** A designated Orchestrator's marked result (F1) commits before its original
 * native turn settles. That settlement retains the same process credential as
 * the reviewer lease, or closes the process and revokes it. Until then the
 * workflow credential is not usable, but it is not terminal: sweeps leave it. */
export const RETAINED_REVIEWER_SETTLEMENT_PENDING = `
  b.purpose='workflow' and b.revoked_at is null and p.revoked_at is null
  and he.id=b.execution_id and he.run_id=r.id and r.id=b.run_id
  and he.worker_credentials_closed_at is null and r.worker_credentials_closed_at is null
  and r.stop_requested_at is null and r.execution_state in ('running','waiting')
  and r.record->>'outcome'='pending'
  and he.record->>'state'='completed' and he.record#>>'{result,outcome}'='succeeded'
  and r.record->'approval'->>'handler'='orchestrator'
  and r.record->'approval'->>'designatedOrchestratorAgentId'=b.agent_id
  and exists(select 1 from workflow_coordination_terminals t
    where t.execution_id=he.id and t.run_id=r.id and t.settled_native_proof_id is null)
`

export async function retainedReviewerSettlementPending(client: pg.ClientBase | pg.Pool, principalId: string): Promise<boolean> {
  const row = await client.query(`select 1 from worker_credential_bindings b
    join management_principals p on p.id=b.principal_id join harness_executions he on he.id=b.execution_id
    join runs r on r.id=b.run_id where b.principal_id=$1 and (${RETAINED_REVIEWER_SETTLEMENT_PENDING})`, [principalId])
  return row.rowCount === 1
}
