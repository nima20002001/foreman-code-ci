import type { RunExecutionsListInput } from '@foreman-code/contracts/wave25'
import type { ExecutionPagePosition } from './inspectionCursor.js'

export const INSPECTION_OCCURRENCE_COLUMNS = `o.occurrence_id,o.run_id as occurrence_run_id,o.workspace_id as occurrence_workspace_id,
  o.workflow_id as occurrence_workflow_id,o.workflow_version_id as occurrence_version_id,
  o.block_id as occurrence_block_id,o.occurrence_index,o.record->'identity' as occurrence_identity`

/** Input is parsed by RunExecutionsListInputSchema in the shared service.
 * Separate equality shapes match the four keyset indexes; no nullable-OR
 * filters, OFFSET, lifetime aggregate, unbounded JSON bodies or interpolated IDs. */
export function inspectionExecutionsQuery(input: RunExecutionsListInput, after: ExecutionPagePosition | undefined) {
  const values: unknown[] = [input.runId]
  const where = ['e.run_id=$1']
  if (input.workflowNodeId !== undefined) { values.push(input.workflowNodeId); where.push(`e.workflow_node_id=$${values.length}`) }
  if (input.occurrenceId !== undefined) { values.push(input.occurrenceId); where.push(`e.repeat_occurrence_id=$${values.length}`) }
  if (after) {
    values.push(after.createdAt, after.executionId)
    where.push(`(e.created_at,e.id)<($${values.length - 1}::timestamptz,$${values.length}::text)`)
  }
  values.push(input.limit + 1)
  const agents = `select e.id,e.run_id,e.workflow_node_id,e.agent_id,e.attempt,e.repeat_occurrence_id,e.accepted,e.created_at,
        to_char(e.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as page_created_at,
        jsonb_strip_nulls(jsonb_build_object('executionId',e.record->'id','workflowNodeId',e.record->'workflowNodeId',
          'agentId',e.record->'agentId','agentConfigurationVersionId',e.record->'agentConfigurationVersionId',
          'attempt',e.record->'attempt','state',e.record->'state','failure',e.record#>'{result,error}',
          'continuedFromExecutionId',e.record#>'{sessionContinuation,previousExecutionId}',
          'createdAt',e.record->'createdAt','tickIndex',(e.record #>> '{input,tick,index}')::integer,
          'startedAt',e.record->'startedAt','finishedAt',e.record->'finishedAt','acceptedResultAvailable',e.accepted,
          'worktree',(select jsonb_build_object('repository',np.record#>'{materialization,receipt,worktree,repository}',
            'branch',np.record#>'{materialization,receipt,worktree,branch}') from execution_native_placements np
            where np.execution_id=e.id and np.record#>'{materialization,receipt,worktree}' is not null))) as summary,
        e.record->'result'->>'outcome' as reported_outcome,
        x.identity,x.run_id as identity_run_id,x.occurrence_id as identity_occurrence_id,x.technical_attempt,
        s.slot_id,s.run_id as slot_run_id,s.workflow_node_id as slot_node_id,s.occurrence_id as slot_occurrence_id,
        s.work_activation_id,e.work_activation_id as native_work_activation_id,x.work_activation_id as attempt_work_activation_id,
        ${INSPECTION_OCCURRENCE_COLUMNS},true as job_pinned,null::integer as job_definition_revision
        from harness_executions e left join run_repeat_executions x on x.execution_id=e.id
        left join run_repeat_slots s on s.slot_id=x.slot_id
        left join run_repeat_occurrences o on o.occurrence_id=e.repeat_occurrence_id
        where e.run_id=$1`
  const jobs = `select j.id,w.run_id,x.workflow_node_id,null::text as agent_id,x.technical_attempt as attempt,
        x.occurrence_id as repeat_occurrence_id,(r.execution_id is not null) as accepted,j.created_at,
        to_char(j.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as page_created_at,
        jsonb_strip_nulls(jsonb_build_object('kind','job','executionId',j.record->'id','workflowNodeId',j.record#>'{workflow,nodeId}',
          'jobDefinitionId',j.accepted_spec->'definitionId','jobDefinitionVersionId',j.accepted_spec->'definitionVersionId',
          'attempt',x.technical_attempt,'state',case j.record#>>'{process,phase}' when 'preparing' then 'starting'
            when 'terminal' then 'completed' else j.record#>>'{process,phase}' end,
          'createdAt',j.record->'createdAt','startedAt',j.record->'startedAt','finishedAt',j.record->'finishedAt',
          'acceptedResultAvailable',r.execution_id is not null)) as summary,
        case when r.execution_id is not null then 'succeeded' when j.record#>>'{process,phase}'<>'terminal' then null
          when j.record#>>'{process,outcome}'='succeeded' then 'succeeded'
          when j.record#>>'{process,outcome}'='cancelled' then 'canceled' else 'failed' end as reported_outcome,
        x.identity,x.run_id as identity_run_id,x.occurrence_id as identity_occurrence_id,x.technical_attempt,
        s.slot_id,s.run_id as slot_run_id,s.workflow_node_id as slot_node_id,s.occurrence_id as slot_occurrence_id,
        s.work_activation_id,null::text as native_work_activation_id,x.work_activation_id as attempt_work_activation_id,
        ${INSPECTION_OCCURRENCE_COLUMNS},
        coalesce(j.accepted_spec=j.record->'acceptedSpec' and j.id=w.node_execution_id and j.workspace_id=run.workspace_id
          and j.record->>'id'=j.id and j.record->>'workspaceId'=j.workspace_id
          and j.record->>'attemptId'=j.attempt_id and j.record->>'operationId'=j.operation_id
          and j.record#>>'{workflow,runId}'=w.run_id and j.record#>>'{workflow,nodeExecutionId}'=w.node_execution_id
          and j.record#>>'{workflow,workflowId}'=run.workflow_id
          and w.reference->>'workflowVersionId'=run.workflow_version_id and w.reference->>'workspaceId'=run.workspace_id
          and w.reference->>'workflowId'=run.workflow_id and w.reference->>'runId'=run.id
          and w.reference->>'kind'='job' and w.reference->>'nodeId'=x.workflow_node_id
          and w.reference->>'nodeExecutionId'=j.id and w.reference->>'jobExecutionId'=j.id
          and w.reference->>'occurrenceId' is not distinct from x.occurrence_id
          and (w.reference->>'occurrenceIndex')::integer=coalesce(o.occurrence_index,0)
          and j.definition_version_id=j.accepted_spec->>'definitionVersionId'
          and p.preparation->>'workspaceId'=run.workspace_id and p.preparation->>'workflowId'=run.workflow_id
          and p.preparation->>'workflowVersionId'=run.workflow_version_id
          and p.preparation->>'executionId'=j.id and p.preparation->>'attemptId'=j.attempt_id
          and p.preparation->>'operationId'=j.operation_id and p.preparation->>'runId'=w.run_id
          and p.preparation->>'nodeId'=x.workflow_node_id,false) as job_pinned,
        (j.accepted_spec->>'definitionRevision')::integer as job_definition_revision
        from workflow_job_executions w join job_executions j on j.id=w.job_execution_id
        join runs run on run.id=w.run_id
        left join run_repeat_executions x on x.execution_id=w.node_execution_id and x.run_id=w.run_id and x.executor_kind='job'
        left join run_repeat_slots s on s.slot_id=x.slot_id and s.run_id=w.run_id
        left join workflow_job_preparations p on p.slot_id=s.slot_id and p.run_id=w.run_id
        left join run_repeat_occurrences o on o.occurrence_id=x.occurrence_id and o.run_id=w.run_id
        left join run_repeat_results r on r.execution_id=j.id and r.run_id=w.run_id
        where w.run_id=$1`
  return { text: `select e.* from (${agents} union all ${jobs}) e where ${where.join(' and ')}
        order by e.created_at desc,e.id desc limit $${values.length}`, values }
}
