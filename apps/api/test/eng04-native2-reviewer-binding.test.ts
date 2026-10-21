import assert from 'node:assert/strict'
import { test } from 'vitest'
import { HarnessExecutionSchema, type HarnessExecution } from '@foreman-code/contracts'
import { JobWorkflowNodeSchema } from '@foreman-code/contracts/job-workflow'
import { RepeatWorkflowVersionV1Schema, SavedRunVersionSnapshotSchema } from '@foreman-code/contracts/wave25'
import { PostgresRepeatReviewerBindings } from '../src/modules/interactions/repeatReviewer.js'
import { repeatDigest, repeatExecutionIdentity, repeatSlotId } from '../src/modules/runs/repeatResolution.js'
import { repeatTerminalResolution } from '../src/modules/runs/repeatNode.js'
import { native2Fixture } from './eng04-native2-fixtures.js'

/** Scripted rows, NOT PostgreSQL. SQL identity/value parameters are checked;
 * real constraint/lock/transaction behavior remains an integration requirement. */
function bindingFixture() {
  const f = native2Fixture()
  const approval = { handler: 'orchestrator' as const, designatedOrchestratorAgentId: 'agent-work' }
  const version = RepeatWorkflowVersionV1Schema.parse({ ...f.fixture.version, approval,
    definition: { ...f.fixture.version.definition, approval, edges: [...f.fixture.version.definition.edges,
      { id: 'approval-work-review', kind: 'approval', source: 'work', target: 'review' }] } })
  const run = { ...f.run, approval }
  SavedRunVersionSnapshotSchema.parse({ run, version })
  const occurrence = f.fixture.occurrence
  const reviewer = HarnessExecutionSchema.parse({ ...f.get(), id: 'reviewer-accepted-occurrence-1',
    workflowNodeId: 'work', agentId: 'agent-work', agentConfigurationVersionId: 'config-work',
    nativeSessionId: 'reviewer-session-occurrence-1', result: { outcome: 'succeeded', output: { accepted: true } } })
  const reviewerRef = { nodeId: 'work', occurrence: occurrence.identity }
  const executionRow = (execution: HarnessExecution) => ({ record: execution,
    identity: { ...repeatExecutionIdentity(execution), occurrence: occurrence.identity }, accepted: execution.id === reviewer.id,
    execution_id: execution.id, run_id: run.id, workflow_node_id: execution.workflowNodeId, agent_id: execution.agentId,
    attempt: execution.attempt, technical_attempt: execution.attempt,
    slot_id: repeatSlotId(run.id, { nodeId: execution.workflowNodeId, occurrence: occurrence.identity }),
    occurrence_id: occurrence.identity.occurrenceId, execution_occurrence_id: occurrence.identity.occurrenceId,
    identity_occurrence_id: occurrence.identity.occurrenceId, input_json: JSON.stringify(execution.input),
    input_digest: repeatDigest(execution.input, 4 * 1024 * 1024), occurrence_record: occurrence })
  const requesterRow = executionRow(f.get()), reviewerRow = executionRow(reviewer)
  const resolutionRow = { record: repeatTerminalResolution(version, f.fixture.scope, reviewerRef, reviewer),
    execution_id: reviewer.id, source_occurrence_id: occurrence.identity.occurrenceId }
  const resultRow = { execution_id: reviewer.id, run_id: run.id, occurrence_id: occurrence.identity.occurrenceId, result_json: JSON.stringify(reviewer.result), result_digest: repeatDigest(reviewer.result, 64 * 1024) }
  const statements: { text: string; values: unknown[] }[] = []
  const sql = { query: async (text: string, values: unknown[]) => {
    statements.push({ text, values })
    if (text.includes('from runs r join workflow_versions')) return { rows: [{ run_record: run, version_record: version,
      run_id: run.id, workspace_id: run.workspaceId, workflow_id: run.workflowId, workflow_version_id: version.id }] }
    if (text.includes('from harness_executions e join run_repeat_executions')) {
      assert.equal(values[1], run.id)
      assert.ok([f.get().id, reviewer.id].includes(String(values[0])), 'unknown execution cannot be read as latest reviewer')
      return { rows: [values[0] === f.get().id ? requesterRow : reviewerRow] }
    }
    if (text.includes('from run_repeat_resolutions')) {
      assert.deepEqual(values, [run.id, occurrence.identity.occurrenceId, 'work'])
      assert.ok(!/order by|limit 1/i.test(text), 'selection must not prefer latest work')
      return { rows: [resolutionRow] }
    }
    if (text.includes('from run_repeat_results')) {
      assert.deepEqual(values, [run.id, reviewer.id])
      return { rows: [resultRow] }
    }
    throw new Error(`Unexpected selector SQL: ${text}`)
  } }
  const request = { workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id,
    executionId: f.get().id, requestingAgentId: f.get().agentId, approval,
    harness: 'codex' as const, nativeSessionId: f.get().nativeSessionId! }
  const select = (nodeId = 'work') => new PostgresRepeatReviewerBindings(sql as never).select(request, nodeId)
  return { select, version, request, requesterRow, reviewerRow, resolutionRow, resultRow, reviewer, occurrence, statements }
}

function addJob(f: ReturnType<typeof bindingFixture>) {
  const job = JobWorkflowNodeSchema.parse({ kind: 'job', id: 'review-binding-job', name: 'Build',
    jobDefinitionId: 'binding-job', jobDefinitionRevision: 1, jobDefinitionVersionId: 'binding-job-version' })
  f.version.definition.nodes.unshift(job)
  f.version.definition.executionPolicy!.maxNodeExecutions++
  return job
}

test('NATIVE-2 reviewer binding reads the accepted same-occurrence execution and exact relationship', async () => {
  const f = bindingFixture()
  addJob(f)
  const bound = await f.select()
  assert.equal(bound.execution.id, f.reviewer.id)
  assert.equal(bound.relationshipId, 'approval-work-review')
  assert.equal(bound.requesterOccurrenceId, f.occurrence.identity.occurrenceId)
  assert.equal(bound.reviewerOccurrenceId, f.occurrence.identity.occurrenceId)
  assert.equal(f.statements.length, 5)
})

test('NATIVE-2 reviewer binding refuses a Job reviewer without choosing a neighboring accepted Agent', async () => {
  const f = bindingFixture(), job = addJob(f)
  await assert.rejects(f.select(job.id), { code: 'REPEAT_REVIEW_IDENTITY_CONFLICT' })
  assert.equal(f.statements.length, 2)
  assert.equal(f.statements.some(({ text }) => text.includes('from run_repeat_resolutions')), false)
})

test('NATIVE-2 reviewer binding rejects a physical occurrence mismatch before resolving review work', async () => {
  const f = bindingFixture()
  f.requesterRow.execution_occurrence_id = 'occurrence-other'
  await assert.rejects(f.select(), { code: 'REPEAT_REVIEW_IDENTITY_CONFLICT' })
  assert.equal(f.statements.length, 2)
})

test('NATIVE-2 reviewer binding rejects another accepted occurrence as the relationship source', async () => {
  const f = bindingFixture()
  f.resolutionRow.source_occurrence_id = 'occurrence-other'
  await assert.rejects(f.select(), { code: 'REPEAT_REVIEW_IDENTITY_CONFLICT' })
})

test('NATIVE-2 reviewer binding rejects an unaccepted technical attempt and contradictory result receipt', async () => {
  const f = bindingFixture()
  f.reviewerRow.accepted = false
  await assert.rejects(f.select(), { code: 'REPEAT_REVIEW_IDENTITY_CONFLICT' })
  f.reviewerRow.accepted = true
  f.resultRow.result_digest = `sha256:${'f'.repeat(64)}`
  await assert.rejects(f.select(), { code: 'REPEAT_REVIEW_IDENTITY_CONFLICT' })
})

test('NATIVE-2 reviewer binding rejects a different requester native session', async () => {
  const f = bindingFixture()
  f.request.nativeSessionId = 'native-session-another-occurrence'
  await assert.rejects(f.select(), { code: 'REPEAT_REVIEW_IDENTITY_CONFLICT' })
  assert.equal(f.statements.length, 2)
})
