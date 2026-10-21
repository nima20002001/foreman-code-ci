import { GraphRunStateSchema, type RunGraphScope } from '@foreman-code/contracts/wave25'
import { assertGraphTransaction, type GraphTransactionSql } from './connection.js'
import { publicAttentionTotals, readPublicAttentionCounts, type PublicAttentionCount } from './currentAttention.js'
import { RunGraphError } from './errors.js'

export type PublicRunStateRow = { execution_state: string; outcome: string; stopped: boolean; cleanup_pending: boolean }
export const PUBLIC_RUN_STATE_SQL = `select r.execution_state,r.record->>'outcome' as outcome,r.stop_requested_at is not null as stopped,
      exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending) as cleanup_pending
      from runs r where r.id=$1 and r.workspace_id=$2 and r.workflow_id=$3 and r.workflow_version_id=$4`

export async function readPublicRunStateLocked(sql: GraphTransactionSql, scope: RunGraphScope,
  attention?: ReadonlyMap<string, PublicAttentionCount>, prefetched?: PublicRunStateRow[]) {
  assertGraphTransaction(sql)
  const row = prefetched ? prefetched[0] : (await sql.query<PublicRunStateRow>(
    PUBLIC_RUN_STATE_SQL,
    [scope.runId, scope.workspaceId, scope.workflowId, scope.workflowVersionId])).rows[0]
  if (!row) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
  const totals = publicAttentionTotals(attention ?? await readPublicAttentionCounts(sql, scope.runId))
  return GraphRunStateSchema.parse({ executionState: row.execution_state, outcome: row.outcome, stopRequested: row.stopped,
    ...totals, cleanupPending: row.cleanup_pending || totals.cleanupPending })
}
