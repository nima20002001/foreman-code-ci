import { ExecutionResultSchema, HarnessExecutionSchema } from '@foreman-code/contracts'
import { AcceptedCurrentNodeResultSchema, WorkReturnSchema } from '@foreman-code/contracts/wave25'
import type { HierarchyGroupContext } from './hierarchyGroupAdmission.js'
import { parseHierarchyWorkResult } from './hierarchyResults.js'
import { repeatConflict, repeatDigest, repeatExecutionIdentity, sameRepeatValue, type RepeatSource } from './repeatResolution.js'
import { WorkExecutionFailure } from './workExecutionFailure.js'

interface ActivationResult {
  activation_id: string; state: string; workflow_node_id: string; execution: unknown | null; accepted: boolean | null
  result_json: string | null; result_digest: string | null; direction_source: boolean; failure_result: unknown | null
  member_failure: boolean; refusal_result: unknown | null; returned: unknown | null; owed_request_id: string | null
  member_failure_result: unknown | null
}

/** The hierarchy's final barrier belongs to the existing Run owner. A child's
 * proven negative is input to its parent, never an automatic whole-Run failure. */
export async function hierarchyCompletionLocked(context: HierarchyGroupContext): Promise<RepeatSource[]> {
  const { sql, scope, version } = context
  if (!version.definition.hierarchy) return repeatConflict('HIERARCHY_REQUIRED')
  await context.hooks.assertAuthorityLocked(sql)
  const rows = (await sql.query<ActivationResult>(`select a.activation_id,a.state,a.workflow_node_id,
      e.record as execution,e.accepted,x.result_json,x.result_digest,b.failure_result,
      exists(select 1 from run_hierarchy_direction_waits d where d.run_id=a.run_id
        and d.source_activation_id=a.activation_id and d.source_execution_id=e.id) as direction_source,
      exists(select 1 from run_hierarchy_group_members m where m.run_id=a.run_id
        and m.failure_execution_id=e.id) as member_failure,
      (select m.failure_result from run_hierarchy_group_members m where m.run_id=a.run_id
        and m.failure_execution_id=e.id) as member_failure_result,
      f.result as refusal_result,t.record as returned,work_parent_request($1,a.activation_id) as owed_request_id
    from run_work_activations a
    left join lateral(select * from harness_executions current where current.run_id=a.run_id
      and current.work_activation_id=a.activation_id order by attempt desc limit 1) e on true
    left join run_work_results x on x.run_id=a.run_id and x.execution_id=e.id
    left join approval_execution_state b on b.execution_id=e.id
    left join run_hierarchy_refusals f on f.run_id=a.run_id and f.source_execution_id=e.id
    left join run_work_returns t on t.run_id=a.run_id and t.source_execution_id=e.id
    where a.run_id=$1 order by a.activation_sequence`, [scope.runId])).rows
  if (!rows.length) return repeatConflict('WORK_ACTIVATIONS_UNRESOLVED')
  let root: RepeatSource | undefined
  for (const row of rows) {
    if (!row.execution) return repeatConflict('WORK_ACTIVATIONS_UNRESOLVED')
    const execution = HarnessExecutionSchema.parse(row.execution)
    if (execution.state !== 'completed') return repeatConflict('WORK_ACTIVATIONS_UNRESOLVED')
    // A validated logical control failure remains negative even if the original native result raced to success.
    const negative = row.member_failure_result ?? row.refusal_result ?? row.failure_result
      ?? (execution.result?.outcome !== 'succeeded' ? execution.result : undefined)
    if (negative) {
      const failure = ExecutionResultSchema.parse(negative)
      if (failure.outcome !== 'failed' && failure.outcome !== 'canceled') return repeatConflict('RUN_FAILURE_CAUSE_INVALID')
      if (!row.member_failure) throw new WorkExecutionFailure(failure)
      continue
    }
    if (row.state !== 'completed') return repeatConflict('WORK_ACTIVATIONS_UNRESOLVED')
    if (row.direction_source) {
      if (row.accepted) return repeatConflict('HIERARCHY_DIRECTION_SOURCE_CONFLICT')
      if (row.workflow_node_id === version.definition.hierarchy.masterNodeId) root = undefined
      continue
    }
    if (!row.accepted || !row.result_json || !row.result_digest) return repeatConflict('WORK_RESULT_RECEIPT_MISSING')
    const result = AcceptedCurrentNodeResultSchema.parse(JSON.parse(row.result_json))
    if (!sameRepeatValue(result, execution.result) || row.result_digest !== repeatDigest(result, 64 * 1024)) {
      return repeatConflict('WORK_SOURCE_RESULT_CONFLICT')
    }
    const work = parseHierarchyWorkResult(result, version, row.workflow_node_id, context.hooks.run.resultProtocol)
    if (work.routing.kind === 'return') {
      const returned = WorkReturnSchema.parse(row.returned)
      if (returned.sourceExecutionId !== execution.id || returned.sourceActivationId !== row.activation_id
        || returned.requestId !== row.owed_request_id
        || work.routing.requestId !== undefined && work.routing.requestId !== returned.requestId
        || returned.acceptedResultDigest !== row.result_digest || returned.outcome !== work.routing.outcome
        || !sameRepeatValue(returned.remainingFindings, work.data.remainingFindings)
        || !sameRepeatValue(returned.latestDeliverable, work.data.latestDeliverable)) return repeatConflict('WORK_RETURN_RESULT_CONFLICT')
    }
    if (row.workflow_node_id === version.definition.hierarchy.masterNodeId) {
      root = work.routing.kind === 'finish' && work.data.remainingFindings.length === 0
        ? { relationshipId: 'terminal', execution: repeatExecutionIdentity(execution), occurrence: null,
          acceptedResult: result, acceptedResultDigest: row.result_digest } : undefined
    }
  }
  const pending = await sql.query(`select 1 from run_hierarchy_groups where run_id=$1 and state<>'continued'
    union all select 1 from run_work_requests q where q.run_id=$1 and not exists(
      select 1 from run_hierarchy_group_members m where m.run_id=q.run_id and m.request_id=q.request_id
        and (m.failure_execution_id is not null or exists(select 1 from run_work_returns t
          where t.run_id=m.run_id and t.request_id=m.request_id))) limit 1`, [scope.runId])
  if (pending.rowCount || !root) return repeatConflict('HIERARCHY_WORK_UNRESOLVED')
  return [root]
}
