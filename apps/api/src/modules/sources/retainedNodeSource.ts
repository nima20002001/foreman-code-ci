import { isDeepStrictEqual } from 'node:util'
import { SourceMaterializationRecordSchema } from '@foreman-code/contracts/source-admission'
import type { RootBinding } from '@foreman-code/contracts/source-materialization'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { outstandingCheckoutReviewSql } from '../runs/worktreeReviewers.js'

/** The saved node, rather than a resolved placement label, decides directory retention. */
export async function retainsNodeWorkingTree(sql: GraphSqlClient, executionId: string): Promise<boolean> {
  const result = await sql.query(`select 1 from harness_executions e join runs r on r.id=e.run_id
    join workflow_versions v on v.id=r.workflow_version_id
    where e.id=$1 and r.execution_state not in ('completed','interrupted')
      and exists(select 1 from jsonb_array_elements(v.record#>'{definition,nodes}') node
        where node->>'id'=e.workflow_node_id and node->>'kind' is distinct from 'job' and not (node ? 'placement'))`,
  [executionId])
  return result.rowCount === 1
}

/** Only the latest finalized turn of this same unplaced node may supply its directory. */
export async function retainedNodeReceipt(sql: GraphSqlClient, executionId: string, binding: RootBinding) {
  if (!await retainsNodeWorkingTree(sql, executionId)) return undefined
  const row = (await sql.query<{ record: unknown }>(`select m.record
    from harness_executions incoming
    join lateral (select e.* from harness_executions e
      where e.run_id=incoming.run_id and e.workflow_node_id=incoming.workflow_node_id and e.id<>incoming.id
      order by e.created_at desc,e.id desc limit 1) previous on true
    join execution_native_sessions n on n.execution_id=previous.id and n.workflow_finalized_at is not null
      and n.reference->>'nativeSessionId'=previous.record->>'nativeSessionId'
    join execution_native_placements native on native.execution_id=n.execution_id
    join source_execution_materializations m on m.execution_id=native.execution_id
      and m.materialization_id=(native.record#>>'{materialization,receipt,materializationId}')::uuid
      and m.attempt_id=native.record->>'attemptId' and m.operation_id=native.operation_id
    join source_storage_reservations s on s.reservation_id=m.reservation_id
    where incoming.id=$1 and previous.record->>'state'='completed'
      and previous.record->>'agentId'=incoming.record->>'agentId'
      and previous.record->>'agentConfigurationVersionId'=incoming.record->>'agentConfigurationVersionId'
      and m.state in ('prepared','running','closed') and s.state<>'reclaimed'
      and m.worktree_cleanup->>'state' is distinct from 'removed'
      and not exists(select 1 from harness_executions writer
        where writer.run_id=incoming.run_id and writer.workflow_node_id=incoming.workflow_node_id
          and writer.id<>incoming.id and (writer.record->>'state'<>'completed'
            or exists(select 1 from execution_native_sessions active where active.execution_id=writer.id
              and active.workflow_finalized_at is null)
            or (writer.record->>'nativeSessionId' is not null and not exists(
              select 1 from execution_native_sessions finalized where finalized.execution_id=writer.id
                and finalized.workflow_finalized_at is not null))
            or (${outstandingCheckoutReviewSql})))`, [executionId])).rows[0]
  if (!row) return undefined
  const receipt = SourceMaterializationRecordSchema.parse(row.record).receipt
  return !receipt.quota && isDeepStrictEqual(receipt.binding, binding) ? receipt : undefined
}
