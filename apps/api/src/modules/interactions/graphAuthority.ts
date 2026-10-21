import {
  AgentConfigurationVersionSchema,
  HarnessExecutionSchema,
  type DurableInteraction,
  type DirectApprovalConnection,
} from '@foreman-code/contracts'
import { AcceptedWorkflowRunV3Schema, WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import type { GraphSqlClient } from '../run-graph/connection.js'

import { DomainError } from '../errors.js'
import { assertRepeatReviewerBinding, PostgresRepeatReviewerBindings } from './repeatReviewer.js'
import { resolveImmutableApprovalRoute, usesNativeSelfReview } from '../workflows/approvalRoutes.js'

type RequestIdentity = Pick<DurableInteraction,
  'workspaceId' | 'workflowId' | 'runId' | 'executionId' | 'requestingAgentId' | 'approval'>
  & Partial<Pick<DurableInteraction, 'nativeSessionId' | 'harness'>>

function denied(): never {
  throw new DomainError('INTERACTION_ACCESS_DENIED',
    'Orchestrator review requires the exact requesting node to have an accepted approval relationship to its designated Orchestrator in this Run’s saved workflow version.', 403)
}

/**
 * Use only immutable Run/version/configuration pins, never the editable board.
 * Call with the decision transaction's client to retain its credential/Stop locks.
 * Native self-review never enters this routed-interaction boundary.
 */
export async function assertOrchestratorGraphAuthority(
  client: GraphSqlClient,
  interaction: RequestIdentity,
  reviewer: { executionId?: string; principalId?: string; nativeSessionId?: string } = {},
): Promise<DirectApprovalConnection | undefined> {
  if (interaction.approval.handler !== 'orchestrator') return undefined
  const reviewerId = interaction.approval.designatedOrchestratorAgentId
  if (!reviewerId || reviewerId === interaction.requestingAgentId) return denied()
  const found = await client.query<{
    run_record: unknown; version_record: unknown; execution_record: unknown; configuration_record: unknown; requester_configuration_record: unknown; workflow_node_id: string
  }>(
    `select r.record as run_record, v.record as version_record,
            e.record as execution_record, e.workflow_node_id, c.record as configuration_record,
            rc.record as requester_configuration_record
     from harness_executions e
     join runs r on r.id=e.run_id
     join workflow_versions v on v.id=r.workflow_version_id
       and v.workspace_id=r.workspace_id and v.workflow_id=r.workflow_id
     join agent_configuration_versions c on c.id=(r.record->'agentConfigurationVersionIds'->>$6)
       and c.workspace_id=r.workspace_id and c.agent_id=$6
     left join agent_configuration_versions rc on rc.id=e.record->>'agentConfigurationVersionId'
       and rc.workspace_id=r.workspace_id and rc.agent_id=e.agent_id
     where e.id=$1 and r.id=$2 and r.workspace_id=$3 and r.workflow_id=$4 and e.agent_id=$5`,
    [interaction.executionId, interaction.runId, interaction.workspaceId, interaction.workflowId,
      interaction.requestingAgentId, reviewerId],
  )
  const row = found.rows[0]
  const run = AcceptedWorkflowRunV3Schema.safeParse(row?.run_record)
  const version = WorkflowVersionV3Schema.safeParse(row?.version_record)
  const execution = HarnessExecutionSchema.safeParse(row?.execution_record)
  const configuration = AgentConfigurationVersionSchema.safeParse(row?.configuration_record)
  if (found.rows.length !== 1 || !run.success || !version.success || !execution.success || !configuration.success) return denied()
  const r = run.data
  const v = version.data
  const e = execution.data
  const c = configuration.data
  const requesterConfiguration = AgentConfigurationVersionSchema.safeParse(row?.requester_configuration_record)
  if (!interaction.nativeSessionId || interaction.nativeSessionId !== e.nativeSessionId || !e.nativeSessionId || !interaction.harness
    || !requesterConfiguration.success || requesterConfiguration.data.id !== e.agentConfigurationVersionId
    || requesterConfiguration.data.workspaceId !== r.workspaceId || requesterConfiguration.data.agentId !== e.agentId
    || requesterConfiguration.data.harness.harness !== interaction.harness
    || usesNativeSelfReview(requesterConfiguration.data.harness)) return denied()
  if (r.id !== interaction.runId || r.workspaceId !== interaction.workspaceId || r.workflowId !== interaction.workflowId
    || v.id !== r.workflowVersionId || v.workspaceId !== r.workspaceId || v.workflowId !== r.workflowId
    || v.definition.id !== r.workflowId || v.definition.workspaceId !== r.workspaceId
    || e.workflowNodeId !== row?.workflow_node_id || e.id !== interaction.executionId || e.runId !== r.id || e.agentId !== interaction.requestingAgentId
    || e.agentConfigurationVersionId !== r.agentConfigurationVersionIds[e.agentId]
    || e.agentConfigurationVersionId !== v.agentConfigurationVersionIds[e.agentId]
    || c.id !== r.agentConfigurationVersionIds[reviewerId] || c.id !== v.agentConfigurationVersionIds[reviewerId]
    || c.agentId !== reviewerId || (c.productRole !== 'master' && c.productRole !== 'orchestrator')
    || r.approval?.handler !== 'orchestrator' || r.approval.designatedOrchestratorAgentId !== reviewerId
    || v.approval?.handler !== 'orchestrator' || v.approval.designatedOrchestratorAgentId !== reviewerId
    || v.definition.approval?.handler !== 'orchestrator'
    || v.definition.approval.designatedOrchestratorAgentId !== reviewerId) return denied()
  const connection = resolveImmutableApprovalRoute(v, e.workflowNodeId, e.agentId)
  if (!connection || connection.reviewerAgentId !== reviewerId
    || connection.requestingConfigurationVersionId !== e.agentConfigurationVersionId
    || connection.reviewerConfigurationVersionId !== c.id) return denied()

  // A reviewer credential belongs to one execution occurrence, not every node
  // using that Agent. Existing authentication still checks its live eligibility.
  if (reviewer.executionId || reviewer.principalId || reviewer.nativeSessionId) {
    let executionId = reviewer.executionId
    if (!executionId && !reviewer.principalId && reviewer.nativeSessionId) {
      // Business activations can share a native session; select the request's owner first.
      const binding = await new PostgresRepeatReviewerBindings(client).select(interaction, connection.orchestratorNodeId)
      executionId = binding.execution.id
    }
    const owner = await client.query<{ id: string; record: unknown }>(
      `select e.id,e.record from harness_executions e
       where e.run_id=$1 and e.agent_id=$2 and e.workflow_node_id=$3
         and ($4::text is null or e.id=$4)
         and ($5::text is null or exists (
           select 1 from worker_credential_bindings b where b.principal_id=$5
             and b.execution_id=e.id and b.run_id=e.run_id and b.agent_id=e.agent_id
             and b.revoked_at is null))
         and ($6::text is null or e.record->>'nativeSessionId'=$6)`,
      [r.id, reviewerId, connection.orchestratorNodeId, executionId ?? null,
        reviewer.principalId ?? null, reviewer.nativeSessionId ?? null],
    )
    const bound = HarnessExecutionSchema.safeParse(owner.rows[0]?.record)
    if (owner.rows.length !== 1 || !bound.success || bound.data.id !== owner.rows[0]?.id || bound.data.runId !== r.id
      || bound.data.workflowNodeId !== connection.orchestratorNodeId || bound.data.agentId !== reviewerId
      || bound.data.agentConfigurationVersionId !== c.id
      || (reviewer.nativeSessionId !== undefined && bound.data.nativeSessionId !== reviewer.nativeSessionId)
      || !bound.data.nativeSessionId) return denied()
    await assertRepeatReviewerBinding(client, interaction, connection.orchestratorNodeId, bound.data.id)
  }
  return connection
}
