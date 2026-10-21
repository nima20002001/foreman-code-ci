import { deferred } from './deferred.js'
import { afterEach, expect, it, vi } from 'vitest'
import { SavedRunDetailsSchema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { waitForHandoffCompletion } from './handoffCompletion.js'

afterEach(() => vi.useRealTimers())

function runDetails() {
  const { run, createdAt, identities } = makeCurrentWorkflowFixture('handoff-completion')
  const { executionId, ...identity } = identities[0]!
  const running = SavedRunDetailsSchema.parse({
    run: { ...run, executionState: 'running', startedAt: createdAt },
    executions: [{ ...identity, id: executionId, runId: run.id, input: {},
      state: 'running', createdAt, startedAt: createdAt }],
    activity: [],
  })
  const completed = SavedRunDetailsSchema.parse({ ...running,
    run: { ...running.run, executionState: 'completed', outcome: 'succeeded',
      finishedAt: createdAt, result: { outcome: 'succeeded', output: {} } },
    executions: running.executions.map(execution => ({ ...execution, state: 'completed',
      finishedAt: createdAt, result: { outcome: 'succeeded', output: {} } })),
  })
  return { running, completed }
}

it('reads full MCP details once, after the engine finishes, without polling during execution', async () => {
  vi.useFakeTimers()
  const { running, completed } = runDetails()
  const terminal = deferred<void>()
  let current = running
  const fixture = { finished: terminal.promise, details: vi.fn(async () => current) }
  const waiting = waitForHandoffCompletion(fixture, 'handed-off Agents')
  await vi.advanceTimersByTimeAsync(100)
  const readsWhileRunning = fixture.details.mock.calls.length
  current = completed
  terminal.resolve()
  await vi.advanceTimersByTimeAsync(25)

  await expect(waiting).resolves.toEqual(completed)
  expect(readsWhileRunning).toBe(0)
  expect(fixture.details).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('observes completion published before the wait starts and returns all MCP details', async () => {
  const { completed } = runDetails()
  const fixture = { finished: Promise.resolve(), details: vi.fn(async () => completed) }

  await expect(waitForHandoffCompletion(fixture, 'handed-off Agents')).resolves.toEqual(completed)
  expect(fixture.details).toHaveBeenCalledTimes(1)
})

it('rejects a terminal notification when MCP still reports a nonterminal Run', async () => {
  vi.useFakeTimers()
  const { running } = runDetails()
  const fixture = { finished: Promise.resolve(), details: vi.fn(async () => running) }
  const outcome = waitForHandoffCompletion(fixture, 'handed-off Agents').catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(30_000)

  expect(await outcome).toMatchObject({ message: 'The engine finished with a nonterminal MCP Run: running.' })
  expect(fixture.details).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps the completion deadline and reports the Run and unfinished Agent states', async () => {
  vi.useFakeTimers()
  const { running } = runDetails()
  const terminal = deferred<void>()
  const fixture = { finished: terminal.promise, details: vi.fn(async () => running) }
  const waiting = waitForHandoffCompletion(fixture, 'handed-off Agents')
  const outcome = waiting.catch((error: unknown) => error)
  let settled = false
  void waiting.then(() => { settled = true }, () => { settled = true })
  await vi.advanceTimersByTimeAsync(29_999)
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(await outcome).toMatchObject({ message:
    `Timed out waiting for handed-off Agents. Run: running. Agents: ${running.executions[0]!.workflowNodeId}=running.`,
  })
  expect(fixture.details).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})
