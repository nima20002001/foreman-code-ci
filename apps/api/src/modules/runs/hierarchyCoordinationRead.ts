import { ExecutionRefSchema, HarnessExecutionSchema, WorkflowHierarchyCoordinationSchema,
  type WorkflowHierarchyCoordination } from '@foreman-code/contracts'
import type { WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { isHierarchyWorkflow, parseHierarchyWorkResult } from './hierarchyResults.js'
import { repeatConflict, repeatDigest, sameRepeatValue } from './repeatResolution.js'

interface CoordinationQuery {
  query<Row extends object>(text: string, values: unknown[]): Promise<{ rows: Row[] }>
}

/** Bounded read of the selected historical Run. Native payloads remain in their
 * existing evidence rows; the shared Overview receives exact references only. */
export async function readHierarchyCoordinationLocked(sql: CoordinationQuery, runId: string,
  version: WorkflowVersionV3): Promise<WorkflowHierarchyCoordination | undefined> {
  const run = (await sql.query<{ record: { id: string; workflowVersionId: string; resultProtocol?: 'f1-f4-v1';
    executionState: string; outcome: string }; stopped: boolean }>(
    `select record,stop_requested_at is not null as stopped from runs where id=$1 and workflow_version_id=$2`,
    [runId, version.id])).rows[0]
  if (!run || run.record.id !== runId || run.record.workflowVersionId !== version.id) return repeatConflict('RUN_PIN_CONFLICT')
  if (!isHierarchyWorkflow(version)) return undefined
  const latest = (await sql.query<{ execution: unknown; activation_id: string; result_json: string;
    result_digest: string }>(`select e.record as execution,a.activation_id,
      coalesce(x.result_json,d.source_result_json) as result_json,
      coalesce(x.result_digest,d.source_result_digest) as result_digest
    from run_work_activations a
    join harness_executions e on e.run_id=a.run_id and e.work_activation_id=a.activation_id
    left join run_work_results x on x.run_id=e.run_id and x.execution_id=e.id
    left join run_hierarchy_direction_waits d on d.run_id=e.run_id and d.source_execution_id=e.id
    where a.run_id=$1 and a.workflow_node_id=$2 and (x.execution_id is not null or d.direction_id is not null)
    order by a.activation_sequence desc,e.attempt desc limit 1`,
  [runId, version.definition.hierarchy!.masterNodeId])).rows[0]
  const waiting = (await sql.query<{ direction_id: string; held_activation_id: string; execution: unknown }>(
    `select d.direction_id,d.held_activation_id,e.record as execution from run_hierarchy_direction_waits d
      join harness_executions e on e.run_id=d.run_id and e.id=d.held_execution_id
      where d.run_id=$1 and d.state='waiting' order by d.created_at desc,d.direction_id desc limit 1`, [runId])).rows[0]
  const terminal = run.record.executionState === 'completed'
  const state = terminal ? run.record.outcome === 'succeeded' ? 'succeeded'
    : run.record.outcome === 'canceled' ? 'canceled' : 'failed'
    : waiting && !run.stopped ? 'waiting_for_direction' : 'active'
  let accepted: Pick<WorkflowHierarchyCoordination, 'summary' | 'sourceExecution' | 'latestDeliverable'> = {}
  if (latest) {
    const execution = HarnessExecutionSchema.parse(latest.execution)
    const result = JSON.parse(latest.result_json) as unknown
    if (!sameRepeatValue(execution.result, result) || repeatDigest(result, 64 * 1024) !== latest.result_digest) {
      return repeatConflict('HIERARCHY_COORDINATION_SOURCE_CONFLICT')
    }
    const parsed = parseHierarchyWorkResult(result, version, execution.workflowNodeId, run.record.resultProtocol)
    const reference = ExecutionRefSchema.parse({ runId, workflowVersionId: version.id, executionId: execution.id,
      activationId: latest.activation_id, attempt: execution.attempt })
    accepted = { summary: parsed.summary, sourceExecution: reference,
      ...(parsed.data.latestDeliverable == null ? {} : {
        latestDeliverable: { execution: reference, resultDigest: latest.result_digest } }) }
  }
  const held = waiting && state === 'waiting_for_direction' ? HarnessExecutionSchema.parse(waiting.execution) : undefined
  return WorkflowHierarchyCoordinationSchema.parse({ state, ...accepted,
    ...(held ? { direction: { directionId: waiting!.direction_id, activationId: waiting!.held_activation_id,
      execution: { runId, workflowVersionId: version.id, executionId: held.id,
        activationId: waiting!.held_activation_id, attempt: held.attempt } } } : {}) })
}
