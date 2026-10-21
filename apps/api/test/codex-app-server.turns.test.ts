import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it, vi } from 'vitest'
import { DomainError } from '../src/modules/errors.js'
import { NativeDeliveryError } from '../src/modules/harnesses/errors.js'
import { assertOriginalWorkflowTerminal } from '../src/modules/interactions/workflowTerminalSource.js'
import { CodexStdioTransport, type JsonObject } from '../src/modules/harnesses/codexStdioTransport.js'
import {
  calls,
  collect,
  emit,
  finish,
  processesForRequests,
  state,
  until,
} from './fixtures/codex-test-helpers.js'
import {
  CodexAppServerSessionManager,
  managers,
  f,
  manager,
  source,
  makeManager,
  flag,
  unflag,
  json,
  wire,
  start,
  pending,
  respond,
  assertCode,
  assertDead,
  assertMetadataProcessesClosed,
  useCodexFixture,
  setManager,
} from './codex-app-server.test-support.js'

// Fixture I/O uses wall time while transport deadlines stay frozen.
const scheduleFixturePoll = setTimeout

describe.skipIf(process.platform === 'win32')('Codex app-server regressions against the real manager', () => {
  useCodexFixture()

  it('F03: rejected second start restores the previous completed result and permits another turn', async () => {
    const session = await manager.createSession(source)
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'first' }))
    const previous = (await manager.history(session)).terminalResult
    const reconciled = await manager.reconcile(session, 'first')
    assert.equal(reconciled.terminalTurn?.correlationId, 'first')
    assert.deepEqual(reconciled.terminalTurn?.result, previous)
    assert.equal((await wire('thread/read')).length, 0)
    assert.equal((await wire('thread/turns/list')).length, 0)
    await assertCode(collect(manager.startTurn(session, { prompt: 'reject', clientCorrelationId: 'rejected' })), 'CODEX_APP_SERVER_REQUEST_FAILED')
    assert.deepEqual((await manager.history(session)).terminalResult, previous)
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'third' }))
    assert.equal((await wire('turn/start')).length, 3)
    assert.equal((await manager.history(session)).terminalResult?.outcome, 'succeeded')
  })

  it('resumes the saved thread after its provider exits during reconciliation without replaying its turn', async () => {
    const { CodexStdioTransport } = await import('../src/modules/harnesses/codexStdioTransport.js')
    let closureConfirmed = false
    let notify!: ConstructorParameters<typeof CodexStdioTransport>[5]
    const retained = new CodexAppServerSessionManager(f.binary, undefined, undefined, undefined, 'scoped', undefined, {
      mode: 'native',
      transport: (...args) => {
        notify = args[5]
        return new class extends CodexStdioTransport {
          override reattached(): boolean { return true }
          override originalProcessClosed(): boolean { return closureConfirmed }
        }(...args)
      },
    })
    managers.push(retained)
    setManager(retained)
    const session = await manager.createSession(source)
    const { result } = await start(session, 'wait', 'original-correlation')
    notify('transport/observerUnavailable', {})
    await assertCode(result, 'CODEX_OBSERVER_UNAVAILABLE')
    const saved = await state(f.directory, session.nativeSessionId)
    const turn = saved.turns.at(-1)!
    turn.status = 'completed'
    turn.completedAt = 2
    assert(Array.isArray(turn.items))
    turn.items.push({ type: 'agentMessage', id: 'saved-answer', text: 'Recovered completion',
      phase: 'final_answer', memoryCitation: null, delivery: null, questions: null })
    await json(`state-${session.nativeSessionId}.json`, saved)
    await flag('disconnect-turn-history')
    await assertCode(manager.reconcile(session, 'original-correlation'), 'CODEX_OBSERVER_UNAVAILABLE')
    assert.equal((await wire('thread/resume')).length, 0)
    closureConfirmed = true
    const recovered = await manager.reconcile(session, 'original-correlation')
    assert.equal(recovered.nativeTurnId, turn.id)
    assert.equal(recovered.terminalTurn?.result.outcome, 'succeeded')
    assert.deepEqual(recovered.terminalTurn?.result.output, { text: 'Recovered completion' })
    assert.equal((await wire('turn/start')).length, 1)
    const resumed = await wire('thread/resume')
    assert.equal(resumed.length, 1)
    assert.equal((resumed[0]!.params as JsonObject).threadId, session.nativeSessionId)
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'after-recovery' }))
    assert.equal((await manager.history(session)).terminalResult?.outcome, 'succeeded')
    assert.equal((await wire('turn/start')).length, 2)
  })

  it('wakes an acknowledged stream on observer unavailability and retains its pending interaction', async () => {
    const { CodexStdioTransport } = await import('../src/modules/harnesses/codexStdioTransport.js')
    let notify!: ConstructorParameters<typeof CodexStdioTransport>[5]
    const observed = new CodexAppServerSessionManager(f.binary, undefined, undefined, undefined, 'scoped', undefined, {
      mode: 'native', transport: (...args) => {
        notify = args[5]
        return new CodexStdioTransport(...args)
      },
    })
    managers.push(observed)
    setManager(observed)
    const session = await manager.createSession(source)
    const { result } = await start(session, 'approval', 'original-correlation')
    const interaction = await pending(session)
    notify('transport/observerUnavailable', {})
    await assertCode(result, 'CODEX_OBSERVER_UNAVAILABLE')
    assert.equal((await pending(session)).turn.nativeRequestId, interaction.turn.nativeRequestId)
    assert.equal((await manager.history(session)).terminalResult, undefined)
    notify('transport/reconnected', {})
    await respond(session, interaction)
    await until(async () => (await manager.history(session)).terminalResult)
    const recovered = await manager.reconcile(session, 'original-correlation')
    assert.equal(recovered.terminalTurn?.result.outcome, 'succeeded')
    assert.equal((await wire('turn/start')).length, 1)
    assert.equal((await wire('thread/resume')).length, 0)
  })

  for (const previous of [false, true]) it(`F04: cancellation during ${previous ? 'subsequent' : 'first'} startup interrupts only the new turn`, async () => {
    const session = await manager.createSession(source)
    if (previous) await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'old' }))
    const events = collect(manager.startTurn(session, { prompt: 'slow-start', clientCorrelationId: 'new' }))
    await until(async () => (await wire('turn/start')).length === (previous ? 2 : 1))
    assert.equal(await manager.cancel(session), true)
    await events
    const requests = await wire('turn/interrupt')
    assert.equal(requests.length, 1)
    assert.equal((requests[0]!.params as JsonObject).turnId, previous ? 'turn-2' : 'turn-1')
    assert.equal((await manager.history(session)).terminalResult?.outcome, 'canceled')
  })

  it('F04: retries the native startup window before the new turn becomes interruptible', async () => {
    const session = await manager.createSession(source)
    await flag('interrupt-startup-race')
    const events = collect(manager.startTurn(session, { prompt: 'slow-start', clientCorrelationId: 'new' }))
    await until(async () => (await wire('turn/start')).length === 1)
    assert.equal(await manager.cancel(session), true)
    await events
    assert.equal((await wire('turn/interrupt')).length, 2)
    assert.equal((await manager.history(session)).terminalResult?.outcome, 'canceled')
  })

  it('withdraws unsent preparation without interrupting the previous completed turn', async () => {
    const uncredentialed = structuredClone(source)
    delete uncredentialed.environment
    const { CodexStdioTransport } = await import('../src/modules/harnesses/codexStdioTransport.js')
    let preparing!: () => void
    const prepared = new Promise<void>((resolve) => { preparing = resolve })
    const fileManager = new CodexAppServerSessionManager(f.binary, undefined, undefined, undefined, 'none', {
      prepare: async ({ clientCorrelationId, signal }) => {
        if (clientCorrelationId !== 'unsent') return undefined
        preparing()
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
        })
        return undefined
      },
    }, {
      mode: 'native',
      transport: (...args) => {
        const readyId = randomUUID()
        args[2] = { ...args[2], TEST_CODEX_TRANSPORT_READY: readyId }
        return new class extends CodexStdioTransport {
          override async request(
            ...input: Parameters<InstanceType<typeof CodexStdioTransport>['request']>
          ): Promise<unknown> {
            if (input[0] === 'initialize') {
              // Start the RPC deadline after the fixture has installed its input handler.
              await until(async () => (await calls(f.directory)).some(call => call.nativeReady === readyId))
            }
            return super.request(...input)
          }
        }(...args)
      },
    })
    managers.push(fileManager)
    const session = await fileManager.createSession(uncredentialed)
    await collect(fileManager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'previous' }))
    const previous = (await fileManager.history(session)).terminalResult
    const stream = collect(fileManager.startTurn(session, { prompt: 'wait', clientCorrelationId: 'unsent' }))
    const rejected = assert.rejects(stream, (error: unknown) => {
      assert(error instanceof NativeDeliveryError)
      assert.equal(error.operation, 'turn_submission')
      assert.equal(error.delivery, 'not_sent')
      assert.equal(error.cleanup, 'confirmed')
      assert(error.cause instanceof Error)
      assert.equal(error.cause.name, 'AbortError')
      return true
    })
    await prepared
    assert.equal(await fileManager.cancel(session), false)
    await rejected
    assert.equal((await wire('turn/start')).length, 1)
    assert.equal((await wire('turn/interrupt')).length, 0)
    assert.deepEqual((await fileManager.history(session)).terminalResult, previous)
    await collect(fileManager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'after-cancel' }))
    assert.equal((await wire('turn/start')).length, 2)
  })

  it('F05: foreign, old-turn and malformed notifications cannot clear approval or replace the answer', async () => {
    const session = await manager.createSession(source)
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'old' }))
    const { result } = await start(session, 'approval', 'new')
    const interaction = await pending(session)
    const current = (await state(f.directory, session.nativeSessionId)).turns.at(-1)!
    await emit(f.directory, { method: 'turn/completed', params: { threadId: 'foreign', turn: { ...current, status: 'completed' } } })
    await emit(f.directory, { method: 'item/completed', params: {
      threadId: session.nativeSessionId, turnId: 'turn-1', completedAtMs: 2,
      item: { id: 'stale', type: 'agentMessage', phase: 'final_answer', text: 'WRONG' },
    } })
    await emit(f.directory, { method: 'turn/completed', params: { threadId: session.nativeSessionId, turn: { status: 'bad' } } })
    await until(async () => (await manager.history(session)).events.some((event) => event.type === 'native.malformed'))
    assert.equal((await manager.pending(session))?.turn.nativeRequestId, interaction.turn.nativeRequestId)
    assert.equal((await manager.history(session)).terminalResult, undefined)
    await respond(session, interaction)
    await result
    assert.deepEqual((await manager.history(session)).terminalResult?.output, { text: 'approved-agent-a' })
  })

  it('F06: completed native recovery produces a terminal result and permits continuation', async () => {
    const session = await manager.createSession(source)
    await collect(manager.startTurn(session, { prompt: 'crash-completed', clientCorrelationId: 'recover' }))
    const history = await manager.reconcile(session, 'recover')
    assert.deepEqual(history.terminalResult?.output, { text: 'recovered-answer' })
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'after-recovery' }))
    assert.equal((await wire('turn/start')).length, 2)
  })

  it('retains the exact native terminal source when recovering a disconnected workflow turn', async () => {
    const session = await manager.createSession(source)
    const execution = { id: source.request.executionId, agentId: source.request.configuration.agentId }
    const correlationId = `execution:${execution.id}`
    await collect(manager.startTurn(session, { prompt: 'crash-completed', clientCorrelationId: correlationId }))
    const history = await manager.reconcile(session, correlationId)
    assert.equal(history.terminalTurn?.result.outcome, 'succeeded')
    assertOriginalWorkflowTerminal(execution, session, history)
    assert.equal((await wire('turn/start')).length, 1)
  })

  it('recovers a lost start acknowledgement by clientId while retaining the native item and turn identities', async () => {
    const session = await manager.createSession(source)
    const clientCorrelationId = 'application-request-456'
    await assert.rejects(collect(manager.startTurn(session, { prompt: 'lost-start', clientCorrelationId })))
    const native = (await state(f.directory, session.nativeSessionId)).turns[0]!
    const userMessage = (native.items as JsonObject[])[0]!
    assert.equal(userMessage.type, 'userMessage')
    assert.equal(userMessage.clientId, clientCorrelationId)
    assert.notEqual(userMessage.id, clientCorrelationId)
    await assertCode(manager.reconcile(session, 'wrong-correlation'), 'CODEX_CORRELATION_MISMATCH')
    await assertCode(collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'unsafe-retry' })), 'CODEX_TURN_ACTIVE')
    const history = await manager.reconcile(session, clientCorrelationId)
    assert.deepEqual(history.terminalResult?.output, { text: 'recovered-answer' })
    assert.equal(history.nativeTurnId, native.id)
    assert.equal(history.terminalTurn?.providerId, native.id)
    assert.equal(history.terminalTurn?.correlationId, clientCorrelationId)
    assert.equal((await wire('turn/start')).length, 1)
    assert.equal((await wire('thread/start')).length, 1)
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'next' }))
  })

  it('recovers a lost steer acknowledgement by clientId only in its expected turn without replay or retargeting', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session)
    const native = (await state(f.directory, session.nativeSessionId)).turns[0]!
    const expectedTurnId = String(native.id)
    const clientCorrelationId = 'application-steer-456'
    await assertCode(manager.steerTurn(session, {
      prompt: 'lost-steer', clientCorrelationId, expectedTurnId,
    }), 'CODEX_APP_SERVER_TIMEOUT')
    const persisted = (await state(f.directory, session.nativeSessionId)).turns[0]!
    const userMessage = (persisted.items as JsonObject[]).at(-1)!
    assert.equal(userMessage.clientId, clientCorrelationId)
    assert.notEqual(userMessage.id, clientCorrelationId)
    const before = await manager.history(session)
    assert.deepEqual(await manager.reconcileSteers(session, [
      { clientCorrelationId, expectedTurnId: 'another-turn' },
      { clientCorrelationId: String(userMessage.id), expectedTurnId },
      { clientCorrelationId: 'missing-steer', expectedTurnId },
    ]), [])
    assert.deepEqual(await manager.reconcileSteers(session, [{ clientCorrelationId, expectedTurnId }]), [{
      nativeSessionId: session.nativeSessionId, nativeTurnId: expectedTurnId, correlationId: clientCorrelationId,
    }])
    assert.deepEqual(await manager.history(session), before)
    assert.equal((await wire('turn/steer')).length, 1)
    assert.equal((await wire('turn/start')).length, 1)
    assert.equal((await wire('thread/start')).length, 1)
    await finish(f.directory, session.nativeSessionId)
    await result
    assert.deepEqual(await manager.reconcileSteers(session, [{ clientCorrelationId, expectedTurnId }]), [{
      nativeSessionId: session.nativeSessionId, nativeTurnId: expectedTurnId, correlationId: clientCorrelationId,
    }])
  })

  it('keeps a lost start fenced when the native item id matches but clientId does not', async () => {
    const session = await manager.createSession(source)
    const clientCorrelationId = 'application-request-456'
    await assert.rejects(collect(manager.startTurn(session, { prompt: 'lost-start', clientCorrelationId })))
    const persisted = await state(f.directory, session.nativeSessionId)
    const userMessage = (persisted.turns[0]!.items as JsonObject[])[0]!
    userMessage.id = clientCorrelationId
    userMessage.clientId = 'another-request'
    await json(`state-${session.nativeSessionId}.json`, persisted)
    await assertCode(manager.reconcile(session, clientCorrelationId), 'CODEX_RECONCILIATION_UNCERTAIN')
    await assertCode(collect(manager.startTurn(session, {
      prompt: 'complete', clientCorrelationId: 'unsafe-retry',
    })), 'CODEX_TURN_ACTIVE')
    assert.equal((await wire('turn/start')).length, 1)
  })

  it('rejects conflicting start correlations in native history without replay', async () => {
    const session = await manager.createSession(source)
    const clientCorrelationId = 'application-request-456'
    await assert.rejects(collect(manager.startTurn(session, { prompt: 'lost-start', clientCorrelationId })))
    const persisted = await state(f.directory, session.nativeSessionId)
    const duplicate = structuredClone(persisted.turns[0]!)
    duplicate.id = 'another-turn'
    const duplicateUserMessage = (duplicate.items as JsonObject[])[0]!
    duplicateUserMessage.id = 'another-native-item'
    persisted.turns.push(duplicate)
    await json(`state-${session.nativeSessionId}.json`, persisted)
    await assertCode(manager.reconcile(session, clientCorrelationId), 'CODEX_CORRELATION_AMBIGUOUS')
    assert.equal((await wire('turn/start')).length, 1)
  })

  it('rejects conflicting steer correlations across native turns', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session)
    const persisted = await state(f.directory, session.nativeSessionId)
    const native = persisted.turns[0]!
    const clientCorrelationId = 'application-steer-456'
    const userMessage = { type: 'userMessage', id: 'native-steer-item', clientId: clientCorrelationId, content: [] }
    const items = native.items as JsonObject[]
    items.push(userMessage)
    persisted.turns.push({ ...structuredClone(native), id: 'another-turn' })
    await json(`state-${session.nativeSessionId}.json`, persisted)
    await assertCode(manager.reconcileSteers(session, [{
      clientCorrelationId, expectedTurnId: String(native.id),
    }]), 'CODEX_CORRELATION_AMBIGUOUS')
    assert.equal((await wire('turn/steer')).length, 0)
    assert.equal((await wire('turn/start')).length, 1)
    await emit(f.directory, { method: 'turn/completed', params: {
      threadId: session.nativeSessionId, turn: { ...native, status: 'completed' },
    } })
    await result
  })

  it('rejects another thread during steer reconciliation without changing the live owner', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session)
    const persisted = await state(f.directory, session.nativeSessionId)
    const before = await manager.history(session)
    persisted.id = 'another-thread'
    await json(`state-${session.nativeSessionId}.json`, persisted)
    await assertCode(manager.reconcileSteers(session, [{
      clientCorrelationId: 'application-steer-456', expectedTurnId: 'turn-1',
    }]), 'CODEX_SESSION_ID_MISMATCH')
    assert.deepEqual(await manager.history(session), before)
    assert.equal((await wire('thread/turns/list')).length, 0)
    persisted.id = session.nativeSessionId
    await json(`state-${session.nativeSessionId}.json`, persisted)
    await finish(f.directory, session.nativeSessionId)
    await result
  })

  it('keeps the active turn owner when reconciling an older clientId', async () => {
    const session = await manager.createSession(source)
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'older-request' }))
    const { result } = await start(session, 'wait', 'active-request')
    const before = await manager.history(session)
    await assertCode(manager.reconcile(session, 'older-request'), 'CODEX_SESSION_BUSY')
    assert.deepEqual(await manager.history(session), before)
    await finish(f.directory, session.nativeSessionId)
    await result
  })

  it('F07: failed restart cleans the candidate process and retains the original session', async () => {
    const session = await manager.createSession(source)
    await collect(manager.startTurn(session, { prompt: 'crash-completed', clientCorrelationId: 'recover' }))
    await flag('fail-resume')
    await assertCode(manager.reconcile(session, 'recover'), 'CODEX_APP_SERVER_REQUEST_FAILED')
    const pids = (await processesForRequests(f.directory, 'thread/start', 'thread/resume'))
      .flatMap(entry => typeof entry.pid === 'number' ? [entry.pid] : [])
    assert.equal(pids.length, 2)
    await assertDead(pids[1]!)
    await assertMetadataProcessesClosed()
    await unflag('fail-resume')
    assert.equal((await manager.reconcile(session, 'recover')).terminalResult?.outcome, 'succeeded')
  })

  it.each([
    { readiness: 'immediate', delayMs: 0 },
    { readiness: 'slower than the RPC deadline', delayMs: 600 },
    { readiness: 'slower than one second', delayMs: 1_200 },
  ])('keeps a late turn correlated after timeout and cancellation with $readiness MCP readiness', async ({ delayMs }) => {
    setManager(makeManager({
      transport: (...args) => {
        args[7] = 500
        return new CodexStdioTransport(...args)
      },
    }))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const session = await manager.createSession(source)
      await json('mcp-status-delay-ms.json', delayMs)
      await flag('hold-turn-start')
      const events = collect(manager.startTurn(session, { prompt: 'wait', clientCorrelationId: 'late' }))
      await until(async () => (await wire('turn/start')).length === 1, 20_000, scheduleFixturePoll)
      assert.equal((await wire('config/mcpServer/reload')).length, 0)
      await vi.advanceTimersByTimeAsync(500)
      await assertCode(events, 'CODEX_APP_SERVER_TIMEOUT')
      vi.useRealTimers()
      const canceled = manager.cancel(session)
      await flag('release-turn-start')
      assert.equal(await canceled, true)
      await until(async () => (await manager.history(session)).terminalResult?.outcome === 'canceled')
      assert.equal((await wire('turn/start')).length, 1)
      assert.equal((await wire('turn/interrupt')).length, 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('F12: an uncertain thread/start is never duplicated, and its late identity is recoverable', async () => {
    setManager(makeManager({
      transport: (...args) => {
        args[7] = 500
        return new CodexStdioTransport(...args)
      },
    }))
    await flag('hold-thread-start')
    await assertCode(manager.createSession(source), 'CODEX_APP_SERVER_TIMEOUT')
    await assertCode(manager.createSession(source), 'CODEX_SESSION_CREATION_UNCERTAIN')
    await flag('release-thread-start')
    const session = await until(async () => { try { return await manager.reconcileSessionCreation(source) } catch { return undefined } })
    assert.deepEqual(await manager.createSession(source), session)
    assert.equal((await wire('thread/start')).length, 1)
  })

  it('retains an incomplete fixture notification until its remaining bytes arrive', async () => {
    const session = await manager.createSession(source)
    const message = JSON.stringify({ method: 'thread/name/updated',
      params: { threadId: session.nativeSessionId, threadName: 'split-notification' } }) + '\n'
    const midpoint = Math.floor(message.length / 2)
    const inbox = join(f.directory, 'inbox-agent-a.jsonl')
    await appendFile(inbox, message.slice(0, midpoint))
    await until(async () => (await calls(f.directory)).some(entry => entry.inboxBufferedLength === midpoint))
    assert(!(await manager.history(session)).events.some(event => event.type === 'transport.disconnected'))
    await appendFile(inbox, message.slice(midpoint))
    await until(async () => (await manager.history(session)).events
      .some(event => event.payload.threadName === 'split-notification'))
    const history = await manager.history(session)
    assert.equal(history.events.filter(event => event.payload.threadName === 'split-notification').length, 1)
    assert(!history.events.some(event => event.type === 'native.malformed' || event.type === 'transport.disconnected'))
  })

  it('retains large qualified events with bounded history and monotonic cursors', async () => {
    const session = await manager.createSession(source)
    const large = 'x'.repeat(1_100_000)
    await emit(f.directory, { method: 'thread/name/updated',
      params: { threadId: session.nativeSessionId, threadName: large } })
    await until(async () => (await manager.history(session)).events.some((event) => event.payload.threadName === large))
    const batch = Array.from({ length: 1_100 }, (_, value) => JSON.stringify({ method: 'thread/name/updated',
      params: { threadId: session.nativeSessionId, threadName: `thread-name-${value}` } })).join('\n') + '\n'
    await appendFile(join(f.directory, 'inbox-agent-a.jsonl'), batch)
    await until(async () => (await manager.history(session)).events.some((event) => event.payload.threadName === 'thread-name-1099'))
    const history = await manager.history(session)
    assert(history.events.length <= 1024)
    assert((history.firstRetainedSequence ?? 0) > 0)
    assert.equal(history.events.at(-1)!.sequence + 1, history.nextSequence)
  }, 15_000)

  it('F32: simultaneous first starts and conflicting response choices have one writer', async () => {
    const session = await manager.createSession(source)
    const first = collect(manager.startTurn(session, { prompt: 'approval', clientCorrelationId: 'first' }))
    const second = collect(manager.startTurn(session, { prompt: 'wait', clientCorrelationId: 'second' }))
    await assertCode(second, 'CODEX_TURN_ACTIVE')
    const value = await pending(session)
    const yes = manager.respond(session, value.turn.nativeRequestId!, value.responseOptions[0]!)
    const no = manager.respond(session, value.turn.nativeRequestId!, value.responseOptions.at(-1)!)
    await assertCode(no, 'NATIVE_RESPONSE_RECONCILIATION_REQUIRED')
    await yes; await first
    assert.equal((await wire('turn/start')).length, 1)
    assert.equal((await wire()).filter((entry) => entry.id === 901 && entry.result).length, 1)
  })

  it('F32: fresh concurrent attachment is reserved and cannot lose another caller\'s runtime', async () => {
    const session = await manager.createSession(source)
    await manager.close(session)
    await flag('resume-delay')
    setManager(makeManager())
    const first = manager.attachSession(session, source)
    const second = manager.attachSession(session, source)
    await assertCode(second, 'CODEX_SESSION_BUSY')
    assert.deepEqual(await first, session)
    assert.equal((await wire('thread/resume')).length, 1)
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'usable' }))
  })

  it('cancellation during an established turn interrupts the exact native turn', async () => {
    const session = await manager.createSession(source)
    const controller = new AbortController()
    const stream = collect(manager.startTurn(session, { prompt: 'wait', clientCorrelationId: 'ordinary-cancel' }, controller.signal))
    await until(async () => (await manager.history(session)).events.some((event) => event.type === 'turn.started'))
    controller.abort(new Error('ordinary cancellation'))
    await stream.catch(() => { /* ignore: the aborted stream rejects by design; the interrupt request is asserted below. */ })
    const requests = await until(async () => {
      const requests = await wire('turn/interrupt')
      return requests.length === 1 ? requests : false
    })
    assert.equal((requests[0]!.params as JsonObject).turnId, 'turn-1')
  })

  it('detaches engine restart without interrupt and attaches the same thread without resending its prompt', async () => {
    const session = await manager.createSession(source)
    const controller = new AbortController()
    const stream = collect(manager.startTurn(session, { prompt: 'wait', clientCorrelationId: 'restart-turn' }, controller.signal))
    await until(async () => (await manager.history(session)).events.some((event) => event.type === 'turn.started'))
    controller.abort(new DomainError('ENGINE_RESTART', 'Restart the engine', 409))
    await stream.catch((error: unknown) => {
      assert(error instanceof DomainError && error.code === 'ENGINE_RESTART')
    })
    await manager.close(session)
    const replacement = makeManager()
    assert.deepEqual(await replacement.attachSession(session, source), session)
    const recovered = await replacement.reconcile(session, 'restart-turn')
    assert.equal(recovered.nativeTurnId, 'turn-1')
    assert.equal((await wire('thread/start')).length, 1)
    assert.equal((await wire('turn/start')).length, 1)
    assert.equal((await wire('turn/interrupt')).length, 0)
  })

  it('detaches an idle pending iterator without cancelling the native turn', async () => {
    const session = await manager.createSession(source)
    const iterator = manager.startTurn(session, { prompt: 'wait', clientCorrelationId: 'subscriber-close' })[Symbol.asyncIterator]()
    const first = await iterator.next()
    // Drain the start/initial item events so next is waiting for new provider IO.
    const history = await manager.history(session)
    const last = history.events.at(-1)!.sequence
    let current = first.done ? last : first.value.sequence
    while (current < last) {
      const next = await iterator.next()
      assert.equal(next.done, false)
      if (!next.done) current = next.value.sequence
    }
    const pending = iterator.next()
    // Let next() enter its pending read before closing the subscriber.
    await new Promise<void>((resolve) => setImmediate(resolve))
    await iterator.return?.()
    assert.equal((await pending).done, true)
    assert.equal((await wire('turn/interrupt')).length, 0)
    await assertCode(collect(manager.startTurn(session, { prompt: 'duplicate', clientCorrelationId: 'duplicate' })), 'CODEX_TURN_ACTIVE')
    await finish(f.directory, session.nativeSessionId)
    await until(async () => (await manager.history(session)).events.some((event) => event.type === 'turn.completed'))
  })

  it('keeps the stream reservation until the previous iterator drains its terminal events', async () => {
    const session = await manager.createSession(source)
    const iterator = manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'old' })[Symbol.asyncIterator]()
    await iterator.next()
    await until(async () => (await manager.history(session)).terminalResult?.outcome === 'succeeded')
    await assertCode(collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'new' })), 'CODEX_TURN_ACTIVE')
    await iterator.return?.()
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'new' }))
  })

  it('failed initial thread start and resume clean every newly created process', async () => {
    await flag('fail-start')
    await assertCode(manager.createSession(source), 'CODEX_APP_SERVER_REQUEST_FAILED')
    await unflag('fail-start')
    const session = await manager.createSession(source)
    await manager.close(session)
    await flag('fail-resume')
    await assertCode(manager.attachSession(session, source), 'CODEX_APP_SERVER_REQUEST_FAILED')
    for (const entry of await calls(f.directory)) if (typeof entry.pid === 'number') await assertDead(entry.pid)
  })

  it('required-MCP startup failure registers no execution session', async () => {
    await flag('required-mcp-failure')
    await assertCode(manager.createSession(source), 'CODEX_APP_SERVER_REQUEST_FAILED')
    await unflag('required-mcp-failure')
    const session = await manager.createSession(source)
    assert.equal((await manager.history(session)).terminalResult, undefined)
    const content = await readFile(join(f.directory, 'calls.jsonl'), 'utf8')
    assert(!content.includes('token-agent-a'))
  })
})
