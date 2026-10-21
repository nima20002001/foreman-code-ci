import { isDeepStrictEqual } from 'node:util'
import { HarnessExecutionSchema, type DurableInteraction, type HarnessExecution } from '@foreman-code/contracts'
import { AcceptedCurrentNodeResultSchema, NodeResolutionSchema, RepeatOccurrenceV1Schema,
  CurrentRunVersionSnapshotSchema, WorkActivationInputSchema, WorkRequestSchema, WorkReturnSchema,
  WorkLimitDenialSchema, workConnectionForRequest, type WorkActivationInput, type WorkRequest,
  type WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { assertRepeatExecution, repeatDigest, repeatExecutionIdentity, repeatSlotId, workActivationSlotId,
  type RepeatNodeRef, type RepeatScope } from '../runs/repeatResolution.js'
import { DomainError } from '../errors.js'

type RepeatReviewRequest = Pick<DurableInteraction,
  'workspaceId' | 'workflowId' | 'runId' | 'executionId' | 'requestingAgentId' | 'approval'>
  & Partial<Pick<DurableInteraction, 'nativeSessionId' | 'harness'>>

export interface RepeatReviewerBinding {
  execution: HarnessExecution
  relationshipId: string
  requesterOccurrenceId: string | null
  reviewerOccurrenceId: string | null
}
export interface RepeatReviewerBindings {
  select(interaction: RepeatReviewRequest, reviewerNodeId: string): Promise<RepeatReviewerBinding>
}

function conflict(): never {
  throw new DomainError('REPEAT_REVIEW_IDENTITY_CONFLICT',
    'Review requires the accepted execution of the exact immutable approval relationship and occurrence.', 409)
}

/** Approval is authority, not a scheduling edge. Do not select a latest attempt
 * or a reviewer from another live block. Cross-block reviewer scopes need an
 * explicit immutable export binding; they are deliberately not guessed here. */
export function repeatReviewerOccurrence(version: WorkflowVersionV3, requester: RepeatNodeRef,
  reviewerNodeId: string): string | null {
  const reviewerBlock = version.definition.repeat?.blocks.find((block) => block.nodeIds.includes(reviewerNodeId))
  if (!reviewerBlock) return null
  const requesterBlock = version.definition.repeat?.blocks.find((block) => block.nodeIds.includes(requester.nodeId))
  if (requesterBlock?.id !== reviewerBlock.id || requester.occurrence?.blockId !== reviewerBlock.id) {
    throw new DomainError('REPEAT_REVIEW_SCOPE_UNSUPPORTED',
      'An in-block reviewer cannot be selected for another scope without an exact exported assignment.', 409)
  }
  return requester.occurrence.occurrenceId
}

interface ExecutionRow {
  record: unknown; identity: unknown; accepted: boolean; execution_id: string; run_id: string
  workflow_node_id: string; agent_id: string; attempt: number; slot_id: string
  occurrence_id: string | null; execution_occurrence_id: string | null; identity_occurrence_id: string | null
  technical_attempt: number; input_json: string; input_digest: string; occurrence_record: unknown | null
  work_activation_id: string | null; execution_activation_id: string | null; identity_activation_id: string | null
  activation_record: unknown | null
}

interface ReviewExecution {
  execution: HarnessExecution
  ref: RepeatNodeRef
  accepted: boolean
  work: WorkActivationInput['work'] | null
}

/** Read only. The decision caller supplies its existing credential/Stop-locked
 * transaction; enqueue supplies its normal pool. This is not a launch grant. */
async function loadExecution(sql: GraphSqlClient, scope: RepeatScope, version: WorkflowVersionV3,
  executionId: string): Promise<ReviewExecution> {
  const rows = await sql.query<ExecutionRow>(`select e.record,x.identity,e.accepted,e.id as execution_id,
    e.run_id,e.workflow_node_id,e.agent_id,e.attempt,s.slot_id,s.occurrence_id,
    e.repeat_occurrence_id as execution_occurrence_id,x.occurrence_id as identity_occurrence_id,x.technical_attempt,
    s.input_json,s.input_digest,o.record as occurrence_record,s.work_activation_id,
    e.work_activation_id as execution_activation_id,x.work_activation_id as identity_activation_id,
    a.record as activation_record
    from harness_executions e join run_repeat_executions x on x.execution_id=e.id and x.run_id=e.run_id
    join run_repeat_slots s on s.slot_id=x.slot_id and s.run_id=e.run_id and s.workflow_node_id=e.workflow_node_id
    left join run_repeat_occurrences o on o.occurrence_id=s.occurrence_id and o.run_id=e.run_id
    left join run_work_activations a on a.activation_id=s.work_activation_id and a.run_id=e.run_id
    where e.id=$1 and e.run_id=$2`, [executionId, scope.runId])
  const row = rows.rows[0]
  if (rows.rows.length !== 1 || !row) return conflict()
  const execution = HarnessExecutionSchema.parse(row.record)
  const occurrence = row.occurrence_id === null ? null : RepeatOccurrenceV1Schema.parse(row.occurrence_record).identity
  const ref: RepeatNodeRef = { nodeId: execution.workflowNodeId, occurrence }
  assertRepeatExecution(version, scope, ref, execution)
  const identity = { ...repeatExecutionIdentity(execution), ...(occurrence ? { occurrence } : {}) }
  const activationId = row.work_activation_id ?? null
  const work = version.definition.handoffs ? WorkActivationInputSchema.parse(execution.input).work : null
  const expectedSlotId = activationId ? workActivationSlotId(scope.runId, activationId) : repeatSlotId(scope.runId, ref)
  if (execution.id !== executionId || row.execution_id !== execution.id || row.run_id !== scope.runId
    || row.workflow_node_id !== execution.workflowNodeId || row.agent_id !== execution.agentId || row.attempt !== execution.attempt
    || row.execution_occurrence_id !== row.occurrence_id || row.identity_occurrence_id !== row.occurrence_id
    || row.technical_attempt !== execution.attempt || row.slot_id !== expectedSlotId
    || activationId !== (row.execution_activation_id ?? null) || activationId !== (row.identity_activation_id ?? null)
    || (work ? !activationId || occurrence !== null || work.activation.activationId !== activationId
      || work.activation.workflowNodeId !== execution.workflowNodeId
      || !isDeepStrictEqual(work.activation.scope, scope)
      || !isDeepStrictEqual(work.activation, row.activation_record) : activationId !== null)
    || (occurrence?.occurrenceId ?? null) !== row.occurrence_id
    || !isDeepStrictEqual(row.identity, identity)
    || repeatDigest(execution.input, 4 * 1024 * 1024) !== row.input_digest
    || !isDeepStrictEqual(JSON.parse(row.input_json), execution.input)) return conflict()
  return { execution, ref, accepted: row.accepted, work }
}

async function acceptedWorkExecution(sql: GraphSqlClient, scope: RepeatScope, version: WorkflowVersionV3,
  source: { executionId: string; activationId: string; nodeId: string; digest: string; result?: unknown }): Promise<ReviewExecution> {
  const selected = await loadExecution(sql, scope, version, source.executionId)
  const result = await sql.query<{ result_json: string; result_digest: string }>(
    `select result_json,result_digest from run_work_results
      where run_id=$1 and execution_id=$2 and activation_id=$3`,
    [scope.runId, source.executionId, source.activationId])
  const accepted = result.rows[0]
  if (result.rows.length !== 1 || !accepted || !selected.accepted || selected.execution.state !== 'completed'
    || selected.execution.result?.outcome !== 'succeeded'
    || selected.work?.activation.activationId !== source.activationId
    || selected.execution.workflowNodeId !== source.nodeId
    || accepted.result_digest !== source.digest
    || repeatDigest(selected.execution.result, 64 * 1024) !== source.digest
    || !isDeepStrictEqual(AcceptedCurrentNodeResultSchema.parse(JSON.parse(accepted.result_json)), selected.execution.result)
    || source.result !== undefined && !isDeepStrictEqual(source.result, selected.execution.result)) return conflict()
  return selected
}

async function workRequest(sql: GraphSqlClient, scope: RepeatScope, version: WorkflowVersionV3,
  requestId: string, frozen?: WorkRequest): Promise<WorkRequest> {
  const rows = await sql.query<{ record: unknown }>(
    'select record from run_work_requests where run_id=$1 and request_id=$2', [scope.runId, requestId])
  if (rows.rows.length !== 1) return conflict()
  const request = WorkRequestSchema.parse(rows.rows[0]!.record)
  const connection = workConnectionForRequest(version.definition, request.requesterNodeId, request.destinationNodeId)
  if (request.requestId !== requestId || !isDeepStrictEqual(request.scope, scope)
    || connection?.id !== request.relationshipId || frozen && !isDeepStrictEqual(frozen, request)) return conflict()
  return request
}

async function workParents(sql: GraphSqlClient, scope: RepeatScope, version: WorkflowVersionV3,
  current: ReviewExecution): Promise<ReviewExecution[]> {
  if (!current.work) return conflict()
  const work = current.work
  const parents: ReviewExecution[] = []
  async function addRequest(request: WorkRequest, result?: unknown): Promise<void> {
    parents.push(await acceptedWorkExecution(sql, scope, version, {
      executionId: request.requesterExecutionId, activationId: request.requesterActivationId,
      nodeId: request.requesterNodeId, digest: request.payloadDigest, result,
    }))
  }
  if (work.kind === 'work_request' || work.kind === 'join') {
    const sources = work.kind === 'join' ? work.sources : [work]
    for (const source of sources) {
      const request = await workRequest(sql, scope, version, source.request.requestId, source.request)
      if (request.destinationActivationId !== work.activation.activationId
        || request.destinationNodeId !== current.execution.workflowNodeId) return conflict()
      await addRequest(request, source.acceptedSourceResult)
    }
  } else if (work.kind === 'work_return') {
    const rows = await sql.query<{ record: unknown }>(
      'select record from run_work_returns where run_id=$1 and return_id=$2', [scope.runId, work.returned.returnId])
    if (rows.rows.length !== 1 || !isDeepStrictEqual(WorkReturnSchema.parse(rows.rows[0]!.record), work.returned)) {
      return conflict()
    }
    const request = await workRequest(sql, scope, version, work.returned.requestId)
    const parent = (await sql.query<{ request_id: string | null }>(
      'select work_parent_request($1,$2) as request_id',
      [scope.runId, work.returned.sourceActivationId])).rows[0]
    if (request.requesterActivationId !== work.returned.requesterActivationId
      || request.requesterNodeId !== current.execution.workflowNodeId
      || parent?.request_id !== request.requestId
      || work.returned.continuationActivationId !== work.activation.activationId
      || work.returned.outcome !== 'needs_changes') return conflict()
    await acceptedWorkExecution(sql, scope, version, {
      executionId: work.returned.sourceExecutionId, activationId: work.returned.sourceActivationId,
      nodeId: request.destinationNodeId, digest: work.returned.acceptedResultDigest, result: work.acceptedSourceResult,
    })
    await addRequest(request)
  } else if (work.kind === 'limit_denial') {
    const rows = await sql.query<{ record: unknown }>(
      'select record from run_work_denials where run_id=$1 and denial_id=$2', [scope.runId, work.denial.denialId])
    if (rows.rows.length !== 1 || !isDeepStrictEqual(WorkLimitDenialSchema.parse(rows.rows[0]!.record), work.denial)) {
      return conflict()
    }
    parents.push(await acceptedWorkExecution(sql, scope, version, {
      executionId: work.denial.requesterExecutionId, activationId: work.denial.requesterActivationId,
      nodeId: current.execution.workflowNodeId, digest: work.denial.payloadDigest, result: work.acceptedSourceResult,
    }))
  } else return conflict()
  return parents
}

/** Follow accepted causes, so sibling work and later reactivations cannot replace the review owner. */
async function workReviewer(sql: GraphSqlClient, scope: RepeatScope, version: WorkflowVersionV3,
  requester: ReviewExecution, reviewerNodeId: string): Promise<HarnessExecution> {
  const visiting = new Set<string>()
  const selected = new Map<string, HarnessExecution>()
  async function visit(current: ReviewExecution): Promise<HarnessExecution> {
    const cached = selected.get(current.execution.id)
    if (cached) return cached
    if (visiting.has(current.execution.id) || !current.work) return conflict()
    visiting.add(current.execution.id)
    if (current.execution.workflowNodeId === reviewerNodeId) {
      if (!current.accepted) return conflict()
      visiting.delete(current.execution.id)
      selected.set(current.execution.id, current.execution)
      return current.execution
    }
    const parents = await workParents(sql, scope, version, current)
    const reviewers: HarnessExecution[] = []
    for (const parent of parents) reviewers.push(await visit(parent))
    const reviewer = reviewers[0]
    if (!reviewer || reviewers.some((value) => value.id !== reviewer.id)) return conflict()
    visiting.delete(current.execution.id)
    selected.set(current.execution.id, reviewer)
    return reviewer
  }
  return visit(requester)
}

export class PostgresRepeatReviewerBindings implements RepeatReviewerBindings {
  constructor(private readonly sql: GraphSqlClient) {}

  async select(interaction: RepeatReviewRequest, reviewerNodeId: string): Promise<RepeatReviewerBinding> {
    const snapshot = await this.sql.query<{ run_record: unknown; version_record: unknown; run_id: string;
      workspace_id: string; workflow_id: string; workflow_version_id: string }>(`select r.record as run_record,
      v.record as version_record,r.id as run_id,r.workspace_id,r.workflow_id,r.workflow_version_id
      from runs r join workflow_versions v on v.id=r.workflow_version_id
        and v.workflow_id=r.workflow_id and v.workspace_id=r.workspace_id where r.id=$1`, [interaction.runId])
    const row = snapshot.rows[0]
    if (snapshot.rows.length !== 1 || !row) return conflict()
    const { run, version } = CurrentRunVersionSnapshotSchema.parse({ run: row.run_record, version: row.version_record })
    if (!('executionSemanticsVersion' in version) || version.executionSemanticsVersion !== 3
      || !('executionSemanticsVersion' in run) || run.executionSemanticsVersion !== 3
      || row.run_id !== interaction.runId || run.id !== row.run_id || row.workspace_id !== interaction.workspaceId
      || row.workflow_id !== interaction.workflowId || row.workflow_version_id !== version.id
      || run.workspaceId !== row.workspace_id || run.workflowId !== row.workflow_id) return conflict()
    const scope: RepeatScope = { runId: run.id, workspaceId: run.workspaceId, workflowId: run.workflowId,
      workflowVersionId: run.workflowVersionId, executionSemanticsVersion: 3 }
    const requester = await loadExecution(this.sql, scope, version, interaction.executionId)
    if (!interaction.nativeSessionId || requester.execution.agentId !== interaction.requestingAgentId
      || requester.execution.nativeSessionId !== interaction.nativeSessionId
      || interaction.approval.handler !== 'orchestrator'
      || !isDeepStrictEqual(interaction.approval, run.approval)) return conflict()
    const reviewerId = interaction.approval.designatedOrchestratorAgentId
    const reviewer = version.definition.nodes.find((node) => node.id === reviewerNodeId && node.kind !== 'job' && node.agentId === reviewerId)
    const relationships = version.definition.edges.filter((edge) => edge.kind === 'approval'
      && edge.source === reviewerNodeId && edge.target === requester.execution.workflowNodeId)
    if (!reviewer || reviewerId === requester.execution.agentId || relationships.length !== 1) return conflict()
    if (version.definition.handoffs) {
      const execution = await workReviewer(this.sql, scope, version, requester, reviewerNodeId)
      if (execution.agentId !== reviewerId
        || execution.agentConfigurationVersionId !== version.agentConfigurationVersionIds[reviewerId!]) return conflict()
      return { execution, relationshipId: relationships[0]!.id,
        requesterOccurrenceId: null, reviewerOccurrenceId: null }
    }
    const occurrenceId = repeatReviewerOccurrence(version, requester.ref, reviewerNodeId)
    const resolutions = await this.sql.query<{ record: { ref?: unknown; value?: unknown }; execution_id: string | null;
      source_occurrence_id: string | null }>(`select record,execution_id,source_occurrence_id from run_repeat_resolutions
      where run_id=$1 and occurrence_key=$2 and workflow_node_id=$3`, [run.id, occurrenceId ?? '', reviewerNodeId])
    const resolution = resolutions.rows[0]
    if (resolutions.rows.length !== 1 || !resolution?.execution_id) return conflict()
    const value = NodeResolutionSchema.parse(resolution.record.value)
    const selected = await loadExecution(this.sql, scope, version, resolution.execution_id)
    if (value.workflowNodeId !== reviewerNodeId || value.resolution !== 'succeeded' || !value.execution || !value.acceptedResultDigest
      || !selected.accepted || selected.execution.state !== 'completed' || selected.execution.result?.outcome !== 'succeeded'
      || selected.execution.agentId !== reviewerId || selected.execution.workflowNodeId !== reviewerNodeId
      || selected.execution.agentConfigurationVersionId !== version.agentConfigurationVersionIds[reviewerId!]
      || resolution.source_occurrence_id !== occurrenceId || (selected.ref.occurrence?.occurrenceId ?? null) !== occurrenceId
      || !isDeepStrictEqual(selected.ref, resolution.record.ref)
      || !isDeepStrictEqual(value.execution, repeatExecutionIdentity(selected.execution))) return conflict()
    const result = await this.sql.query<{ execution_id: string; run_id: string; occurrence_id: string | null;
      result_json: string; result_digest: string }>(
      'select execution_id,run_id,occurrence_id,result_json,result_digest from run_repeat_results where run_id=$1 and execution_id=$2', [run.id, selected.execution.id])
    const accepted = result.rows[0]
    if (result.rows.length !== 1 || !accepted || accepted.execution_id !== selected.execution.id
      || accepted.run_id !== run.id || accepted.occurrence_id !== occurrenceId || accepted.result_digest !== value.acceptedResultDigest
      || !isDeepStrictEqual(AcceptedCurrentNodeResultSchema.parse(JSON.parse(accepted.result_json)), selected.execution.result)
      || repeatDigest(selected.execution.result, 64 * 1024) !== accepted.result_digest) return conflict()
    return { execution: selected.execution, relationshipId: relationships[0]!.id,
      requesterOccurrenceId: requester.ref.occurrence?.occurrenceId ?? null, reviewerOccurrenceId: occurrenceId }
  }
}

/** Called AFTER the existing immutable relationship/credential checks. It adds
 * occurrence binding; it never substitutes for those checks or widens schemas. */
export async function assertRepeatReviewerBinding(sql: GraphSqlClient, interaction: RepeatReviewRequest,
  reviewerNodeId: string, executionId: string): Promise<void> {
  const row = (await sql.query<{ semantics: string | null }>(
    "select record->>'executionSemanticsVersion' as semantics from runs where id=$1", [interaction.runId])).rows[0]
  if (!row) return conflict()
  if (row.semantics !== '3') return conflict()
  const selected = await new PostgresRepeatReviewerBindings(sql).select(interaction, reviewerNodeId)
  if (selected.execution.id !== executionId) return conflict()
}
