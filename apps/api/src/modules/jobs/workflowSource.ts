import { JobExecutionRecordSchema } from '@foreman-code/contracts/job-verification'
import { JobWorkflowExecutionReferenceSchema, JobWorkflowNodeSchema } from '@foreman-code/contracts/job-workflow'
import { AcceptedCurrentNodeResultSchema, type WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { assertGraphTransaction, type GraphTransactionSql } from '../run-graph/connection.js'
import { canonicalRepeatEffectReceipt } from '../run-graph/repeatPublication.js'
import { assertRepeatCanonicalReceiptLocked,
  requireRepeatCanonicalReceiptBeforeCommit } from '../run-graph/repeatReceipts.js'
import { assertRepeatRef, repeatConflict, repeatDigest, repeatSlotId, sameRepeatValue,
  type RepeatResolution, type RepeatScope, type RepeatSource } from '../runs/repeatResolution.js'

interface AcceptedJobRow {
  record: unknown
  accepted_spec: unknown
  reference: unknown
  accepted: boolean
  identity: unknown
  slot_id: string
  occurrence_id: string | null
  input_json: string
  input_digest: string
  workflow_input_json: string
  result_json: string
  result_digest: string
  result_occurrence_id: string | null
}

/** Reads the typed Job result accepted by the same Run without a harness row. */
export async function readWorkflowJobSourceLocked(sql: GraphTransactionSql, scope: RepeatScope,
  version: WorkflowVersionV3, resolution: RepeatResolution, relationshipId: string): Promise<RepeatSource> {
  assertGraphTransaction(sql)
  const { ref, value } = resolution
  const identity = value.execution
  assertRepeatRef(version, scope, ref)
  if (identity?.kind !== 'job' || value.resolution !== 'succeeded' || !value.acceptedResultDigest) {
    return repeatConflict('REPEAT_INPUT_NOT_ACCEPTED')
  }
  const node = JobWorkflowNodeSchema.parse(version.definition.nodes.find(item => item.id === ref.nodeId))
  const row = (await sql.query<AcceptedJobRow>(`select j.record,j.accepted_spec,w.reference,w.accepted,
    x.identity,x.slot_id,x.occurrence_id,s.input_json,s.input_digest,w.input_json as workflow_input_json,
    r.result_json,r.result_digest,r.occurrence_id as result_occurrence_id
    from run_repeat_executions x
    join job_executions j on j.id=x.execution_id and j.workspace_id=$3
    join workflow_job_executions w on w.run_id=x.run_id
      and w.node_execution_id=x.execution_id and w.job_execution_id=j.id
    join run_repeat_slots s on s.slot_id=x.slot_id and s.run_id=x.run_id
      and s.workflow_node_id=x.workflow_node_id and s.occurrence_id is not distinct from x.occurrence_id
    join run_repeat_results r on r.run_id=x.run_id and r.execution_id=x.execution_id
    where x.run_id=$1 and x.execution_id=$2 and x.executor_kind='job'
    for share of j,w,x,s`, [scope.runId, identity.executionId, scope.workspaceId])).rows[0]
  if (!row || !row.accepted) return repeatConflict('REPEAT_INPUT_NOT_ACCEPTED')
  const execution = JobExecutionRecordSchema.parse(row.record)
  const occurrenceId = ref.occurrence?.occurrenceId ?? null
  const bare = { kind: 'job' as const, workflowNodeId: node.id, executionId: execution.id,
    jobDefinitionId: node.jobDefinitionId, jobDefinitionVersionId: node.jobDefinitionVersionId, attempt: 1 }
  const qualified = { ...bare, occurrence: ref.occurrence }
  const reference = JobWorkflowExecutionReferenceSchema.parse(row.reference)
  const expectedReference = { kind: 'job', workspaceId: scope.workspaceId, workflowId: scope.workflowId,
    workflowVersionId: scope.workflowVersionId, runId: scope.runId, nodeId: ref.nodeId,
    nodeExecutionId: execution.id, jobExecutionId: execution.id, occurrenceId,
    occurrenceIndex: ref.occurrence?.occurrenceIndex ?? 0 }
  if (execution.id !== identity.executionId || execution.workspaceId !== scope.workspaceId
    || execution.workflow?.runId !== scope.runId || execution.workflow.workflowId !== scope.workflowId
    || execution.workflow.nodeId !== ref.nodeId || execution.workflow.nodeExecutionId !== execution.id
    || execution.acceptedSpec.definitionId !== node.jobDefinitionId
    || execution.acceptedSpec.definitionVersionId !== node.jobDefinitionVersionId
    || execution.acceptedSpec.definitionRevision !== node.jobDefinitionRevision
    || !sameRepeatValue(execution.acceptedSpec, row.accepted_spec)
    || !sameRepeatValue(reference, expectedReference) || !sameRepeatValue(identity, bare)
    || !sameRepeatValue(row.identity, ref.occurrence ? qualified : bare)
    || row.slot_id !== repeatSlotId(scope.runId, ref) || row.occurrence_id !== occurrenceId
    || row.result_occurrence_id !== occurrenceId || execution.process.phase !== 'terminal'
    || !execution.process.processStopped || !execution.finishedAt
    || ['pending', 'collecting'].includes(execution.publication)) return repeatConflict('REPEAT_INPUT_NOT_ACCEPTED')
  const input = JSON.parse(row.input_json) as unknown
  const acceptedResult = AcceptedCurrentNodeResultSchema.parse(JSON.parse(row.result_json))
  if (!sameRepeatValue(input, execution.acceptedSpec.workflowInput)
    || !sameRepeatValue(input, JSON.parse(row.workflow_input_json))
    || repeatDigest(input, 4 * 1024 * 1024) !== row.input_digest
    || acceptedResult.outcome !== 'succeeded' || row.result_digest !== value.acceptedResultDigest
    || repeatDigest(acceptedResult, 64 * 1024) !== row.result_digest) return repeatConflict('REPEAT_INPUT_NOT_ACCEPTED')
  for (const kind of ['input.bind', 'terminal.accept'] as const) {
    const effect = (await sql.query<{ payload_digest: string }>(
      'select payload_digest from run_repeat_effects where run_id=$1 and effect_kind=$2 and entity_id=$3',
      [scope.runId, kind, execution.id])).rows[0]
    if (!effect) return repeatConflict('REPEAT_EFFECT_MISSING')
    const receipt = canonicalRepeatEffectReceipt(scope, { kind, entityId: execution.id, digest: effect.payload_digest })
    await assertRepeatCanonicalReceiptLocked(sql, receipt)
    requireRepeatCanonicalReceiptBeforeCommit(sql, receipt)
  }
  return { relationshipId, execution: identity, occurrence: ref.occurrence,
    acceptedResultDigest: row.result_digest, acceptedResult }
}
