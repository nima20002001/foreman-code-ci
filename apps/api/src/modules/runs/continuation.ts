import { AgentConfigurationVersionSchema, HarnessExecutionSchema } from '@foreman-code/contracts'
import { AcceptedWorkflowRunV3Schema, RunWorktreeSchema } from '@foreman-code/contracts/wave25'
import type pg from 'pg'
import { DomainError } from '../errors.js'
import { interactionConnection } from '../interactions/connection.js'
import { requiredLocationAccess } from '../workspaces/location.js'
import type { WorkspaceLocationService } from '../workspaces/location.js'

/** Shared by preflight, attachment and approval writes, before native side effects. */
export function continuationValidator(pool: pg.Pool, locations: WorkspaceLocationService) {
  return async (executionId: string, signal?: AbortSignal): Promise<void> => {
    const client = interactionConnection.getStore() ?? pool
    const result = await client.query<{ execution: unknown; run: unknown; configuration: unknown; stopped: boolean; cleanup_pending: boolean; workflow_version_id: string; location_revision: string; runner_id: string; root: string }>(
      `select he.record as execution,r.record as run,c.record as configuration,
         r.workflow_version_id,r.location_revision::text,r.runner_id,r.working_directory as root,
         r.stop_requested_at is not null as stopped,
         exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending) as cleanup_pending
       from harness_executions he join runs r on r.id=he.run_id
       join agent_configuration_versions c on c.id=he.record->>'agentConfigurationVersionId'
       where he.id=$1`, [executionId],
    )
    const row = result.rows[0]
    if (!row) throw new DomainError('WORKER_EXECUTION_NOT_FOUND', 'The accepted execution is unavailable.', 409)
    const execution = HarnessExecutionSchema.parse(row.execution)
    const run = AcceptedWorkflowRunV3Schema.parse(row.run)
    const configuration = AgentConfigurationVersionSchema.parse(row.configuration)
    const treeRow = (await client.query<{ record: unknown }>(
      `select record from run_worktrees where run_id=$1 and allocation_id in ($2,'')
        order by (allocation_id=$2) desc limit 1`, [run.id, execution.id])).rows[0]
    const tree = treeRow ? RunWorktreeSchema.parse(treeRow.record) : undefined
    if (tree && tree.state !== 'active') throw new DomainError('RUN_WORKTREE_CLOSED', 'The Run worktree is closed.', 409)
    if (row.stopped !== false || row.cleanup_pending !== false
      || row.workflow_version_id !== run.workflowVersionId || row.location_revision !== String(run.executionLocation.locationRevision)
      || row.runner_id !== run.executionLocation.runnerId || row.root !== run.executionLocation.rootPath
      || run.executionState === 'completed' || run.executionState === 'interrupted' || !run.executionLocation
      || execution.id !== executionId || execution.runId !== run.id
      || execution.workingDirectory !== (tree?.workingDirectory ?? run.executionLocation.rootPath)
      || configuration.agentId !== execution.agentId || configuration.workspaceId !== run.workspaceId
      || configuration.id !== execution.agentConfigurationVersionId
      || run.agentConfigurationVersionIds[execution.agentId] !== configuration.id) {
      throw new DomainError('WORKER_EXECUTION_IDENTITY_INVALID', 'Native continuation requires the accepted active Run identity.', 409)
    }
    await locations.revalidateRunAuthorization(
      run.authorizationPrincipalId, run.workspaceId, run.workflowId, client,
    )
    await locations.revalidateSnapshot(run.workspaceId, run.executionLocation, requiredLocationAccess([configuration]), signal)
    signal?.throwIfAborted()
  }
}
