import { afterEach, expect, it, vi } from 'vitest'
import { assertIntervalRestart } from './helpers/workflowIntervalRestart.js'
import type { remoteReviewProduction } from './helpers/remoteReviewProduction.js'

type Fixture = Awaited<ReturnType<typeof remoteReviewProduction>>
const setup = vi.hoisted(() => ({ fixture: undefined as Fixture | undefined }))

vi.mock('./helpers/remoteReviewProduction.js', () => ({
  remoteReviewProduction: async () => setup.fixture,
}))
vi.mock('./helpers/harnessInstallationUpdate.js', () => ({
  startWhenReady: async () => ({ run: { id: 'interval-run', workspaceId: 'workspace', workflowId: 'workflow' } }),
}))

afterEach(() => {
  setup.fixture = undefined
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it.each(['main', 'worker'] as const)(
  'reconciles pending native settlement before restarting interval work on %s', async executionHost => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const restartReached = new Error('Restart barrier reached')
    let reconciled = false
    const executions = [
      { id: 'entry', state: 'completed', input: {} },
      { id: 'graph-work', state: 'running', input: {}, nativeSessionId: 'graph-session', attempt: 1 },
      { id: 'interval-check', state: 'running', input: { tick: { index: 1, everySeconds: 10 } },
        nativeSessionId: 'check-session', attempt: 1 },
    ]
    const reconcile = vi.fn(async () => { reconciled = true })
    const close = vi.fn(async () => undefined)
    const release = vi.fn(async () => undefined)
    const restartMain = vi.fn(async () => { throw restartReached })
    setup.fixture = {
      provider: {
        blockWorkflowTurns: async () => undefined,
        releaseWorkflowTurns: release,
        calls: async () => executions.filter(execution => execution.nativeSessionId).flatMap(execution => [
          { method: 'turn/start', correlationId: `execution:${execution.id}`, pid: process.pid,
            threadId: execution.nativeSessionId },
          { workflowTurn: { pid: process.pid, sessionId: execution.nativeSessionId, turnId: `${execution.id}-turn` } },
        ]),
      },
      // A yielded settlement needs the maintenance pass supplied by the real server's timer.
      details: async () => ({
        executions: reconciled ? executions : [executions[0]],
        activity: reconciled ? executions.filter(execution => execution.nativeSessionId).map(execution => ({
          harnessExecutionId: execution.id, payload: { nativeEventType: 'turn.started' },
        })) : [],
      }),
      reconcile,
      access: { issue: async () => ({ token: 'reader-token' }) },
      workerPid: () => undefined,
      restartMain,
      failures: () => [],
      close,
    } as unknown as Fixture

    const result = assertIntervalRestart(executionHost).then(
      () => ({ error: undefined }), error => ({ error: error as unknown }),
    )
    await vi.advanceTimersByTimeAsync(180_000)
    expect(await result).toEqual({ error: restartReached })
    expect(reconcile).toHaveBeenCalled()
    expect(restartMain).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  },
)
