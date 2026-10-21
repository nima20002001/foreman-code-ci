import type pg from 'pg'
import { AgentConfigurationVersionSchema, HarnessExecutionSchema } from '@foreman-code/contracts'
import { AcceptedWorkflowRunV3Schema } from '@foreman-code/contracts/wave25'
import type { WorkspaceLocationService } from '../workspaces/location.js'
import { continuationValidator } from '../runs/continuation.js'
import { interactionConnection } from '../interactions/connection.js'
import { DomainError } from '../errors.js'
import type { AcceptedExecutionBinding } from './nativeComposition.js'

/** Mandatory live owner/device/key/root/config/source revalidation. The host
 * implementation performs destination-native checks; main filesystem checks
 * must never be substituted for a remote root. No native launch occurs here. */
export interface AcceptedDestinationContinuation {
  assertCurrent(binding: AcceptedExecutionBinding, signal?: AbortSignal, purpose?: 'restart'): Promise<void>
}
export function placedContinuationValidator(pool: pg.Pool, locations: WorkspaceLocationService,
  managers: { prepare(executionId: string): Promise<AcceptedExecutionBinding | null> }, destination: AcceptedDestinationContinuation) {
  const local = continuationValidator(pool, locations)
  const validate = async (executionId: string, options: { signal?: AbortSignal; purpose?: 'restart' }): Promise<void> => {
    const { signal, purpose } = options
    const binding = await managers.prepare(executionId)
    if (!binding) return local(executionId, signal)
    const client = interactionConnection.getStore() ?? pool
    const rows = await client.query<{ execution: unknown; run: unknown; configuration: unknown; stopped: boolean; cleanup_pending: boolean }>(
      `select he.record as execution,r.record as run,c.record as configuration,
       r.stop_requested_at is not null as stopped,
       exists(select 1 from run_cleanup_intents i where i.run_id=r.id and i.pending) as cleanup_pending
       from harness_executions he join runs r on r.id=he.run_id
       join agent_configuration_versions c on c.id=he.record->>'agentConfigurationVersionId' where he.id=$1`, [executionId])
    const row = rows.rows[0]
    if (!row || rows.rows.length !== 1) throw new DomainError('WORKER_EXECUTION_NOT_FOUND', 'Exact accepted execution is unavailable.', 409)
    const execution = HarnessExecutionSchema.parse(row.execution), run = AcceptedWorkflowRunV3Schema.parse(row.run)
    const configuration = AgentConfigurationVersionSchema.parse(row.configuration)
    const payload = binding.placement.payload
    if (row.stopped || row.cleanup_pending || ['completed', 'interrupted'].includes(run.executionState)
      || execution.id !== executionId || execution.runId !== run.id || binding.intent.runId !== run.id
      || execution.workflowNodeId !== binding.placement.nodeId || payload.kind !== 'agent'
      || execution.workingDirectory !== (binding.executionPlacement?.workingTree.canonicalCwd ?? binding.placement.destination.canonicalCwd)
      || execution.agentId !== payload.agentId || configuration.agentId !== execution.agentId
      || configuration.workspaceId !== run.workspaceId || configuration.id !== execution.agentConfigurationVersionId
      || configuration.id !== payload.agentConfigurationVersionId || run.agentConfigurationVersionIds[execution.agentId] !== configuration.id) {
      throw new DomainError('WORKER_EXECUTION_IDENTITY_INVALID', 'Native continuation requires the exact accepted host/configuration identity.', 409)
    }
    await locations.revalidateRunAuthorization(run.authorizationPrincipalId, run.workspaceId, run.workflowId, client)
    await destination.assertCurrent(binding, signal, purpose)
    signal?.throwIfAborted()
  }
  return Object.assign((executionId: string, signal?: AbortSignal) =>
    validate(executionId, signal ? { signal } : {}), {
    forRestart: (executionId: string) => validate(executionId, { purpose: 'restart' }),
  })
}
