import type { HarnessExecution } from '@foreman-code/contracts'
import { JobExecutionRecordSchema, type JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import { GraphExecutionIdentitySchema, NodeResolutionSchema, RUN_GRAPH_LIMITS, canonicalGraphJson, type GraphFact, type PublicGraphProjection, type RunGraphScope } from '@foreman-code/contracts/wave25'
import type { GraphTransactionSql } from './connection.js'
import { assertGraphTransaction } from './connection.js'
import { readCurrentNativeActivities, selectCurrentNodeActivity } from './currentActivity.js'
import type { CurrentNativeActivity } from './nativeActivitySelection.js'
import { publicNodeAttention, readPublicAttentionCounts, type PublicAttentionCount, type PublicAttentionOverlay } from './currentAttention.js'
import { publicNodeState, publicReviewUnsettled, type PublicExecution } from './publicLifecycle.js'
import { RunGraphError } from './errors.js'
import { repeatTickIndex } from '../runs/repeatResolution.js'

import type { CompactProjectionRows } from './compactProjectionRows.js'

type PublicNode = PublicGraphProjection['nodes'][number]
export interface PublicProjectionOverlay extends PublicAttentionOverlay {
  executions?: readonly HarnessExecution[]
  /** Proposed persisted Job receipt state, under the existing Job/Run owner. */
  jobs?: readonly JobExecutionRecord[]
  /** Guard-qualified proposed candidates from BR1-002, not transport observations. */
  native?: readonly CurrentNativeActivity[]
  closed?: boolean
  /** Proposed Run cleanup intent, not native/resource closure evidence. */
  cleanupPending?: boolean
}

/** Current non-native inputs of the node projection. Native ingestion reads them
 * once per transaction and composes every frame's before/after state in memory. */
export interface PublicNodeInputs {
  readonly nodeIds: readonly string[]
  readonly closed: boolean
  readonly executions: ReadonlyMap<string, PublicExecution>
  readonly resolutions: ReadonlyMap<string, NonNullable<PublicNode['resolution']>>
  readonly counts: ReadonlyMap<string, PublicAttentionCount>
}

/** One authoritative bounded node projection for both compact snapshots and
 * lifecycle publication. It reads current records only, never event history.
 * Overlays let a producer compute its post-mutation facts without writing before
 * its source/effect guards. No native writes, lease acquisition or external I/O occurs. */
export async function readPublicNodeProjection(sql: GraphTransactionSql, scope: RunGraphScope,
  nodeIds: readonly string[], overlay: PublicProjectionOverlay = {},
  attention?: ReadonlyMap<string, PublicAttentionCount>, prefetched?: CompactProjectionRows): Promise<PublicNode[]> {
  return composePublicNodes(sql, scope, await readPublicNodeInputs(sql, scope, nodeIds, overlay, attention, prefetched), overlay, prefetched?.native)
}

export type PublicNodeRunRow = { closed: boolean; cleanup_pending: boolean }
export const PUBLIC_NODE_RUN_SQL = `select r.stop_requested_at is not null
    or r.execution_state in ('completed','interrupted') as closed,
    exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending) as cleanup_pending
    from runs r where r.id=$1`

export type PublicNodeExecutionRow = { id: string; workflow_node_id: string; agent_id: string;
    configuration_id: string; attempt: number; state: string; outcome: string | null }
export const PUBLIC_NODE_EXECUTIONS_SQL = `select distinct on (e.workflow_node_id) e.id,e.workflow_node_id,e.record->>'agentId' as agent_id,
       e.record->>'agentConfigurationVersionId' as configuration_id,e.attempt,
       e.record->>'state' as state,e.record->'result'->>'outcome' as outcome
     from harness_executions e join run_repeat_executions x on x.execution_id=e.id and x.run_id=e.run_id
     left join run_repeat_occurrences o on o.occurrence_id=x.occurrence_id and o.run_id=e.run_id
     left join run_work_activations w on w.activation_id=x.work_activation_id and w.run_id=e.run_id
     where e.run_id=$1 and e.workflow_node_id=any($2::text[]) and e.record #> '{input,tick}' is null
     order by e.workflow_node_id,w.activation_sequence desc nulls last,
       coalesce(o.occurrence_index,0) desc,x.technical_attempt desc,x.execution_id desc limit 1001`

export type PublicNodeJobRow = { id: string; workflow_node_id: string; definition_id: string; version_id: string; definition_revision: number;
    attempt_id: string; operation_id: string; admitted_id: string | null; phase: string | null; outcome: string | null;
    stopped: boolean | null; publication: string | null; result_issue: string | null; finished_at: string | null }
export const PUBLIC_NODE_JOBS_SQL = `
    select p.preparation->>'executionId' as id,s.workflow_node_id,n.node->>'jobDefinitionId' as definition_id,
      n.node->>'jobDefinitionVersionId' as version_id,(n.node->>'jobDefinitionRevision')::integer as definition_revision,
      p.preparation->>'attemptId' as attempt_id,
      p.preparation->>'operationId' as operation_id,x.job_execution_id as admitted_id,j.record->'process'->>'phase' as phase,
      j.record->'process'->>'outcome' as outcome,(j.record->'process'->>'processStopped')::boolean as stopped,
      j.record->>'publication' as publication,j.record->>'resultIssue' as result_issue,j.record->>'finishedAt' as finished_at
    from (select distinct on (s.workflow_node_id) s.* from run_repeat_slots s
      left join run_repeat_occurrences o on o.occurrence_id=s.occurrence_id and o.run_id=s.run_id
      left join run_work_activations w on w.activation_id=s.work_activation_id and w.run_id=s.run_id
      where s.run_id=$1 and s.workflow_node_id=any($2::text[])
      order by s.workflow_node_id,w.activation_sequence desc nulls last,coalesce(o.occurrence_index,0) desc,s.slot_id desc) s
    join workflow_job_preparations p on p.slot_id=s.slot_id and p.run_id=s.run_id
    join workflow_versions v on v.id=$3
    cross join lateral jsonb_array_elements(v.record->'definition'->'nodes') n(node)
    left join workflow_job_executions x on x.run_id=s.run_id and x.node_execution_id=p.preparation->>'executionId'
    left join job_executions j on j.id=x.job_execution_id and j.workspace_id=$4
      and x.reference->>'workflowVersionId'=$3 and x.reference->>'workspaceId'=$4
      and x.reference->>'workflowId'=$5 and x.reference->>'runId'=s.run_id
      and x.reference->>'nodeId'=s.workflow_node_id and x.reference->>'nodeExecutionId'=j.id
      and j.attempt_id=p.preparation->>'attemptId' and j.operation_id=p.preparation->>'operationId'
      and j.definition_version_id=n.node->>'jobDefinitionVersionId'
      and j.record->'workflow'->>'workflowId'=$5 and j.record->'workflow'->>'runId'=s.run_id
      and j.record->'workflow'->>'nodeId'=s.workflow_node_id and j.record->'workflow'->>'nodeExecutionId'=j.id
      and j.accepted_spec->>'definitionId'=n.node->>'jobDefinitionId'
      and j.accepted_spec->>'definitionRevision'=n.node->>'jobDefinitionRevision'
      and j.accepted_spec->>'definitionVersionId'=n.node->>'jobDefinitionVersionId'
    where n.node->>'kind'='job' and n.node->>'id'=s.workflow_node_id
      and p.preparation->>'workspaceId'=$4 and p.preparation->>'workflowId'=$5
      and p.preparation->>'workflowVersionId'=$3 and p.preparation->>'runId'=s.run_id
      and p.preparation->>'nodeId'=s.workflow_node_id limit 1001`

export type PublicNodeResolutionRow = { record: { value: NonNullable<PublicNode['resolution']> } }
export const PUBLIC_NODE_RESOLUTIONS_SQL = `select d.record from run_repeat_resolutions d where d.run_id=$1 and d.workflow_node_id=any($2::text[])
      and (d.execution_id=any($3::text[]) or d.execution_id is null and d.occurrence_key='')
      order by (d.record #>> '{value,resolvedAt}')::timestamptz desc,
        d.workflow_node_id,d.occurrence_key desc limit 2000`

export async function readPublicNodeInputs(sql: GraphTransactionSql, scope: RunGraphScope,
  nodeIds: readonly string[], overlay: PublicProjectionOverlay = {},
  attention?: ReadonlyMap<string, PublicAttentionCount>, prefetched?: CompactProjectionRows): Promise<PublicNodeInputs> {
  assertGraphTransaction(sql)
  if (nodeIds.length > 1000 || new Set(nodeIds).size !== nodeIds.length) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
  const row = prefetched ? prefetched.nodeRun[0] : (await sql.query<PublicNodeRunRow>(PUBLIC_NODE_RUN_SQL, [scope.runId])).rows[0]
  if (!row) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
  // Cleanup closes positive work authority even before business settlement. A
  // canceled approval must not uncover an earlier native start as continuation.
  const closed = (overlay.closed ?? row.closed) || (overlay.cleanupPending ?? row.cleanup_pending)
  // Select bounded scalar facts, never result/output/input payloads or native history.
  const stored = prefetched ? { rows: prefetched.executions } : await sql.query<PublicNodeExecutionRow>(
    PUBLIC_NODE_EXECUTIONS_SQL, [scope.runId, [...nodeIds]])
  if (stored.rows.length > 1000) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
  const executions = new Map<string, PublicExecution>()
  const put = (current: PublicExecution, replace = false) => {
    const identity = GraphExecutionIdentitySchema.parse(current.execution), id = identity.workflowNodeId
    if (!nodeIds.includes(id) || (!replace && executions.has(id))) {
      throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    }
    if (replace && executions.has(id) && canonicalGraphJson(executions.get(id)!.execution) !== canonicalGraphJson(identity)) {
      throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    }
    executions.set(id, { ...current, execution: identity })
  }
  for (const item of stored.rows) put({ state: item.state, outcome: item.outcome, execution: {
    workflowNodeId: item.workflow_node_id, executionId: item.id, agentId: item.agent_id,
    agentConfigurationVersionId: item.configuration_id, attempt: item.attempt } })
  // Preparation is the real reserved identity before dispatch. Select the latest
  // slot first, so a new preparation cannot expose a previous occurrence's result.
  const jobs = prefetched ? { rows: prefetched.jobs } : await sql.query<PublicNodeJobRow>(PUBLIC_NODE_JOBS_SQL,
    [scope.runId, [...nodeIds], scope.workflowVersionId, scope.workspaceId, scope.workflowId])
  if (jobs.rows.length > 1000) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
  const jobPins = new Map(jobs.rows.map((item) => [item.id, item]))
  const putJob = (item: typeof jobs.rows[number]) => {
    if (item.admitted_id && (item.admitted_id !== item.id || !item.phase)) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    const terminal = item.phase === 'terminal' && item.stopped === true && !!item.finished_at
      && ['complete', 'failed', 'expired'].includes(item.publication ?? '')
    put({ execution: { kind: 'job', workflowNodeId: item.workflow_node_id, executionId: item.id,
      jobDefinitionId: item.definition_id, jobDefinitionVersionId: item.version_id, attempt: 1 },
    state: terminal ? 'completed' : item.phase === 'queued' ? 'queued' : item.phase === 'running' ? 'running'
      : item.phase === 'terminal' ? 'unknown' : 'starting',
    outcome: terminal ? item.outcome === 'cancelled' ? 'canceled' : item.outcome === 'succeeded'
      ? item.publication === 'complete' && !item.result_issue ? 'succeeded' : 'failed'
      : item.outcome ? 'failed' : null : null }, executions.has(item.workflow_node_id))
  }
  for (const item of jobs.rows) putJob(item)
  for (const raw of overlay.jobs ?? []) {
    const job = JobExecutionRecordSchema.parse(raw), pin = jobPins.get(job.id)
    if (job.workspaceId !== scope.workspaceId || job.workflow?.workflowId !== scope.workflowId
      || job.workflow.runId !== scope.runId || job.workflow.nodeExecutionId !== job.id) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
    if (!pin || job.workflow.nodeId !== pin.workflow_node_id || job.attemptId !== pin.attempt_id
      || job.operationId !== pin.operation_id || job.acceptedSpec.definitionId !== pin.definition_id
      || job.acceptedSpec.definitionRevision !== pin.definition_revision
      || job.acceptedSpec.definitionVersionId !== pin.version_id) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    putJob({ ...pin, phase: job.process.phase, outcome: job.process.outcome, stopped: job.process.processStopped,
      publication: job.publication, result_issue: job.resultIssue, finished_at: job.finishedAt })
  }
  for (const execution of overlay.executions ?? []) {
    if (execution.runId !== scope.runId) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
    // Interval checks never change a node's graph state.
    if (repeatTickIndex(execution.input) !== undefined) continue
    put({ state: execution.state, outcome: execution.result?.outcome ?? null, execution: {
      workflowNodeId: execution.workflowNodeId, executionId: execution.id, agentId: execution.agentId,
      agentConfigurationVersionId: execution.agentConfigurationVersionId!, attempt: execution.attempt } }, true)
  }
  const resolutionRows = prefetched ? { rows: prefetched.resolutions } : await sql.query<PublicNodeResolutionRow>(
    PUBLIC_NODE_RESOLUTIONS_SQL,
    [scope.runId, [...nodeIds], [...executions.values()].map((item) => item.execution.executionId)])
  const resolutions = new Map<string, NonNullable<PublicNode['resolution']>>()
  for (const row of resolutionRows.rows.slice(0, 2000)) {
    const value = NodeResolutionSchema.parse(row.record.value)
    if (!resolutions.has(value.workflowNodeId)) resolutions.set(value.workflowNodeId, value)
  }
  const counts = attention ?? await readPublicAttentionCounts(sql, scope.runId, nodeIds, overlay)
  return { nodeIds, closed, executions, resolutions, counts }
}

/** Composes node state from read-once inputs and the caller's native rows. Only a
 * review filter reads current review jobs; history is never loaded here. */
export async function composePublicNodes(sql: GraphTransactionSql, scope: RunGraphScope,
  inputs: PublicNodeInputs, overlay: PublicProjectionOverlay = {},
  nativeRows?: CompactProjectionRows['native']): Promise<PublicNode[]> {
  assertGraphTransaction(sql)
  const { nodeIds, closed, executions, resolutions, counts } = inputs
  // Domain closure suppresses stale retained native rows without treating a
  // projection clear as proof that the native process or credentials are closed.
  let native: readonly CurrentNativeActivity[] = closed ? [] : overlay.native
    ?? await readCurrentNativeActivities(sql, scope, nodeIds, true, nativeRows)
  if (native.length > RUN_GRAPH_LIMITS.nodes + RUN_GRAPH_LIMITS.exchanges) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
  const reviewIds = native.filter((item) => item.key.workKind === 'review').map((item) => item.key.workId)
  if (reviewIds.length) {
    const currentReviews = await sql.query<{ id: string }>(`select j.id from review_jobs j
      join harness_executions e on e.id=j.execution_id where e.run_id=$1 and j.id=any($2::text[])
      and j.state<>'completed' and j.record->'cleanup'->>'completedAt' is null`, [scope.runId, reviewIds])
    const active = new Set(currentReviews.rows.map((item) => item.id))
    if (overlay.review) {
      if (publicReviewUnsettled(overlay.review.record)) active.add(overlay.review.record.id)
      else active.delete(overlay.review.record.id)
    }
    native = native.filter((item) => item.key.workKind === 'workflow' || active.has(item.key.workId))
  }
  native = native.filter((item) => executions.get(item.key.execution.workflowNodeId)?.execution.kind !== 'job'
    && (item.key.workKind === 'review'
      || executions.get(item.key.execution.workflowNodeId)?.execution.executionId === item.key.execution.executionId))
  return nodeIds.map((id) => {
    const execution = executions.get(id), resolution = resolutions.get(id), count = counts.get(id)!
    if (resolution?.execution && (!execution || canonicalGraphJson(resolution.execution) !== canonicalGraphJson(execution.execution))) {
      throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    }
    const activity = selectCurrentNodeActivity(id, native, { closed, workflowClosed: execution?.state === 'completed',
      ...(count.pendingInteractionId ? { pendingInteractionId: count.pendingInteractionId } : {}), deliveryBlocked: count.deliveryBlocked })
    // An outstanding approval may not reuse old native work as continuation proof.
    const state = publicNodeState(id, execution, resolution, native, closed, count.pendingInteractionCount > 0)
    // Job running is a durable receipt projection. It needs no Agent native ACK.
    if (!resolution && !closed && execution?.execution.kind === 'job' && execution.state === 'running') state.lifecycle = 'running'
    return { state, activity, attention: publicNodeAttention(id, activity, count),
      ...(resolution ? { resolution } : {}),
      ...(resolution?.acceptedResultDigest ? { acceptedResultDigest: resolution.acceptedResultDigest } : {}) }
  })
}

export function publicNodeProjectionFacts(nodes: readonly PublicNode[]): GraphFact[] {
  return nodes.flatMap((node): GraphFact[] => [{ type: 'node.state', state: node.state },
    { type: 'node.activity', activity: node.activity }, { type: 'node.attention', attention: node.attention }])
}
/** Native ingestion/refresh must compare before/after so a keepalive, repeated
 * observation or lease-only change cannot allocate a graph-visible cursor. */
export function publicNodeProjectionDelta(before: readonly PublicNode[], after: readonly PublicNode[]): GraphFact[] {
  const prior = new Map(publicNodeProjectionFacts(before).map((fact) => [factKey(fact), canonicalGraphJson(fact)]))
  return publicNodeProjectionFacts(after).filter((fact) => prior.get(factKey(fact)) !== canonicalGraphJson(fact))
}
function factKey(fact: GraphFact): string {
  if (fact.type === 'node.state') return `${fact.type}:${fact.state.workflowNodeId}`
  if (fact.type === 'node.activity') return `${fact.type}:${fact.activity.workflowNodeId}`
  if (fact.type === 'node.attention') return `${fact.type}:${fact.attention.workflowNodeId}`
  throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
}

/** Run-domain Stop/completion/interruption projection. Native row clear/closure
 * remains BR1-002's fenced boundary; this never claims native cleanup succeeded. */
export function publicRunClosedFacts(sql: GraphTransactionSql, scope: RunGraphScope): Promise<GraphFact[]> {
  return publicRunBoundaryFacts(sql, scope, { closed: true })
}

/** Publish the entire node delta with the proposed Run boundary, before its SQL
 * mutation. Clearing cleanup is not a native acknowledgement: the unchanged
 * publication schema still rejects any attempt to restore active native work
 * from a cleanup source. Stop/terminal closure survives a cleared cleanup flag. */
export async function publicRunBoundaryFacts(sql: GraphTransactionSql, scope: RunGraphScope,
  overlay: Pick<PublicProjectionOverlay, 'closed' | 'cleanupPending'>): Promise<GraphFact[]> {
  const ids = (await sql.query<{ id: string }>(`select n.node->>'id' as id from workflow_versions v
    cross join lateral jsonb_array_elements(v.record->'definition'->'nodes') n(node)
    where v.id=$1 order by n.node->>'id' limit 1001`, [scope.workflowVersionId])).rows.map((row) => row.id)
  const before = await readPublicNodeProjection(sql, scope, ids)
  const after = await readPublicNodeProjection(sql, scope, ids, overlay)
  return publicNodeProjectionDelta(before, after)
}
