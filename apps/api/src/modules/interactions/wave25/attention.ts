import type { DurableInteraction, ReviewJob } from '@foreman-code/contracts'
import { WorkflowRunV3Schema, type GraphFact } from '@foreman-code/contracts/wave25'
import type { GraphTransactionSql } from '../../run-graph/connection.js'
import { publicAttentionTotals, readPublicAttentionCounts } from '../../run-graph/currentAttention.js'
import { publicNodeProjectionDelta, readPublicNodeProjection, type PublicProjectionOverlay } from '../../run-graph/publicProjection.js'
import { fail, type ApprovalContext } from './context.js'

/** Overlay the proposed mutation under the existing Run publication lock. The
 * same projection supplies snapshots, terminal writes and native refresh hooks.
 * No provider, checkpoint, resume consumer or producer registration lives here. */
export async function approvalAttentionFacts(sql: GraphTransactionSql, context: ApprovalContext,
  next: { interaction?: DurableInteraction; review?: ReviewJob; nativeAcknowledged?: boolean }): Promise<GraphFact[]> {
  if (next.review && !context.reviewer) return fail('APPROVAL_DIRECT_CONNECTION_REQUIRED')
  const overlay: PublicProjectionOverlay = {
    ...(next.interaction ? { interaction: { record: next.interaction, workflowNodeId: context.requester.workflowNodeId,
      ...(next.nativeAcknowledged !== undefined ? { nativeAcknowledged: next.nativeAcknowledged } : {}) } } : {}),
    ...(next.review ? { review: { record: next.review, workflowNodeId: context.reviewer!.workflowNodeId } } : {}),
  }
  const counts = publicAttentionTotals(await readPublicAttentionCounts(sql, context.scope.runId, undefined, overlay))
  const runRow = (await sql.query<{ record: unknown; execution_state: string; stopped: boolean; cleanup: boolean }>(`select record,execution_state,
    stop_requested_at is not null as stopped,exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending) as cleanup
    from runs r where id=$1`, [context.scope.runId])).rows[0]!
  const run = WorkflowRunV3Schema.parse(runRow.record)
  if (run.executionState !== runRow.execution_state) return fail('APPROVAL_RUN_STATE_MISMATCH')
  const ids = [...new Set([context.requester.workflowNodeId, ...(context.reviewer ? [context.reviewer.workflowNodeId] : [])])]
  const before = await readPublicNodeProjection(sql, context.scope, ids)
  const after = await readPublicNodeProjection(sql, context.scope, ids, overlay)
  return [{ type: 'run.state', state: { executionState: run.executionState, outcome: run.outcome,
    stopRequested: runRow.stopped, ...counts, cleanupPending: counts.cleanupPending || runRow.cleanup } },
  ...publicNodeProjectionDelta(before, after)]
}
