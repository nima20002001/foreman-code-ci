import { describe, expect, it } from 'vitest'
import { CodexAppServerSessionManager, f, managers, source, useCodexFixture } from './codex-app-server.test-support.js'
import { collect, emit, finish, state, until, calls } from './fixtures/codex-test-helpers.js'
import { isCodexCapacityError } from '../src/modules/harnesses/codexCapacity.js'
import { SingleWriterSessionManager } from '../src/modules/interactions/sessionWriter.js'
import { nativeLanes } from './helpers/nativeLanes.js'
import type { NativeSessionReference } from '@foreman-code/contracts'

describe('Codex capacity retry', () => {
  useCodexFixture({ requestTimeoutMs: 5_000 })

  function setup() {
    const waits: { milliseconds: number; release(): void }[] = []
    const delays = new Set([20_000, 40_000, 80_000, 160_000])
    const schedule = ((callback: () => void, milliseconds: number) => {
      const timer = setTimeout(callback, milliseconds)
      if (delays.has(milliseconds)) waits.push({ milliseconds, release: () => { clearTimeout(timer); callback() } })
      return timer
    }) as typeof setTimeout
    const manager = new CodexAppServerSessionManager(f.binary, undefined, undefined, undefined, 'scoped', undefined,
      { mode: 'native', schedule })
    managers.push(manager)
    return { manager, waits }
  }

  async function fail(session: NativeSessionReference, attempt: number, codexErrorInfo: unknown = 'serverOverloaded') {
    const current = await until(async () => {
      const value = await state(f.directory, session.nativeSessionId)
      return value.turns.length === attempt && value.turns.at(-1)
    })
    await emit(f.directory, { method: 'turn/completed', params: { threadId: session.nativeSessionId, turn: {
      ...current, status: 'failed', completedAt: 2,
      error: { message: 'Selected model is at capacity. Please try a different model.',
        codexErrorInfo, additionalDetails: null },
    } } })
  }

  it('retries the same input in the same session and advances the owned writer to the successful attempt', async () => {
    const { manager, waits } = setup()
    const coordination = nativeLanes()
    const writer = new SingleWriterSessionManager(manager, coordination, source.request.configuration.agentId)
    const session = await writer.createSession(source)
    const result = collect(writer.startTurn(session, { prompt: 'wait', clientCorrelationId: 'execution:capacity' }))
    await fail(session, 1)
    await until(async () => waits.length === 1)
    expect((await manager.reconcile(session, 'execution:capacity')).terminalTurn).toBeUndefined()
    expect((await manager.history(session)).terminalResult).toBeUndefined()
    waits[0]!.release()
    await until(async () => (await state(f.directory, session.nativeSessionId)).turns.length === 2)
    await finish(f.directory, session.nativeSessionId)
    const events = await result
    expect(events.filter(event => event.type === 'turn.capacity_wait')).toHaveLength(1)
    expect(events.filter(event => event.type === 'turn.completed')).toHaveLength(2)
    expect((await manager.history(session)).terminalResult?.outcome).toBe('succeeded')
    expect(await coordination.getLane('codex', session.nativeSessionId)).toMatchObject({
      currentTurnOrMessageId: 'turn-2', observedStatus: 'idle',
    })
    const wire = (await calls(f.directory)).flatMap(entry => entry.wire ? [entry.wire as Record<string, unknown>] : [])
    expect(wire.filter(entry => entry.method === 'thread/start')).toHaveLength(1)
    const starts = wire.filter(entry => entry.method === 'turn/start')
    expect(starts).toHaveLength(2)
    expect(starts[1]!.params).toEqual(starts[0]!.params)
  })

  it('exhausts local capacity retries and preserves a retryable failure for workflow recovery', async () => {
    const { manager, waits } = setup()
    const session = await manager.createSession(source)
    const result = collect(manager.startTurn(session, { prompt: 'wait', clientCorrelationId: 'capacity' }))
    for (let attempt = 1; attempt <= 5; attempt++) {
      await fail(session, attempt, { httpConnectionFailed: { httpStatusCode: 503 } })
      if (attempt < 5) {
        await until(async () => waits.length === attempt)
        waits[attempt - 1]!.release()
      }
    }
    const events = await result
    expect(waits.map(wait => wait.milliseconds)).toEqual([20_000, 40_000, 80_000, 160_000])
    expect(events.filter(event => event.type === 'turn.capacity_wait')).toHaveLength(4)
    expect((await manager.history(session)).terminalResult).toMatchObject({
      outcome: 'failed', error: { code: 'CODEX_TURN_FAILED', retryable: true },
    })
  })

  it.each(['cancel', 'abort'] as const)('honors %s during capacity backoff without resubmitting', async stop => {
    const { manager, waits } = setup()
    const session = await manager.createSession(source)
    const controller = new AbortController()
    const result = collect(manager.startTurn(session, { prompt: 'wait', clientCorrelationId: 'capacity' }, controller.signal))
    await fail(session, 1)
    await until(async () => waits.length === 1)
    if (stop === 'cancel') expect(await manager.cancel(session)).toBe(true)
    else controller.abort()
    await result
    expect((await state(f.directory, session.nativeSessionId)).turns).toHaveLength(1)
    if (stop === 'cancel') expect((await manager.history(session)).terminalResult?.outcome).toBe('canceled')
  })

  it('fails a structured permanent error immediately even if its text mentions capacity', async () => {
    const { manager, waits } = setup()
    const session = await manager.createSession(source)
    const result = collect(manager.startTurn(session, { prompt: 'wait', clientCorrelationId: 'capacity' }))
    await fail(session, 1, 'unauthorized')
    await result
    expect(waits).toHaveLength(0)
    expect((await manager.history(session)).terminalResult?.error?.code).toBe('CODEX_TURN_FAILED')
  })

  it('preserves a caller-pinned identity when that caller has no retry transition', async () => {
    const { manager, waits } = setup()
    const session = await manager.createSession(source)
    const submitted: string[] = []
    const result = collect(manager.startTurn(session, { prompt: 'wait', clientCorrelationId: 'capacity',
      onSubmitted: async id => { submitted.push(id) },
    }))
    await fail(session, 1)
    await result
    expect(submitted).toEqual(['turn-1'])
    expect(waits).toHaveLength(0)
    expect((await manager.history(session)).terminalResult?.error?.code).toBe('CODEX_TURN_FAILED')
  })

  it.each([
    ['rateLimitExceeded', true], ['serverOverloaded', true], ['usageLimitExceeded', false],
    ['contextWindowExceeded', false], ['unauthorized', false], ['sandboxError', false],
    [{ responseTooManyFailedAttempts: { httpStatusCode: 429 } }, true],
    [{ responseStreamConnectionFailed: { httpStatusCode: 502 } }, true],
    [{ responseStreamDisconnected: { httpStatusCode: 400 } }, false],
  ])('classifies structured error %j without consulting message text', (codexErrorInfo, retryable) => {
    expect(isCodexCapacityError({ codexErrorInfo, message: 'unrelated provider message' })).toBe(retryable)
  })

  it('uses the capacity message only when a structured reason is unavailable', () => {
    expect(isCodexCapacityError({ codexErrorInfo: null, message: 'Selected model is at capacity.' })).toBe(true)
    expect(isCodexCapacityError({ codexErrorInfo: 'unauthorized', message: 'Selected model is at capacity.' })).toBe(false)
  })
})
