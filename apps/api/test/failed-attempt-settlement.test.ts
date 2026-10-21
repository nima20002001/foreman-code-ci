import { expect, it, vi } from 'vitest'
import { HarnessExecutionSchema, type ExecutionResult } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { DomainError } from '../src/modules/errors.js'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'

function fixture(failure?: ExecutionResult) {
  const base = makeCurrentWorkflowFixture('failed-attempt-settlement', 'single')
  const configuration = base.configurations[0]!
  let execution = HarnessExecutionSchema.parse({
    id: 'failed-execution', runId: base.run.id, workflowNodeId: base.version.entryNodeId,
    agentId: configuration.agentId, agentConfigurationVersionId: configuration.id,
    input: {}, state: 'running', attempt: 1, nativeSessionId: 'failed-session',
    workingDirectory: '/project', runtimeDirectory: '/runtime/failed-execution',
    createdAt: base.createdAt, startedAt: base.createdAt,
  })
  const stopped = new DomainError('EXECUTION_STOPPED', 'The attempt budget is stopped.', 409)
  const budgets = { ensure: vi.fn(async () => {}), resume: vi.fn(async () => { throw stopped }) }
  const resolve = vi.fn(() => { throw new Error('A failed attempt must not allocate another native manager') })
  const query = vi.fn(async () => ({ rows: [{ failure_result: failure ?? null }] }))
  const owner = { runId: base.run.id, assertOwned() {}, oneShotConnection: () => ({ query }) } as unknown as RunOwnership
  const coordinator = new ApprovalExecutionCoordinator({ repeat: async () => ({ claimWorkflowInput: async () => undefined }) } as never, { coordination: {} } as never,
    budgets as never, { resolve }, 60_000)
  const abandon = vi.spyOn(coordinator, 'abandonAttempt').mockImplementation(async (_owner, _execution, result) => {
    execution = HarnessExecutionSchema.parse({ ...execution, state: 'completed', result, finishedAt: base.createdAt })
  })
  const settleNativeExecution = vi.fn(async () => {})
  const store = { readExecution: async () => ({ execution }), assertExecutionAdmission: async () => {},
    settleNativeExecution }
  const observe = () => coordinator.observeExact({ execution, owner, workflowId: base.run.workflowId,
    graphThreadId: base.run.id, signal: new AbortController().signal, store: store as never,
    request: { executionId: execution.id, runId: execution.runId, workspaceId: base.run.workspaceId,
      workflowNodeId: execution.workflowNodeId, workingDirectory: '/project', runtimeDirectory: '/runtime/failed-execution',
      configuration, input: execution.input }, approval: base.run.approval })
  return { observe, abandon, settleNativeExecution, resolve, owner, stopped, execution }
}

it('finishes an abandoned attempt after settlement was interrupted without resuming its budget or native work', async () => {
  const failure: ExecutionResult = { outcome: 'failed', error: { code: 'CODEX_APP_SERVER_DISCONNECTED',
    message: 'The original native connection was lost.', retryable: true } }
  const f = fixture(failure)
  await expect(f.observe()).resolves.toMatchObject({ state: 'completed', result: failure })
  expect(f.abandon).toHaveBeenCalledExactlyOnceWith(f.owner, f.execution, failure)
  expect(f.settleNativeExecution).toHaveBeenCalledExactlyOnceWith(f.execution.id)
  expect(f.resolve).not.toHaveBeenCalled()
})

it.each([undefined, { outcome: 'failed', error: { code: 'EXECUTION_ACTIVE_TIMEOUT',
  message: 'The attempt exhausted its active time.', retryable: false } } as ExecutionResult])(
  'preserves stopped budget errors without a recorded retryable failure (%j)', async failure => {
    const f = fixture(failure)
    await expect(f.observe()).rejects.toMatchObject({ code: f.stopped.code })
    expect(f.abandon).not.toHaveBeenCalled()
    expect(f.settleNativeExecution).not.toHaveBeenCalled()
    expect(f.resolve).not.toHaveBeenCalled()
  },
)
