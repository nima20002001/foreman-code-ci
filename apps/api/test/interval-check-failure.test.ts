import { expect, it, vi } from 'vitest'
import { HarnessExecutionSchema, type ExecutionResult } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { DomainError } from '../src/modules/errors.js'
import { repeatExecutionDriver } from '../src/modules/runs/repeatRuntime.js'
import { canContinueWorkflowSession } from '../src/modules/runs/sessionContinuation.js'

it('uses a fresh session after a failed loop check and preserves graph retry continuation', () => {
  const fixture = makeCurrentWorkflowFixture('interval-check-continuation', 'single')
  const node = fixture.version.definition.nodes[0]!
  const execution = HarnessExecutionSchema.parse({
    id: 'next-check', runId: fixture.run.id, workflowNodeId: node.id,
    agentId: node.agentId, agentConfigurationVersionId: fixture.version.agentConfigurationVersionIds[node.agentId],
    attempt: 1, input: { tick: { index: 2, everySeconds: 10 } },
    state: 'starting', workingDirectory: '/project', createdAt: fixture.createdAt,
  })
  const previous = HarnessExecutionSchema.parse({ ...execution, id: 'failed-check',
    input: { tick: { index: 1, everySeconds: 10 } }, state: 'completed', nativeSessionId: 'closed-session',
    result: { outcome: 'failed', error: { code: 'EXECUTION_INTERRUPTED', message: 'Native process exited.', retryable: false } },
    finishedAt: fixture.createdAt })
  expect(canContinueWorkflowSession(previous, execution)).toBe(false)
  expect(canContinueWorkflowSession({ ...previous, result: { outcome: 'succeeded' } }, execution)).toBe(true)
  expect(canContinueWorkflowSession({ ...previous, input: {} }, { ...execution, input: {}, attempt: 2 })).toBe(true)
})

it.each([
  new Error('Native startup failed'),
  new DomainError('APP_MCP_PREFLIGHT_FAILED', 'App MCP preflight failed', 409),
  new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'Harness profile unavailable', 409),
  new DomainError('NATIVE_SESSION_START_UNCERTAIN', 'Native startup interrupted', 409),
])('records a failed check without requesting Run cleanup: %s', async error => {
  const fixture = makeCurrentWorkflowFixture('interval-check-failure', 'single')
  const node = fixture.version.definition.nodes[0]!
  node.interval = { everySeconds: 10 }
  let execution = HarnessExecutionSchema.parse({
    id: 'interval-check', runId: fixture.run.id, workflowNodeId: node.id,
    agentId: node.agentId, agentConfigurationVersionId: fixture.version.agentConfigurationVersionIds[node.agentId],
    attempt: 1, input: { tick: { index: 1, everySeconds: 10 } },
    state: 'starting', createdAt: fixture.createdAt,
  })
  const stored = () => ({ execution, ref: { nodeId: node.id, occurrence: null }, slotId: 'check-slot',
    input: { executionSemanticsVersion: 3 as const, runInput: {}, occurrence: null, entry: null, predecessors: [] },
    inputDigest: `sha256:${'1'.repeat(64)}`, accepted: false })
  const settleNativeExecution = vi.fn(async () => {})
  const abandonAttempt = vi.fn(async () => {})
  const failIntervalCheck = vi.fn(async (id: string, result: ExecutionResult) => {
    expect(id).toBe(execution.id)
    expect(result).toMatchObject({ outcome: 'failed', error: { retryable: false } })
    execution = HarnessExecutionSchema.parse({ ...execution, state: 'completed', result,
      finishedAt: fixture.createdAt })
  })
  const input = { scope: fixture.scope, version: fixture.version, owner: { assertOwned() {} },
    store: { readExecution: async () => stored(), settleNativeExecution },
    observeExact: async () => { throw error }, abandonAttempt, failIntervalCheck }
  const driver = repeatExecutionDriver(input)
  await driver.observe(execution, new AbortController().signal)
  expect(failIntervalCheck).toHaveBeenCalledOnce()
  expect(abandonAttempt).not.toHaveBeenCalled()
  expect(settleNativeExecution).toHaveBeenCalledWith(execution.id)
  expect(execution.result?.error?.code).toBe(error instanceof DomainError ? error.code : 'EXECUTION_START_INTERRUPTED')
})
