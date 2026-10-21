import { AgentConfigurationVersionSchema, HarnessExecutionSchema, NativeSessionReferenceSchema,
  DurableInteractionSchema, ReviewJobSchema } from '@foreman-code/contracts'
import { WorkflowRunV3Schema, WorkflowVersionV3Schema, sameWorkflowValue } from '@foreman-code/contracts/wave25'
import type { DispatchIntent } from '@foreman-code/contracts/node-placement'
import type { RemoteOperationReceipt, RemoteReviewerRequest } from '@foreman-code/contracts/remote-execution'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { PostgresRepeatReviewerBindings } from '../interactions/repeatReviewer.js'
import { DomainError } from '../errors.js'

function denied(): never {
  throw new DomainError('REMOTE_REVIEWER_DENIED', 'The original reviewer assignment is unavailable.', 403)
}

export async function remoteReviewerPolicy(sql: GraphSqlClient, intent: DispatchIntent) {
  const row = (await sql.query<{ run: unknown; version: unknown; execution: unknown;
    configuration: unknown; reference: unknown; finalized: boolean }>(`select r.record as run,v.record as version,
      e.record as execution,c.record as configuration,s.reference,s.workflow_finalized_at is not null as finalized
    from runs r join workflow_versions v on v.id=r.workflow_version_id
    join harness_executions e on e.run_id=r.id and e.id=$2
    join agent_configuration_versions c on c.id=e.record->>'agentConfigurationVersionId'
    left join execution_native_sessions s on s.execution_id=e.id where r.id=$1`,
  [intent.runId, intent.executionId])).rows[0]
  if (!row) return undefined
  const run = WorkflowRunV3Schema.parse(row.run)
  const version = WorkflowVersionV3Schema.parse(row.version)
  const execution = HarnessExecutionSchema.parse(row.execution)
  const configuration = AgentConfigurationVersionSchema.parse(row.configuration)
  if (run.approval?.handler !== 'orchestrator' || run.approval.designatedOrchestratorAgentId !== execution.agentId
    || version.entryNodeId !== execution.workflowNodeId
    || (configuration.productRole !== 'master' && configuration.productRole !== 'orchestrator')) return undefined
  if (!version.definition.nodes.some(node => node.kind !== 'job' && version.definition.edges.some(edge =>
    edge.kind === 'approval' && edge.source === version.entryNodeId && edge.target === node.id))) return undefined
  if (run.id !== intent.runId || execution.id !== intent.executionId || execution.runId !== run.id
    || execution.workflowNodeId !== intent.nodeId || execution.attempt !== intent.technicalAttempt
    || configuration.id !== execution.agentConfigurationVersionId
    || configuration.agentId !== execution.agentId || configuration.workspaceId !== run.workspaceId
    || run.agentConfigurationVersionIds[execution.agentId] !== configuration.id
    || version.agentConfigurationVersionIds[execution.agentId] !== configuration.id
    || version.workspaceId !== run.workspaceId || version.workflowId !== run.workflowId
    || version.id !== run.workflowVersionId || !sameWorkflowValue(run.approval, version.approval)) denied()
  return { run, version, execution, configuration,
    session: row.reference ? NativeSessionReferenceSchema.parse(row.reference) : undefined, finalized: row.finalized }
}

export async function assertRemoteReviewAssignment(sql: GraphSqlClient, intent: DispatchIntent,
  review: RemoteReviewerRequest): Promise<void> {
  const policy = await remoteReviewerPolicy(sql, intent)
  if (!policy || policy.execution.state !== 'completed' || policy.execution.result?.outcome !== 'succeeded'
    || !policy.finalized || !sameWorkflowValue(policy.session, review.session)
    || !['running', 'waiting'].includes(policy.run.executionState) || policy.run.outcome !== 'pending') denied()
  const row = (await sql.query<{ record: unknown; execution_id: string; live: boolean }>(`select record,execution_id,
    lease_expires_at>clock_timestamp() as live from review_jobs where id=$1 for share`, [review.jobId])).rows[0]
  const job = ReviewJobSchema.parse(row?.record)
  if (!row?.live || row.execution_id !== intent.executionId || job.leaseToken !== review.leaseToken
    || job.correlationId !== review.correlationId || job.interactionId !== review.interactionId
    || job.reviewerAgentId !== review.reviewerAgentId || job.reviewerAgentId !== policy!.execution.agentId
    || job.nativeSessionId !== review.session.nativeSessionId || job.provider !== review.session.harness
    || !['leased', 'submitted', 'acknowledged', 'uncertain'].includes(job.state)) denied()
  const interactionRow = (await sql.query<{ record: unknown }>(
    'select record from durable_interactions where id=$1 for share', [job.interactionId])).rows[0]
  const interaction = DurableInteractionSchema.parse(interactionRow?.record)
  const selected = await new PostgresRepeatReviewerBindings(sql).select(interaction, policy!.execution.workflowNodeId)
  if (selected.execution.id !== intent.executionId || interaction.runId !== intent.runId
    || interaction.requestingAgentId === review.reviewerAgentId) denied()
  const lane = await sql.query(`select 1 from native_session_lanes where harness=$1 and native_session_id=$2
    and owner_agent_id=$3 and record->>'correlationId'=$4
    and (record->>'leaseExpiresAt')::timestamptz>clock_timestamp() for share`,
  [review.session.harness, review.session.nativeSessionId, review.reviewerAgentId, review.correlationId])
  if (lane.rowCount !== 1) denied()
}

export async function assertRemoteReviewerReceipt(sql: GraphSqlClient, receipt: RemoteOperationReceipt): Promise<void> {
  if (!receipt.retainedReviewer) return
  const policy = await remoteReviewerPolicy(sql, receipt.intent)
  if (!policy || policy.execution.agentId !== receipt.retainedReviewer.agentId
    || policy.execution.nativeSessionId !== receipt.native?.sessionId
    || policy.execution.state === 'completed' && !sameWorkflowValue(policy.execution.result, receipt.retainedReviewer.result)) denied()
  for (const turn of receipt.reviewTurns ?? []) {
    const row = (await sql.query<{ record: unknown; execution_id: string }>(
      'select record,execution_id from review_jobs where id=$1 for share', [turn.assignment.jobId])).rows[0]
    const job = ReviewJobSchema.parse(row?.record)
    if (row?.execution_id !== receipt.intent.executionId || job.correlationId !== turn.assignment.correlationId
      || job.interactionId !== turn.assignment.interactionId || job.reviewerAgentId !== turn.assignment.reviewerAgentId
      || job.nativeSessionId !== turn.assignment.session.nativeSessionId || job.provider !== turn.assignment.session.harness
      || !sameWorkflowValue(policy!.session, turn.assignment.session)) denied()
  }
}

/** Closing the completed reviewer only releases its retained process; the Run continues. */
export async function canCloseRetainedRemoteReviewer(sql: GraphSqlClient, receipt: RemoteOperationReceipt): Promise<boolean> {
  const retained = receipt.retainedReviewer
  if (!retained || !receipt.native) return false
  const policy = await remoteReviewerPolicy(sql, receipt.intent)
  if (!policy || !policy.finalized || policy.execution.state !== 'completed'
    || policy.execution.result?.outcome !== 'succeeded'
    || !['running', 'waiting'].includes(policy.run.executionState) || policy.run.outcome !== 'pending'
    || policy.execution.agentId !== retained.agentId
    || policy.execution.nativeSessionId !== receipt.native.sessionId
    || !policy.session || policy.session.nativeSessionId !== receipt.native.sessionId
    || policy.session.harness !== policy.configuration.harness.harness
    || retained.workflowTurnId !== receipt.native.turnId
    || !sameWorkflowValue(policy.execution.result, retained.result)) return false
  const pending = await sql.query(`select 1 from review_jobs where execution_id=$1 and state<>'completed'
    and (state<>'failed' or record->'cleanup'->>'completedAt' is null) limit 1`, [receipt.intent.executionId])
  return pending.rowCount === 0
}
