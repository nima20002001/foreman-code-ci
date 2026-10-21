import {
  GraphSequenceSchema, REPEAT_GRAPH_LIMITS, RepeatGraphExecutionV3Schema, RepeatOccurrenceV1Schema,
  qualifyRepeatGraphExecution, sameCanonicalGraphScope,
  type GraphEvidence, type RepeatGraphExecutionV3, type RepeatGraphScopeV3,
} from '@foreman-code/contracts/wave25'
import { repeatSlotId } from '../runs/repeatResolution.js'
import { assertGraphTransaction, type GraphTransactionSql } from './connection.js'
import { RunGraphError } from './errors.js'
import { graphSourceDigest } from './graphDigest.js'
import { repeatExecutionStateDigest } from './graphDigest.js'

interface JobProjectionRow {
  execution_id: string
  workflow_node_id: string
  slot_id: string
  occurrence_id: string | null
  occurrence: unknown
  definition_id: string
  definition_version_id: string
  input_digest: string
  phase: string | null
  outcome: string | null
  stopped: boolean | null
  finished_at: string | null
  publication: string | null
  result_issue: string | null
  valid: boolean | null
}

/** A workflow Job's lifecycle as graph and status readers show it. */
export function workflowJobLifecycle(row: Pick<JobProjectionRow, 'phase' | 'outcome' | 'stopped' | 'finished_at'
  | 'publication' | 'result_issue'>): Pick<RepeatGraphExecutionV3, 'state' | 'resultOutcome'> {
  const terminal = row.phase === 'terminal' && row.stopped === true && !!row.finished_at
    && ['complete', 'failed', 'expired'].includes(row.publication ?? '')
  if (!terminal) return { state: row.phase === 'queued' || row.phase === 'running' ? row.phase : 'starting', resultOutcome: null }
  if (row.outcome === 'cancelled') return { state: 'completed', resultOutcome: 'canceled' }
  if (row.outcome === 'succeeded' && row.publication === 'complete' && !row.result_issue) return { state: 'completed', resultOutcome: 'succeeded' }
  return { state: 'completed', resultOutcome: 'failed' }
}

/** The preparation reserves the execution identity before a Job is admitted. */
export async function readWorkflowJobGraphExecutionsLocked(sql: GraphTransactionSql, scope: RepeatGraphScopeV3,
  executionIds?: readonly string[]): Promise<RepeatGraphExecutionV3[]> {
  assertGraphTransaction(sql)
  const rows = await sql.query<JobProjectionRow>(`
    select p.preparation->>'executionId' as execution_id,s.workflow_node_id,s.slot_id,s.occurrence_id,
      o.record as occurrence,n.node->>'jobDefinitionId' as definition_id,
      n.node->>'jobDefinitionVersionId' as definition_version_id,s.input_digest,
      j.record #>> '{process,phase}' as phase,j.record #>> '{process,outcome}' as outcome,
      (j.record #>> '{process,processStopped}')::boolean as stopped,j.record->>'finishedAt' as finished_at,
      j.record->>'publication' as publication,j.record->>'resultIssue' as result_issue,
      (s.run_id=p.run_id and n.node->>'kind'='job'
        and p.preparation->>'workspaceId'=$3 and p.preparation->>'workflowId'=$4
        and p.preparation->>'workflowVersionId'=$5 and p.preparation->>'runId'=s.run_id
        and p.preparation->>'nodeId'=s.workflow_node_id and p.preparation->>'inputDigest'=s.input_digest
        and p.preparation->'input'=s.input_json::jsonb and s.work_activation_id is null
        and case when x.execution_id is null then j.id is null and w.job_execution_id is null else
          x.run_id=s.run_id and x.slot_id=s.slot_id and x.executor_kind='job'
          and x.occurrence_id is not distinct from s.occurrence_id
          and x.work_activation_id is null and x.technical_attempt=1 and x.previous_execution_id is null
          and x.identity=(jsonb_build_object('kind','job','workflowNodeId',s.workflow_node_id,
            'executionId',j.id,'jobDefinitionId',n.node->>'jobDefinitionId',
            'jobDefinitionVersionId',n.node->>'jobDefinitionVersionId','attempt',1)
            || case when s.occurrence_id is null then '{}'::jsonb
              else jsonb_build_object('occurrence',o.record->'identity') end)
          and w.job_execution_id=j.id and w.input_json::jsonb=s.input_json::jsonb
          and w.reference=jsonb_build_object('kind','job','workspaceId',$3::text,'workflowId',$4::text,
            'workflowVersionId',$5::text,'runId',s.run_id,'nodeId',s.workflow_node_id,
            'nodeExecutionId',j.id,'jobExecutionId',j.id,'occurrenceId',s.occurrence_id,
            'occurrenceIndex',coalesce(o.occurrence_index,0))
          and j.workspace_id=$3 and j.attempt_id=p.preparation->>'attemptId'
          and j.operation_id=p.preparation->>'operationId'
          and j.definition_version_id=n.node->>'jobDefinitionVersionId'
          and j.record->>'id'=j.id and j.record->>'workspaceId'=$3
          and j.record->>'attemptId'=j.attempt_id and j.record->>'operationId'=j.operation_id
          and j.record #>> '{workflow,workflowId}'=$4 and j.record #>> '{workflow,runId}'=s.run_id
          and j.record #>> '{workflow,nodeId}'=s.workflow_node_id
          and j.record #>> '{workflow,nodeExecutionId}'=j.id
          and j.record->'acceptedSpec'=j.accepted_spec
          and j.accepted_spec->>'definitionId'=n.node->>'jobDefinitionId'
          and j.accepted_spec->>'definitionRevision'=n.node->>'jobDefinitionRevision'
          and j.accepted_spec->>'definitionVersionId'=n.node->>'jobDefinitionVersionId'
          and j.accepted_spec->'workflowInput'=s.input_json::jsonb end) as valid
    from workflow_job_preparations p left join run_repeat_slots s on s.slot_id=p.slot_id
    left join run_repeat_occurrences o on o.occurrence_id=s.occurrence_id and o.run_id=s.run_id
    left join workflow_versions v on v.id=$5
    left join lateral jsonb_array_elements(v.record->'definition'->'nodes') n(node)
      on n.node->>'id'=s.workflow_node_id
    left join run_repeat_executions x on x.execution_id=p.preparation->>'executionId'
    left join workflow_job_executions w on w.run_id=p.run_id and w.node_execution_id=p.preparation->>'executionId'
    left join job_executions j on j.id=p.preparation->>'executionId'
    where p.run_id=$1 and ($2::text[] is null or p.preparation->>'executionId'=any($2::text[]))
    order by execution_id limit $6`,
  [scope.runId, executionIds ? [...executionIds] : null, scope.workspaceId, scope.workflowId,
    scope.workflowVersionId, REPEAT_GRAPH_LIMITS.executions + 1])
  if (rows.rows.length > REPEAT_GRAPH_LIMITS.executions) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
  return rows.rows.map(row => {
    const occurrence = row.occurrence_id === null ? null : RepeatOccurrenceV1Schema.parse(row.occurrence).identity
    if (row.valid !== true || occurrence && (!sameCanonicalGraphScope(occurrence.scope, scope)
      || occurrence.occurrenceId !== row.occurrence_id)
      || row.slot_id !== repeatSlotId(scope.runId, { nodeId: row.workflow_node_id, occurrence })) {
      throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    }
    const { state, resultOutcome } = workflowJobLifecycle(row)
    return RepeatGraphExecutionV3Schema.parse({ identity: qualifyRepeatGraphExecution({
      kind: 'job', workflowNodeId: row.workflow_node_id, executionId: row.execution_id,
      jobDefinitionId: row.definition_id, jobDefinitionVersionId: row.definition_version_id, attempt: 1,
    }, occurrence), inputDigest: row.input_digest, previousExecutionId: null, state, resultOutcome })
  })
}

interface JobExecutionSource {
  evidence: GraphEvidence
  sourceDigest: string
  semanticDigest: string
  fact: { type: 'repeat.execution'; execution: RepeatGraphExecutionV3 }
}

/** Changes use positions from the shared Run head, including preparation. */
export async function workflowJobGraphSourceChangesLocked(sql: GraphTransactionSql,
  scope: RepeatGraphScopeV3): Promise<JobExecutionSource[]> {
  const executions = await readWorkflowJobGraphExecutionsLocked(sql, scope)
  if (!executions.length) return []
  const head = (await sql.query<{ sequence: string }>(
    'select head_sequence::text as sequence from run_graph_heads where run_id=$1', [scope.runId])).rows[0]
  if (!head) throw new RunGraphError('GRAPH_NOT_INITIALIZED')
  GraphSequenceSchema.parse(head.sequence)
  const rows = await sql.query<{ source_id: string; source_revision: string; source_digest: string;
    semantic_digest: string; first_sequence: string }>(`
    select distinct on (s.source_id) s.source_id,s.source_revision::text,s.source_digest,
      s.semantic_digest,s.first_sequence::text
    from run_graph_sources s where s.run_id=$1 and s.source_kind='execution' and s.source_id=any($2::text[])
    order by s.source_id,s.source_revision desc`, [scope.runId, executions.map(execution => execution.identity.executionId)])
  const latest = new Map(rows.rows.map(row => [row.source_id, row]))
  const changes: JobExecutionSource[] = []
  for (const execution of executions) {
    const prior = latest.get(execution.identity.executionId)
    if (prior && (!GraphSequenceSchema.safeParse(prior.first_sequence).success
      || prior.source_revision !== prior.first_sequence || BigInt(prior.first_sequence) < 1n
      || BigInt(prior.first_sequence) > BigInt(head.sequence))) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    const fact = { type: 'repeat.execution' as const, execution }
    const sourceDigest = repeatExecutionStateDigest(scope, execution)
    const semanticDigest = graphSourceDigest([fact])
    if (prior?.source_digest === sourceDigest && prior.semantic_digest === semanticDigest) continue
    changes.push({ evidence: { sourceKind: 'execution', sourceId: execution.identity.executionId,
      sourceRevision: GraphSequenceSchema.parse(String(BigInt(head.sequence) + 1n)) }, sourceDigest, semanticDigest, fact })
  }
  return changes
}
