import assert from 'node:assert/strict'
import { afterEach, describe, it, vi } from 'vitest'
import { HarnessExecutionError } from '../src/modules/harnesses/errors.js'
import { CodexStdioTransport, isObject } from '../src/modules/harnesses/codexStdioTransport.js'
import { bounded } from './fixtures/pr17-native-runtime.js'
import { agentMessage, calls, collect, emit, fixtureProtocol, input, state, until } from './fixtures/codex-test-helpers.js'
import { deliveryFixture } from './fixtures/codex-delivery.js'
import * as nativeProcesses from '../src/modules/harnesses/process.js'

function nativeCode(code: string) {
  return (error: unknown) => error instanceof HarnessExecutionError && error.result.error?.code === code
}

const codexFixtures: Awaited<ReturnType<typeof deliveryFixture>>[] = []
afterEach(async () => {
  for (const fixture of codexFixtures.splice(0)) await fixture.close()
})

async function codexFixture() {
  const fixture = await deliveryFixture()
  codexFixtures.push(fixture)
  const source = input(fixture.directory)
  delete source.environment
  const manager = fixture.makeManager()
  const session = await manager.createSession(source)
  return { fixture, source, manager, session }
}

describe('native session runtime regressions', () => {
  it('exposes a later approval without replaying an earlier uncertain response', async () => {
    const { fixture, manager, session } = await codexFixture()
    await fixture.flag('no-resolution')
    const completed = collect(manager.startTurn(session, { prompt: 'multi', clientCorrelationId: 'approval-turn' }))
    const first = await until(() => manager.pending(session))
    const option = first.responseOptions[0]!
    const abort = new AbortController()
    const response = manager.respond(session, first.turn.nativeRequestId!, option, abort.signal)
    const rejected = assert.rejects(response, /stop awaiting confirmation/)
    await until(async () => (await manager.history(session)).interactionDeliveries?.[0]?.state === 'submitted')
    await until(async () => (await calls(fixture.directory))
      .filter((entry) => isObject(entry.wire) && 'result' in entry.wire).length === 1)
    abort.abort(new Error('stop awaiting confirmation'))
    await rejected
    const second = await until(() => manager.pending(session))
    assert.notEqual(second.turn.nativeRequestId, first.turn.nativeRequestId)
    const history = await manager.history(session)
    assert.equal(history.pendingInteraction?.turn.nativeRequestId, second.turn.nativeRequestId)
    assert.deepEqual(history.interactionDeliveries?.map((entry) => entry.state), ['uncertain', 'pending'])
    const before = await calls(fixture.directory)
    await assert.rejects(manager.respond(session, first.turn.nativeRequestId!, option),
      nativeCode('NATIVE_RESPONSE_RECONCILIATION_REQUIRED'))
    assert.deepEqual((await manager.history(session)).interactionDeliveries, history.interactionDeliveries)
    assert.deepEqual(await calls(fixture.directory), before)
    await manager.cancel(session)
    await completed
  })

  for (const terminal of [false, true]) it(`drains an event queued while suspended at yield (terminal=${terminal})`, async () => {
    const { fixture, manager, session } = await codexFixture()
    const controller = new AbortController()
    const iterator = manager.startTurn(session, { prompt: 'wait', clientCorrelationId: 'queued-event' },
      controller.signal)[Symbol.asyncIterator]()
    let next: ReturnType<typeof iterator.next> | undefined
    try {
      assert.equal((await iterator.next()).value?.type, 'turn.started')
      const current = await state(fixture.directory, session.nativeSessionId)
      const turn = current.turns.at(-1)!
      const eventType = terminal ? 'turn.completed' : 'item.started'
      await emit(fixture.directory, terminal
        ? { method: 'turn/completed', params: { threadId: session.nativeSessionId,
          turn: { ...turn, status: 'completed', completedAt: 2 } } }
        : { method: 'item/started', params: { threadId: session.nativeSessionId, turnId: turn.id,
          item: agentMessage('queued-message', 'B'), startedAtMs: 1 } })
      await until(async () => (await manager.history(session)).events.some((event) => event.type === eventType))
      next = iterator.next()
      const result = await bounded(next)
      assert.equal(result.done, false)
      assert.equal(result.value?.type, eventType)
      if (terminal) assert.equal((await iterator.next()).done, true)
    } finally {
      controller.abort()
      await next?.catch((error: unknown) => {
        if (error !== controller.signal.reason) throw error
      })
      await iterator.return?.()
    }
  })

  it('retries transport cleanup, coalesces in-flight calls and keeps native requests fenced', async () => {
    const fixture = await deliveryFixture()
    codexFixtures.push(fixture)
    let calls = 0
    let reject!: (error: Error) => void
    const spawn = nativeProcesses.spawnOwnedStdioProcess
    const cleanup = vi.spyOn(nativeProcesses, 'spawnOwnedStdioProcess').mockImplementation(async (options) => {
      const owned = await spawn(options)
      return { ...owned, close: () => {
        calls += 1
        if (calls === 1) return new Promise<void>((_resolve, fail) => { reject = fail })
        return owned.close()
      } }
    })
    const transport = new CodexStdioTransport(fixture.binary, fixture.directory, {}, fixtureProtocol,
      async () => undefined, () => undefined, () => undefined)
    try {
      await transport.start()
      const first = transport.close()
      assert.equal(transport.close(), first)
      const failure = assert.rejects(first, /fixture cleanup failure/)
      reject(new Error('fixture cleanup failure'))
      await failure
      await assert.rejects(transport.request('turn/start', {}), nativeCode('CODEX_APP_SERVER_DISCONNECTED'))
      const second = transport.close()
      assert.notEqual(second, first)
      await second
      assert.equal(calls, 2)
      assert.equal(transport.close(), second)
      await assert.rejects(transport.start(), nativeCode('CODEX_TRANSPORT_REUSED'))
    } finally {
      await transport.close()
      cleanup.mockRestore()
    }
  })

  it('retains a failed login cleanup and prevents reattaching a disposed session', async () => {
    const fixture = await deliveryFixture()
    codexFixtures.push(fixture)
    let calls = 0
    let sessionCleanupFailure = false
    const manager = fixture.makeManager(undefined, { transport: (...args) => {
      const transport = new CodexStdioTransport(...args)
      const close = transport.close.bind(transport)
      transport.close = async () => {
        calls += 1
        if (calls === 1) throw new Error('cleanup failed')
        if (sessionCleanupFailure) {
          sessionCleanupFailure = false
          throw new Error('session cleanup failed')
        }
        await close()
      }
      return transport
    } })
    await manager.startDeviceCodeLogin()
    await assert.rejects(manager.closeLoginControl(), /cleanup failed/)
    await assert.rejects(manager.startDeviceCodeLogin(), nativeCode('CODEX_LOGIN_ACTIVE'))
    await manager.closeLoginControl()
    assert.equal(calls, 2)
    await manager.startDeviceCodeLogin()
    await manager.closeLoginControl()
    const source = input(fixture.directory)
    delete source.environment
    const session = await manager.createSession(source)
    sessionCleanupFailure = true
    await assert.rejects(manager.close(session), /session cleanup failed/)
    await assert.rejects(manager.attachSession(session, source), nativeCode('CODEX_SESSION_UNAVAILABLE'))
    await manager.close(session)
    assert.deepEqual(await manager.attachSession(session, source), session)
    assert.equal((await fixture.wire('thread/start')).length, 1)
  })

})
