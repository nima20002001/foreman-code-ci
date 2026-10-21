import { describe, expect, it, vi } from 'vitest'
import { readCurrentExecutions, postgresEnabled } from './helpers/wave25Agent3.js'
import { lifecycleFixtures } from './helpers/workflowLifecycleFixtures.js'
import { isWorkflowStart } from '../src/modules/harnesses/sessionStart.js'

// Provider transport is deterministic; admission, capture, checkpointing and lifecycle writers remain real.
describe.skipIf(!postgresEnabled)('native workflow lifecycle: provider-failure', () => {
  const fixture = lifecycleFixtures()

  it('fails the Run after a provider exits abnormally and settles the waiting sibling', async () => {
    const f = await fixture()
    const original = f.provider.startTurn.bind(f.provider)
    const history = f.provider.history.bind(f.provider)
    const create = f.provider.createSession.bind(f.provider)
    const failing = f.f.version.definition.nodes[2]!.id
    let failedSession: string | undefined
    let terminal: import('@foreman-code/contracts').NativeHarnessEvent | undefined
    const result = { outcome: 'failed' as const,
      error: { code: 'SYNTHETIC_PROCESS_EXIT', message: 'Task-owned provider exited.', retryable: false } }
    vi.spyOn(f.provider, 'createSession').mockImplementation(async (input) => {
      const session = await create(input)
      if (isWorkflowStart(input) && input.request.workflowNodeId === failing) failedSession = session.nativeSessionId
      return session
    })
    vi.spyOn(f.provider, 'startTurn').mockImplementation(async function* (session, input) {
      for await (const event of original(session, input)) {
        if (session.nativeSessionId === failedSession && event.type === 'turn.started') {
          yield event
          terminal = { ...event, sequence: event.sequence + 1, type: 'turn.completed',
            payload: { ...event.payload, turn: { id: event.payload.turnId, status: 'failed', error: { message: result.error.message } } } }
          yield terminal
          return
        }
        yield event
      }
    })
    vi.spyOn(f.provider, 'history').mockImplementation(async (session) =>
      session.nativeSessionId === failedSession && terminal
        ? { events: [terminal], pendingInteractions: [], responseDeliveries: [], terminalResult: result }
        : history(session))
    await f.engine.start(f.f.run.id).catch(() => undefined)
    expect((await f.runs.get(f.f.run.id))?.outcome).toBe('failed')
    expect(await f.runs.hasPendingCleanup(f.f.run.id)).toBe(false)
    expect(f.provider.counts.starts).toBe(3)
    expect((await readCurrentExecutions(f.runs, f.f.run.id)).every((item) => item.state === 'completed')).toBe(true)
  }, 60000)
})
