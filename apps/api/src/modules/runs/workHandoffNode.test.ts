import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { expect, it, vi } from 'vitest'
import { DomainError } from '../errors.js'
import { ExecutionLimiter } from './limiter.js'
import { workHandoffNodeAction } from './workHandoffNode.js'

it('identifies the node whose profile failed before a native session was started', async () => {
  const fixture = makeCurrentWorkflowFixture('handoff-profile-failure')
  const { executionId, ...identity } = fixture.identities[0]!
  const execution = HarnessExecutionSchema.parse({ ...identity, id: executionId,
    runId: fixture.run.id, input: {}, state: 'queued', createdAt: fixture.createdAt })
  const failure = new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'The native profile check failed.', 409)
  const store = {
    admitWorkActivation: async () => ({ execution, reused: false }),
    acceptWorkTerminal: vi.fn(),
    admitWorkRequest: vi.fn(),
    returnWork: vi.fn(),
    recordWorkUnresolved: vi.fn(),
    resolveWaitingWorkJoins: vi.fn(),
  }
  const driver = { candidate: () => execution, observe: async () => { throw failure } }
  const action = workHandoffNodeAction({ version: fixture.version, store, driver,
    limiter: new ExecutionLimiter(1, 4), signal: new AbortController().signal })

  await expect(action('activation-profile-failure')).rejects.toMatchObject({
    code: 'WORK_SELECTED_EXECUTION_FAILED', pendingExecutionId: execution.id, cause: failure,
    result: { outcome: 'failed', error: {
      code: failure.code, message: failure.message, retryable: false,
    } },
  })
  expect(store.acceptWorkTerminal).not.toHaveBeenCalled()
})
