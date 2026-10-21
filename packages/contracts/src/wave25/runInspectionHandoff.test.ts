import { expect, it } from 'vitest'
import { makeCurrentWorkflowFixture } from './currentFixture.js'
import { WorkActivationInputSchema } from './handoffs.js'
import { RunAcceptedInputValueSchema, RunExecutionDetailSchema, RUN_INSPECTION_LIMITS } from './runInspection.js'

const fixture = makeCurrentWorkflowFixture('inspection-handoff', 'single')
const workInput = WorkActivationInputSchema.parse({ executionSemanticsVersion: 3,
  runInput: fixture.run.input, occurrence: null, entry: null, predecessors: [],
  work: { kind: 'entry', activation: { scope: fixture.scope, activationId: 'original-activation',
    workflowNodeId: fixture.version.entryNodeId, lineageId: fixture.run.id, cause: { kind: 'entry' } } } })

it('discloses the complete accepted handoff input including its original activation', () => {
  expect(RunAcceptedInputValueSchema.parse(workInput)).toEqual(workInput)
})

it('preserves the complete handoff input beside an unaccepted interrupted report', () => {
  const node = fixture.version.definition.nodes[0]!
  const detail = { run: { ...fixture.scope, executionState: 'completed', outcome: 'failed',
    createdAt: fixture.run.createdAt, finishedAt: fixture.run.createdAt, cleanupPending: false },
  execution: { workflowNodeId: node.id, executionId: 'original-execution', agentId: node.agentId,
    agentConfigurationVersionId: fixture.version.agentConfigurationVersionIds[node.agentId], attempt: 1,
    state: 'completed', createdAt: fixture.run.createdAt, finishedAt: fixture.run.createdAt, acceptedResultAvailable: false },
  acceptedInput: { digest: `sha256:${'1'.repeat(64)}`, value: workInput },
  acceptedResult: { status: 'not_accepted' },
  reportedResult: { outcome: 'failed', error: { code: 'EXECUTION_INTERRUPTED', message: 'Original process closed.', retryable: false } } }
  expect(RunExecutionDetailSchema.parse(detail)).toEqual(detail)
})

it('still rejects malformed ancestry, extra fields and oversized work inputs', () => {
  for (const input of [
    { ...workInput, work: { ...workInput.work, activation: { ...workInput.work.activation, cause: { kind: 'join', joinId: 'foreign-activation' } } } },
    { ...workInput, extra: 'unaccepted-field' },
    { ...workInput, runInput: { payload: 'x'.repeat(RUN_INSPECTION_LIMITS.inputBytes) } },
  ]) expect(RunAcceptedInputValueSchema.safeParse(input).success).toBe(false)
})

it('preserves the existing exact ordinary V3 input shape', () => {
  const ordinary = { executionSemanticsVersion: 3, runInput: fixture.run.input, occurrence: null, entry: null, predecessors: [] }
  expect(RunAcceptedInputValueSchema.parse(ordinary)).toEqual(ordinary)
})
