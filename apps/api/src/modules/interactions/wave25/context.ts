import {
  AgentConfigurationVersionSchema, DurableInteractionSchema, HarnessExecutionSchema,
  HarnessWorkflowCompatibilitySchema, NativeSessionReferenceSchema,
  type DurableInteraction, type HarnessExecution,
} from '@foreman-code/contracts'
import {
  WorkflowRunV3Schema, WorkflowVersionV3Schema, canonicalGraphJson,
  type AgentGraphExecutionIdentity, type RunGraphScope,
} from '@foreman-code/contracts/wave25'
import { PostgresRepeatReviewerBindings } from '../repeatReviewer.js'
import { DomainError } from '../../errors.js'
import { resolveImmutableApprovalRoute, usesNativeSelfReview } from '../../workflows/approvalRoutes.js'
import { validateReviewerBootstrap } from '../../workflows/reviewerBootstrap.js'
import { beforeGraphCommit, type GraphSqlClient, type GraphTransactionSql } from '../../run-graph/connection.js'
import { RUN_CLEANUP_BOUNDARY_SQL } from './cleanupAuthority.js'

export function fail(code: string, message = 'The approval identity, authority or owner changed.'): never {
  throw new DomainError(code, message, code === 'AUTH_REVOKED' ? 401 : code.endsWith('ACCESS_DENIED') ? 403 : 409)
}
export function identity(e: HarnessExecution): AgentGraphExecutionIdentity {
  return { workflowNodeId: e.workflowNodeId, executionId: e.id, agentId: e.agentId,
    agentConfigurationVersionId: e.agentConfigurationVersionId, attempt: e.attempt }
}
export async function scopeForRun(sql: GraphSqlClient, runId: string): Promise<RunGraphScope> {
  const row = (await sql.query<{ workspace_id: string; workflow_id: string; workflow_version_id: string; execution_semantics_version: number }>(
    `select r.workspace_id,r.workflow_id,r.workflow_version_id,v.execution_semantics_version
     from runs r join workflow_versions v on v.id=r.workflow_version_id where r.id=$1`, [runId])).rows[0]
  if (!row) return fail('APPROVAL_RUN_NOT_FOUND')
  if (row.execution_semantics_version !== 3) return fail('EXECUTION_SEMANTICS_UNSUPPORTED')
  return { runId, workspaceId: row.workspace_id, workflowId: row.workflow_id,
    workflowVersionId: row.workflow_version_id, executionSemanticsVersion: row.execution_semantics_version }
}
export async function runFor(sql: GraphSqlClient, kind: 'interaction' | 'review' | 'execution', id: string): Promise<string> {
  const text = kind === 'review' ? 'select i.run_id from review_jobs j join durable_interactions i on i.id=j.interaction_id where j.id=$1'
    : kind === 'interaction' ? 'select run_id from durable_interactions where id=$1' : 'select run_id from harness_executions where id=$1'
  const row = (await sql.query<{ run_id: string }>(text, [id])).rows[0]
  if (!row) return fail('APPROVAL_SUBJECT_NOT_FOUND')
  return row.run_id
}
export async function isCurrentApprovalRun(sql: GraphSqlClient, runId: string): Promise<boolean> {
  return (await scopeForRun(sql, runId)).executionSemanticsVersion === 3
}
export async function lockInteraction(sql: GraphTransactionSql, id: string): Promise<DurableInteraction> {
  const row = (await sql.query<{ record: unknown }>('select record from durable_interactions where id=$1 for update', [id])).rows[0]
  if (!row) return fail('INTERACTION_NOT_FOUND')
  return DurableInteractionSchema.parse(row.record)
}
export interface ApprovalContext {
  scope: RunGraphScope
  requester: HarnessExecution
  reviewer?: HarnessExecution
  relationshipId?: string
  stopped: boolean
}

/** All records come from immutable Run pins, never a draft, mutable role or cached owner. */
export async function readContext(sql: GraphSqlClient, interaction: DurableInteraction, requireOpen = false, completedReplay = false): Promise<ApprovalContext> {
  const row = (await sql.query<{ run: unknown; version: unknown; stopped: boolean }>(
    `select r.record as run,v.record as version,
       ${RUN_CLEANUP_BOUNDARY_SQL} or r.worker_credentials_closed_at is not null as stopped
     from runs r join workflow_versions v on v.id=r.workflow_version_id
     where r.id=$1 and v.execution_semantics_version=3`, [interaction.runId])).rows[0]
  if (!row) return fail('APPROVAL_RUN_NOT_FOUND')
  const r = WorkflowRunV3Schema.parse(row.run), v = WorkflowVersionV3Schema.parse(row.version)
  if (r.id !== interaction.runId || r.workspaceId !== interaction.workspaceId || r.workflowId !== interaction.workflowId
    || r.workflowVersionId !== v.id || r.workspaceId !== v.workspaceId || r.workflowId !== v.workflowId
    || canonicalGraphJson(r.approval) !== canonicalGraphJson(v.approval)
    || (interaction.kind !== 'work_direction' && canonicalGraphJson(interaction.approval) !== canonicalGraphJson(v.approval))
    || canonicalGraphJson(r.agentConfigurationVersionIds) !== canonicalGraphJson(v.agentConfigurationVersionIds)) return fail('APPROVAL_IDENTITY_MISMATCH')
  const stopped = row.stopped || !['queued', 'running', 'waiting'].includes(r.executionState)
  if (requireOpen && stopped) return fail('EXECUTION_STOPPED')
  const requesterRow = (await sql.query<{ record: unknown; closed: boolean }>(
    `select record,worker_credentials_closed_at is not null as closed from harness_executions
     where run_id=$1 and id=$2`, [r.id, interaction.executionId])).rows[0]
  const requester = requesterRow ? HarnessExecutionSchema.parse(requesterRow.record) : undefined
  if (!requester || requester.runId !== r.id || requester.agentId !== interaction.requestingAgentId
    || (requester.nativeSessionId ?? (interaction.kind === 'work_direction' ? r.id : undefined)) !== interaction.nativeSessionId
    || requester.agentConfigurationVersionId !== v.agentConfigurationVersionIds[requester.agentId]
    || !v.definition.nodes.some((n) => n.id === requester.workflowNodeId && n.kind !== 'job' && n.agentId === requester.agentId)) return fail('APPROVAL_REQUESTER_MISMATCH')
  if (interaction.kind === 'work_direction') {
    if (interaction.approval.handler !== 'user' || interaction.nativeRequestType !== 'workflow/work_direction'
      || interaction.id !== `work-direction-${r.id}` || requester.state !== 'completed'
      || !(await sql.query('select 1 from run_work_direction_waits where run_id=$1', [r.id])).rowCount) {
      return fail('WORK_DIRECTION_WAIT_CONFLICT')
    }
    return { scope: { workspaceId: r.workspaceId, workflowId: r.workflowId, runId: r.id,
      workflowVersionId: v.id, executionSemanticsVersion: 3 }, requester, stopped }
  }
  if (requireOpen && !completedReplay && (requester.state === 'completed' || requesterRow!.closed)) return fail('EXECUTION_STOPPED')
  const route = interaction.approval.handler === 'orchestrator' ? resolveImmutableApprovalRoute(v, requester.workflowNodeId, requester.agentId) : undefined
  if (interaction.approval.handler === 'orchestrator' && !route?.relationshipId) return fail('APPROVAL_DIRECT_CONNECTION_REQUIRED')
  const binding = route ? await new PostgresRepeatReviewerBindings(sql).select(interaction, route.orchestratorNodeId) : undefined
  const reviewer = binding?.execution
  if (route && (!reviewer || reviewer.workflowNodeId !== route.orchestratorNodeId
    || reviewer.agentConfigurationVersionId !== route.reviewerConfigurationVersionId
    || binding?.relationshipId !== route.relationshipId
    || reviewer.state !== 'completed' || reviewer.result?.outcome !== 'succeeded')) return fail('REVIEWER_EXECUTION_NOT_READY')
  const scope: RunGraphScope = { workspaceId: r.workspaceId, workflowId: r.workflowId, runId: r.id,
    workflowVersionId: v.id, executionSemanticsVersion: 3 }
  const saved = (await sql.query<{ approval_relationship_id: string | null; approval_reviewer_execution_id: string | null }>(
    'select approval_relationship_id,approval_reviewer_execution_id from durable_interactions where id=$1', [interaction.id])).rows[0]
  if (saved && (saved.approval_relationship_id !== (route?.relationshipId ?? null)
    || saved.approval_reviewer_execution_id !== (reviewer?.id ?? null))) return fail('APPROVAL_IDENTITY_MISMATCH')
  // Observation and terminal cleanup retain immutable node/configuration pins,
  // but cannot depend on a still-usable native configuration or live credentials.
  // Every new decision/submission calls this boundary with requireOpen=true.
  if (!requireOpen) return { scope, requester, ...(reviewer ? { reviewer, relationshipId: route!.relationshipId! } : {}), stopped }
  const actors = [requester, ...(reviewer ? [reviewer] : [])]
  const configs = (await sql.query<{ record: unknown }>(
    'select record from agent_configuration_versions where workspace_id=$1 and id=any($2::text[]) order by id',
    [r.workspaceId, actors.map((e) => e.agentConfigurationVersionId)])).rows.map((item) => AgentConfigurationVersionSchema.parse(item.record))
  for (const e of actors) {
    const c = configs.find((item) => item.id === e.agentConfigurationVersionId)
    if (!c || c.workspaceId !== r.workspaceId || c.agentId !== e.agentId || !c.productRole) return fail('APPROVAL_CONFIGURATION_MISMATCH')
    HarnessWorkflowCompatibilitySchema.parse({ configuration: c.harness, workflowApprovalHandler: v.approval.handler,
      designatedOrchestrator: e.id === reviewer?.id })
    const native = (await sql.query<{ reference: unknown; finalized: boolean }>(
      'select reference,workflow_finalized_at is not null as finalized from execution_native_sessions where execution_id=$1', [e.id])).rows[0]
    const session = NativeSessionReferenceSchema.safeParse(native?.reference)
    if (!session.success || session.data.harness !== c.harness.harness || session.data.nativeSessionId !== e.nativeSessionId) return fail('APPROVAL_SESSION_MISMATCH')
    if (e.id === requester.id) {
      if (session.data.providerVersion !== interaction.providerVersion || session.data.harness !== interaction.harness
        || usesNativeSelfReview(c.harness)) return fail('APPROVAL_NATIVE_ROUTE_MISMATCH')
    } else {
      if (!native?.finalized || (c.productRole !== 'master' && c.productRole !== 'orchestrator')) return fail('REVIEWER_EXECUTION_NOT_READY')
      validateReviewerBootstrap(v.definition, v.approval, c.harness, v.entryNodeId)
    }
  }
  return { scope: { workspaceId: r.workspaceId, workflowId: r.workflowId, runId: r.id,
    workflowVersionId: v.id, executionSemanticsVersion: 3 }, requester, stopped,
    ...(reviewer ? { reviewer } : {}), ...(route?.relationshipId ? { relationshipId: route.relationshipId } : {}) }
}

export async function assertBudget(sql: GraphSqlClient, interaction: DurableInteraction): Promise<void> {
  const row = (await sql.query<{ active: boolean; graph_thread_id: string }>(
    `select graph_thread_id,stopped_at is null and active_elapsed_ms+
       coalesce(extract(epoch from(clock_timestamp()-active_started_at))*1000,0)<active_timeout_ms as active
     from approval_execution_state where execution_id=$1`, [interaction.executionId])).rows[0]
  if (!row?.active || row.graph_thread_id !== interaction.graphThreadId) return fail('EXECUTION_ACTIVE_TIMEOUT')
}

/** A SQL effect may release its lease in the mutation, but may not commit after
 * the original locked owner's expiry. The subject lock prevents takeover while
 * this final check runs; expiry is still checked against the database clock. */
export function requireLeaseAtCommit(sql: GraphTransactionSql, expiresAt: string | Date, code: string): void {
  beforeGraphCommit(sql, async () => {
    const live = await sql.query('select 1 where $1::timestamptz>clock_timestamp()', [expiresAt])
    if (live.rowCount !== 1) return fail(code)
  })
}
