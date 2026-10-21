import type { DurableInteraction, ReviewJob } from '@foreman-code/contracts'
import { GraphAttentionSchema, type GraphActivity, type GraphAttention, type RunGraphScope } from '@foreman-code/contracts/wave25'
import type { GraphTransactionSql } from './connection.js'
import { RunGraphError } from './errors.js'
import { PUBLIC_PENDING_INTERACTION_SQL, PUBLIC_UNSETTLED_REVIEW_SQL } from './publicObligations.js'
import { publicInteractionPending, publicReviewCleanupPending, publicReviewUnsettled } from './publicLifecycle.js'

export interface PublicAttentionOverlay {
  interaction?: { record: DurableInteraction; workflowNodeId: string; nativeAcknowledged?: boolean }
  review?: { record: ReviewJob; workflowNodeId: string }
}
export type PublicAttentionRow = { kind: 'interaction' | 'review'; node_id: string; count: string;
    pending_id: string | null; blocked: boolean | null; cleanup: boolean | null }
export const PUBLIC_ATTENTION_SQL = `with interactions as (
     select e.workflow_node_id as node_id,count(*)::text,
       min(i.id) filter(where i.status='pending') as pending_id,
       bool_or(i.status in ('decided','delivery_pending','delivery_failed','delivered')) as blocked
     from durable_interactions i join harness_executions e on e.id=i.execution_id and e.run_id=i.run_id
     left join interaction_graph_resumes g on g.interaction_id=i.id
     where i.run_id=$1 and ${PUBLIC_PENDING_INTERACTION_SQL}
       and ($2::text[] is null or e.workflow_node_id=any($2)) and ($3::text is null or i.id<>$3)
     group by e.workflow_node_id limit 1001
    ), reviews as (
     select e.workflow_node_id as node_id,count(*)::text,
       bool_or(j.record->'cleanup'->>'completedAt' is null and
         (j.record->'cleanup'->>'nativeState'='pending' or j.record->'cleanup'->>'credentialState'='pending')) as cleanup
     from harness_executions e join review_jobs j on j.execution_id=e.id
     where e.run_id=$1 and ($2::text[] is null or e.workflow_node_id=any($2))
       and ($4::text is null or j.id<>$4) and ${PUBLIC_UNSETTLED_REVIEW_SQL}
     group by e.workflow_node_id limit 1001
    )
    select 'interaction'::text as kind,node_id,count,pending_id,blocked,null::boolean as cleanup from interactions
    union all
    select 'review'::text as kind,node_id,count,null::text as pending_id,null::boolean as blocked,cleanup from reviews`

export interface PublicAttentionCount {
  pendingInteractionCount: number
  unsettledReviewCount: number
  cleanupPending: boolean
  pendingInteractionId?: string
  deliveryBlocked: boolean
}
const empty = (): PublicAttentionCount => ({ pendingInteractionCount: 0, unsettledReviewCount: 0,
  cleanupPending: false, deliveryBlocked: false })

/** The same current-obligation aggregates serve snapshots, one-shot writers,
 * approval publication and native projection. Reviews belong to their host once,
 * not to both host and requester. The optional overlay excludes the stored row
 * before counting the proposed mutation; no domain write occurs in this helper. */
export async function readPublicAttentionCounts(sql: GraphTransactionSql, runId: string,
  nodeIds?: readonly string[], overlay: PublicAttentionOverlay = {},
  prefetched?: PublicAttentionRow[]): Promise<Map<string, PublicAttentionCount>> {
  if (nodeIds && nodeIds.length > 1000) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
  const ids = nodeIds ? [...nodeIds] : null
  const rows = prefetched ? { rows: prefetched } : await sql.query<PublicAttentionRow>(
    PUBLIC_ATTENTION_SQL,
    [runId, ids, overlay.interaction?.record.id ?? null, overlay.review?.record.id ?? null])
  if (rows.rows.filter((row) => row.kind === 'interaction').length > 1000
    || rows.rows.filter((row) => row.kind === 'review').length > 1000) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
  const result = new Map<string, PublicAttentionCount>((nodeIds ?? []).map((id) => [id, empty()]))
  const get = (id: string) => {
    let value = result.get(id)
    if (!value) { value = empty(); result.set(id, value) }
    return value
  }
  for (const row of rows.rows) {
    if (row.kind !== 'interaction') continue
    const value = get(row.node_id)
    value.pendingInteractionCount = boundedCount(row.count)
    value.deliveryBlocked = row.blocked === true
    if (row.pending_id) value.pendingInteractionId = row.pending_id
  }
  for (const row of rows.rows) {
    if (row.kind !== 'review') continue
    const value = get(row.node_id)
    value.unsettledReviewCount = boundedCount(row.count)
    value.cleanupPending = row.cleanup === true
  }
  const interaction = overlay.interaction
  if (interaction && (!nodeIds || nodeIds.includes(interaction.workflowNodeId))) {
    const value = get(interaction.workflowNodeId), record = interaction.record
    if (publicInteractionPending(record.status,
      record.kind === 'work_direction' || interaction.nativeAcknowledged)) {
      value.pendingInteractionCount++
      if (record.status === 'pending') {
        value.pendingInteractionId = [value.pendingInteractionId, record.id].filter((id): id is string => !!id).sort()[0]!
      } else value.deliveryBlocked = true
    }
  }
  const review = overlay.review
  if (review && (!nodeIds || nodeIds.includes(review.workflowNodeId))) {
    const value = get(review.workflowNodeId)
    if (publicReviewUnsettled(review.record)) value.unsettledReviewCount++
    value.cleanupPending ||= publicReviewCleanupPending(review.record)
  }
  if (result.size > 1000) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
  for (const value of result.values()) {
    boundedCount(String(value.pendingInteractionCount)); boundedCount(String(value.unsettledReviewCount))
  }
  return result
}
function boundedCount(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 100000n) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
  return Number(value)
}
export function publicAttentionTotals(counts: ReadonlyMap<string, PublicAttentionCount>) {
  const values = [...counts.values()]
  return { pendingInteractionCount: boundedCount(String(values.reduce((sum, value) => sum + value.pendingInteractionCount, 0))),
    unsettledReviewCount: boundedCount(String(values.reduce((sum, value) => sum + value.unsettledReviewCount, 0))),
    cleanupPending: values.some((value) => value.cleanupPending) }
}
export function publicNodeAttention(workflowNodeId: string, activity: GraphActivity, count: PublicAttentionCount): GraphAttention {
  return GraphAttentionSchema.parse({ workflowNodeId, pendingInteractionCount: count.pendingInteractionCount,
    unsettledReviewCount: count.unsettledReviewCount, cleanupPending: count.cleanupPending,
    telemetry: activity.status === 'stale' ? 'stale' : activity.status === 'unknown' ? 'unknown' : 'current' })
}
/** Existing native callers retain this read interface. */
export async function readCurrentNodeAttention(sql: GraphTransactionSql, scope: RunGraphScope,
  activities: ReadonlyMap<string, GraphActivity>): Promise<Map<string, GraphAttention>> {
  const counts = await readPublicAttentionCounts(sql, scope.runId, [...activities.keys()])
  return new Map([...activities].map(([id, activity]) => [id, publicNodeAttention(id, activity, counts.get(id)!)]))
}
