import {
  NativeGraphActivityRecordSchema, GraphExecutionIdentitySchema, RUN_GRAPH_LIMITS, canonicalGraphJson,
  type RunGraphScope,
} from '@foreman-code/contracts/wave25'
import type { GraphTransactionSql } from './connection.js'
import { RunGraphError } from './errors.js'

import { type CurrentNativeActivity, type CurrentActivityContext } from './nativeActivitySelection.js'
export { selectCurrentNodeActivity, type CurrentNativeActivity, type CurrentActivityContext } from './nativeActivitySelection.js'

export type CurrentNativeActivityRow = {
    execution_id: string; workflow_node_id: string; attempt: number; work_kind: 'workflow' | 'review'; work_id: string;
    agent_id: string; configuration_id: string; activity: unknown; last_native_sequence: string | null;
    terminal_native_sequence: string | null; projection_revision: string; work_closed: boolean | null
  }

/** Exported so disposable-DB qualification EXPLAINs the actual production query. */
export const CURRENT_NATIVE_ACTIVITIES_SQL = `
  with latest_workflow_executions as materialized (
    select distinct on (x.workflow_node_id) x.execution_id,x.workflow_node_id
    from run_repeat_executions x
      join harness_executions xe on xe.id=x.execution_id and xe.record #> '{input,tick}' is null
      left join run_repeat_occurrences o on o.occurrence_id=x.occurrence_id and o.run_id=x.run_id
      left join run_work_activations w on w.activation_id=x.work_activation_id and w.run_id=x.run_id
    where x.run_id=$1 and ($2::text[] is null or x.workflow_node_id=any($2))
    order by x.workflow_node_id,w.activation_sequence desc nulls last,coalesce(o.occurrence_index,0) desc,
      x.technical_attempt desc,x.execution_id desc
  )
  select a.execution_id,a.workflow_node_id,a.attempt,a.work_kind,a.work_id,
    e.record->>'agentId' as agent_id,e.record->>'agentConfigurationVersionId' as configuration_id,
    a.activity,a.last_native_sequence::text,a.terminal_native_sequence::text,a.projection_revision::text,
    e.record->>'state'='completed' as work_closed
  from run_native_activity a join harness_executions e on e.id=a.execution_id and e.run_id=a.run_id
    join latest_workflow_executions x on x.execution_id=a.execution_id and x.workflow_node_id=a.workflow_node_id
  where a.run_id=$1 and a.work_kind='workflow'
    and ($2::text[] is null or a.workflow_node_id=any($2))
  union all
  select a.execution_id,a.workflow_node_id,a.attempt,a.work_kind,a.work_id,
    e.record->>'agentId',e.record->>'agentConfigurationVersionId',a.activity,a.last_native_sequence::text,
    a.terminal_native_sequence::text,a.projection_revision::text,
    j.record->>'state'='completed' or j.record->'cleanup'->>'completedAt' is not null
  from run_native_activity a join harness_executions e on e.id=a.execution_id and e.run_id=a.run_id
    join review_jobs j on j.id=a.work_id and j.execution_id=a.execution_id
  where a.run_id=$1 and a.work_kind='review' and a.activity->>'status' in ('active','stale','unknown')
    and ($2::text[] is null or a.workflow_node_id=any($2))
  limit $3`

/** The two branches use current-only indexes; completed review history is never loaded. */
export async function readCurrentNativeActivities(sql: GraphTransactionSql, scope: RunGraphScope,
  nodeIds?: readonly string[], allowClosedForClear = false,
  prefetched?: CurrentNativeActivityRow[]): Promise<CurrentNativeActivity[]> {
  const result = prefetched ? { rows: prefetched } : await sql.query<CurrentNativeActivityRow>(CURRENT_NATIVE_ACTIVITIES_SQL,
    [scope.runId, nodeIds ? [...nodeIds] : null, RUN_GRAPH_LIMITS.nodes + RUN_GRAPH_LIMITS.exchanges + 1])
  if (result.rows.length > RUN_GRAPH_LIMITS.nodes + RUN_GRAPH_LIMITS.exchanges) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
  return result.rows.map((row) => {
    const record = NativeGraphActivityRecordSchema.parse({
      key: { execution: GraphExecutionIdentitySchema.parse({ workflowNodeId: row.workflow_node_id,
        executionId: row.execution_id, attempt: row.attempt, agentId: row.agent_id, agentConfigurationVersionId: row.configuration_id }),
      workKind: row.work_kind, workId: row.work_id },
      activity: row.activity, lastNativeSequence: row.last_native_sequence,
      terminalNativeSequence: row.terminal_native_sequence, projectionRevision: row.projection_revision,
    })
    if ((record.activity.execution && canonicalGraphJson(record.activity.execution) !== canonicalGraphJson(record.key.execution))
      || (!allowClosedForClear && row.work_closed !== false && ['active', 'stale'].includes(record.activity.status))) {
      throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    }
    return { key: record.key, activity: record.activity, lastNativeSequence: record.lastNativeSequence }
  })
}

/** A producer invokes this after its domain change, within the SAME Run publication. */
export async function readCurrentActivityContext(sql: GraphTransactionSql, scope: RunGraphScope,
  workflowNodeId: string): Promise<CurrentActivityContext> {
  const result = await sql.query<{ closed: boolean; workflow_closed: boolean; pending_id: string | null; delivery_blocked: boolean }>(
    `select r.stop_requested_at is not null or r.execution_state in ('completed','interrupted')
       or exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending) as closed,
       coalesce((select e.record->>'state'='completed' from harness_executions e
         join run_repeat_executions x on x.execution_id=e.id
         left join run_repeat_occurrences o on o.occurrence_id=x.occurrence_id and o.run_id=x.run_id
         left join run_work_activations w on w.activation_id=x.work_activation_id and w.run_id=x.run_id
         where e.run_id=r.id and e.workflow_node_id=$2 and e.record #> '{input,tick}' is null
         order by w.activation_sequence desc nulls last,coalesce(o.occurrence_index,0) desc,
           x.technical_attempt desc,x.execution_id desc limit 1),false) as workflow_closed,
       (select i.id from durable_interactions i join harness_executions e on e.id=i.execution_id and e.run_id=i.run_id
        where i.run_id=r.id and e.workflow_node_id=$2 and i.status='pending' order by i.id limit 1) as pending_id,
       exists(select 1 from durable_interactions i join harness_executions e on e.id=i.execution_id and e.run_id=i.run_id
        where i.run_id=r.id and e.workflow_node_id=$2 and i.status in ('decided','delivery_pending','delivery_failed')) as delivery_blocked
     from runs r where r.id=$1`, [scope.runId, workflowNodeId])
  const row = result.rows[0]
  if (!row) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
  return { closed: row.closed, workflowClosed: row.workflow_closed, deliveryBlocked: row.delivery_blocked,
    ...(row.pending_id ? { pendingInteractionId: row.pending_id } : {}) }
}
