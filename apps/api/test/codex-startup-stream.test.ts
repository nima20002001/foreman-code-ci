import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { NativeHarnessEvent } from '@foreman-code/contracts'
import type { ActivityTextOperation } from '@foreman-code/contracts/activity-text'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'

import { createNativeTextStream } from '../src/modules/conversations/nativeTextStream.js'
import { completedNativeAssistantMessage } from '../src/modules/conversations/operatorText.js'
import { normalizeCodexNotification } from '../src/modules/harnesses/codexNormalization.js'
import { NativeDeliveryError } from '../src/modules/harnesses/errors.js'
import { isObject, type JsonObject } from '../src/modules/harnesses/codexStdioTransport.js'
import {
  agentMessage, calls, collect, emit, fixture, fixtureQualification, input, state, until, type Fixture,
} from './fixtures/codex-test-helpers.js'

// Qualification is isolated; startup, admission, normalization and stdio use the real implementation.
vi.doMock('../src/modules/harnesses/codexProtocol.js', async () => {
  const actual = await vi.importActual<typeof import('../src/modules/harnesses/codexProtocol.js')>(
    '../src/modules/harnesses/codexProtocol.js',
  )
  return { ...actual, qualifyCodex: fixtureQualification, assertCodexUnchanged: async () => undefined }
})
const { CodexAppServerSessionManager } = await import('../src/modules/harnesses/codexAppServer.js')

function textTimeline(events: readonly NativeHarnessEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type === 'item.started' || event.type === 'item.completed') {
      const item = event.payload.item
      return isObject(item) ? [`${event.type}:${String(item.id)}`] : []
    }
    if (event.type === 'native.notification' && event.payload.nativeMethod === 'item/agentMessage/delta') {
      return [`delta:${String(event.payload.itemId)}:${String(event.payload.delta)}`]
    }
    return []
  })
}

describe.skipIf(process.platform === 'win32')('Codex assistant text across startup admission', () => {
  let f: Fixture
  let manager: InstanceType<typeof CodexAppServerSessionManager>
  let releaseAdmission: (() => void) | undefined

  beforeEach(async () => {
    f = await fixture()
    manager = new CodexAppServerSessionManager(f.binary)
    await writeFile(join(f.directory, 'hold-turn-start-ack'), '')
  })
  afterEach(async () => {
    releaseAdmission?.()
    releaseAdmission = undefined
    await manager.shutdown()
    await rm(f.directory, { recursive: true, force: true })
  })

  it('buffers turn-scoped command output through acknowledgement and durable admission', async () => {
    const session = await manager.createSession(input(f.directory))
    let entered = false
    const admission = new Promise<void>(resolve => { releaseAdmission = resolve })
    const result = collect(manager.startTurn(session, {
      prompt: 'wait', clientCorrelationId: 'command-progress',
      onSubmitted: async () => { entered = true; await admission },
    }))
    const nativeTurn = await until(async () => {
      if (!(await calls(f.directory)).some(entry => isObject(entry.wire) && entry.wire.method === 'turn/start')) return false
      return (await state(f.directory, session.nativeSessionId)).turns[0]
    })
    const progress = (threadId: string, turnId: string, delta: string) => ({
      method: 'item/commandExecution/outputDelta', params: { threadId, turnId, itemId: 'command', delta },
    })
    await emit(f.directory, progress(session.nativeSessionId, String(nativeTurn.id), 'before-response'))
    await emit(f.directory, progress('foreign-thread', String(nativeTurn.id), 'foreign'))
    await emit(f.directory, progress(session.nativeSessionId, 'wrong-turn', 'wrong'))
    const request = (await calls(f.directory)).find(entry => isObject(entry.wire) && entry.wire.method === 'turn/start')!
    assert(isObject(request.wire))
    await emit(f.directory, { id: request.wire.id, result: { turn: nativeTurn } })
    await until(async () => entered)
    await emit(f.directory, progress(session.nativeSessionId, String(nativeTurn.id), 'during-persistence'))
    await emit(f.directory, { method: 'item/started', params: { threadId: session.nativeSessionId,
      turnId: nativeTurn.id, startedAtMs: 1, item: agentMessage('barrier', '') } })
    await emit(f.directory, { method: 'turn/completed', params: { threadId: session.nativeSessionId,
      turn: { ...nativeTurn, status: 'completed', completedAt: 2 } } })
    await emit(f.directory, { method: 'thread/name/updated', params: {
      threadId: session.nativeSessionId, threadName: 'admission-barrier',
    } })
    await until(async () => (await manager.history(session)).events.some(event => event.payload.threadName === 'admission-barrier'))
    assert.equal((await manager.history(session)).events.some(event => event.payload.nativeMethod === 'item/commandExecution/outputDelta'), false)
    releaseAdmission!()
    const events = await result
    assert.deepEqual(events.filter(event => event.payload.nativeMethod === 'item/commandExecution/outputDelta')
      .map(event => event.payload.delta), ['before-response', 'during-persistence'])
    const history = await manager.history(session)
    assert.deepEqual(history.events.filter(event => event.payload.nativeMethod === 'item/commandExecution/outputDelta')
      .map(event => event.payload.delta), ['before-response', 'during-persistence'])
    await emit(f.directory, progress(session.nativeSessionId, String(nativeTurn.id), 'after-terminal'))
    await emit(f.directory, { method: 'thread/name/updated', params: {
      threadId: session.nativeSessionId, threadName: 'terminal-barrier',
    } })
    await until(async () => (await manager.history(session)).events.some(event => event.payload.threadName === 'terminal-barrier'))
    assert.deepEqual((await manager.history(session)).events.filter(event => event.payload.nativeMethod === 'item/commandExecution/outputDelta')
      .map(event => event.payload.delta), ['before-response', 'during-persistence'])
  })

  it('retains startup text after persistence fails and recovers admission without resending', async () => {
    const session = await manager.createSession(input(f.directory))
    let submissions = 0
    const result = collect(manager.startTurn(session, {
      prompt: 'wait', clientCorrelationId: 'persistence-retry',
      onSubmitted: async () => {
        submissions++
        if (submissions === 1) throw new Error('The identity write failed.')
      },
    }))
    void result.catch(() => undefined)
    const nativeTurn = await until(async () => {
      if (!(await calls(f.directory)).some((entry) => isObject(entry.wire) && entry.wire.method === 'turn/start')) return false
      return (await state(f.directory, session.nativeSessionId)).turns[0]
    })
    const params = { threadId: session.nativeSessionId, turnId: nativeTurn.id }
    await emit(f.directory, { method: 'item/started', params: {
      ...params, startedAtMs: 1, item: agentMessage('answer', ''),
    } })
    await emit(f.directory, { method: 'item/agentMessage/delta', params: {
      ...params, itemId: 'answer', delta: 'Retained text',
    } })
    const request = (await calls(f.directory)).find((entry) =>
      isObject(entry.wire) && entry.wire.method === 'turn/start')!
    assert(isObject(request.wire))
    await emit(f.directory, { id: request.wire.id, result: { turn: nativeTurn } })
    await assert.rejects(result, (error: unknown) => error instanceof NativeDeliveryError
      && error.operation === 'turn_submission' && error.delivery === 'unknown')
    assert.deepEqual(textTimeline((await manager.history(session)).events), [])
    const history = await manager.reconcile(session, 'persistence-retry')
    assert.equal(submissions, 2)
    assert.deepEqual(textTimeline(history.events), ['item.started:answer', 'delta:answer:Retained text'])
    await manager.reconcile(session, 'persistence-retry')
    assert.equal(submissions, 2)
    assert.equal((await calls(f.directory)).filter((entry) =>
      isObject(entry.wire) && entry.wire.method === 'turn/start').length, 1)
  })

  for (const timing of ['before acknowledgement', 'during persistence'] as const) {
    it(`drains interleaved assistant items and deltas ${timing} into live text and completed messages`, async () => {
      const session = await manager.createSession(input(f.directory))
      const published: ActivityTextOperation[] = []
      const streamed: NativeHarnessEvent[] = []
      let entered = false
      let admitted = false
      const admission = new Promise<void>((resolve) => { releaseAdmission = resolve })
      const textStream = createNativeTextStream({
        harness: 'codex',
        owner: () => ({
          scope: {
            kind: 'agent_chat', workspaceId: 'workspace-1', workflowId: 'workflow-1',
            nodeId: 'node-1', agentId: 'agent-a',
            conversationId: 'startup-chat', requestId: 'startup-request',
          },
          requestId: 'startup-request', sessionId: session.nativeSessionId,
        }),
        publish: (operation) => published.push(operation),
        reconcile: () => assert.fail('Known assistant items must not need text recovery.'),
      })
      const result = (async () => {
        for await (const event of manager.startTurn(session, {
          prompt: 'wait', clientCorrelationId: 'startup-correlation',
          onSubmitted: async () => {
            entered = true
            await admission
            admitted = true
          },
        })) {
          assert.equal(admitted, true)
          textStream.before(event)
          streamed.push(event)
          textStream.push(event)
        }
        textStream.flush()
      })()
      void result.catch(() => undefined)
      try {
        const nativeTurn = await until(async () => {
          const requests = await calls(f.directory)
          if (!requests.some((entry) => isObject(entry.wire) && entry.wire.method === 'turn/start')) return false
          return (await state(f.directory, session.nativeSessionId)).turns[0]
        })
        const turnId = String(nativeTurn.id)
        assert(Array.isArray(nativeTurn.items))
        const commentary = agentMessage('commentary-item', 'Plan ready', 'commentary')
        const answer = agentMessage('answer-item', 'Hello world')
        const notification = (method: string, params: JsonObject) => ({
          method, params: { threadId: session.nativeSessionId, turnId, ...params },
        })
        const frames = [
          notification('item/started', { item: { ...commentary, text: '' }, startedAtMs: 1 }),
          notification('item/agentMessage/delta', { itemId: commentary.id, delta: 'Plan ' }),
          notification('item/started', { item: { ...answer, text: '' }, startedAtMs: 2 }),
          notification('item/agentMessage/delta', { itemId: answer.id, delta: 'Hello ' }),
          notification('item/agentMessage/delta', { itemId: commentary.id, delta: 'ready' }),
          notification('item/completed', { item: commentary, completedAtMs: 3 }),
          notification('item/agentMessage/delta', { itemId: answer.id, delta: 'world' }),
          notification('item/completed', { item: answer, completedAtMs: 4 }),
          { method: 'turn/completed', params: { threadId: session.nativeSessionId, turn: {
            ...nativeTurn, status: 'completed', completedAt: 4, items: [...nativeTurn.items, commentary, answer],
          } } },
        ]
        const ack = async () => {
          const request = (await calls(f.directory)).find((entry) =>
            isObject(entry.wire) && entry.wire.method === 'turn/start')!
          assert(isObject(request.wire))
          await emit(f.directory, { id: request.wire.id, result: { turn: nativeTurn } })
          await until(async () => entered)
        }
        await emit(f.directory, frames[0])
        if (timing === 'during persistence') await ack()
        for (const frame of frames.slice(1)) await emit(f.directory, frame)
        await emit(f.directory, notification('item/agentMessage/delta', {
          turnId: 'previous-turn', itemId: 'stale-item', delta: 'stale text',
        }))
        const observeArrival = async (marker: string) => {
          await emit(f.directory, notification('item/agentMessage/delta', {
            threadId: 'child-thread', itemId: marker, delta: 'child text',
          }))
          await until(async () => (await manager.history(session)).events.some((event) =>
            event.type === 'native.unlinked_notification' && event.payload.itemId === marker))
        }
        await observeArrival('startup-arrived')
        assert.equal(entered, timing === 'during persistence')
        assert.deepEqual(textTimeline((await manager.history(session)).events), [])
        assert.equal(streamed.length, 0)
        assert.equal(published.length, 0)
        if (timing === 'before acknowledgement') await ack()
        releaseAdmission!()
        await result

        const expected = [
          'item.started:commentary-item', 'delta:commentary-item:Plan ', 'item.started:answer-item',
          'delta:answer-item:Hello ', 'delta:commentary-item:ready', 'item.completed:commentary-item',
          'delta:answer-item:world', 'item.completed:answer-item',
        ]
        assert.deepEqual(textTimeline(streamed), expected)
        const history = await manager.history(session)
        assert.deepEqual(textTimeline(history.events), expected)
        assert.deepEqual(history.terminalResult, { outcome: 'succeeded', output: { text: 'Hello world' } })
        const transcript = history.events.flatMap((event) => {
          const message = completedNativeAssistantMessage(event, 'codex')
          return message ? [message] : []
        })
        assert.deepEqual(transcript, [
          { id: commentary.id, text: commentary.text }, { id: answer.id, text: answer.text },
        ])
        for (const item of [commentary, answer]) {
          assert.equal(published.filter((operation) => operation.identity.itemId === item.id
            && operation.mode === 'append').map((operation) => operation.text).join(''), item.text)
        }
        assert.deepEqual(published.filter((operation) => operation.final).map((operation) => operation.text),
          [commentary.text, answer.text])
        assert(published.every((operation) => [commentary.id, answer.id].includes(operation.identity.itemId)))

        await emit(f.directory, notification('item/agentMessage/delta', { itemId: answer.id, delta: 'late text' }))
        await observeArrival('terminal-arrived')
        const afterTerminal = await manager.history(session)
        assert.deepEqual(textTimeline(afterTerminal.events), expected)
        assert.deepEqual(afterTerminal.terminalResult, history.terminalResult)
        assert.equal((await calls(f.directory)).filter((entry) =>
          isObject(entry.wire) && entry.wire.method === 'turn/start').length, 1)
      } finally {
        releaseAdmission?.()
        textStream.dispose()
      }
    })
  }
})

describe('Codex assistant delta ownership', () => {
  const owner = { threadId: 'root', turnId: 'turn', runtimeGeneration: 3, terminal: false }
  const envelope = {
    providerVersion: 'codex-cli 0.154.0', schemaIdentity: 'qualified-schema', connectionId: 'connection',
    runtimeGeneration: 3, arrivalOrdinal: 1, method: 'item/agentMessage/delta',
    params: { threadId: 'root', turnId: 'turn', itemId: 'answer', delta: 'text' },
  }

  it('requires an acknowledged turn and the qualified thread identity', () => {
    const startingOwner = { threadId: owner.threadId, runtimeGeneration: owner.runtimeGeneration, terminal: false }
    assert.equal(normalizeCodexNotification(startingOwner, envelope).kind, 'ignored')
    assert.deepEqual(normalizeCodexNotification(owner, { ...envelope,
      params: { turnId: 'turn', itemId: 'answer', delta: 'text' },
    }), { kind: 'ignored', reason: 'missing_thread' })
    assert.equal(normalizeCodexNotification(owner, envelope).kind, 'delta')
  })

  it.each(['item/agentMessage/delta', 'item/commandExecution/outputDelta'])(
    'keeps stale generations, other turns, child threads and terminal progress fenced for %s', method => {
      const progressEnvelope = { ...envelope, method }
      assert.deepEqual(normalizeCodexNotification(owner, { ...progressEnvelope, runtimeGeneration: 2 }),
        { kind: 'ignored', reason: 'stale_generation' })
      assert.deepEqual(normalizeCodexNotification(owner, { ...progressEnvelope,
        params: { ...envelope.params, turnId: 'other-turn' },
      }), { kind: 'ignored', reason: 'inactive_turn' })
      assert.equal(normalizeCodexNotification(owner, { ...progressEnvelope,
        params: { ...envelope.params, threadId: 'child' },
      }).kind, 'unlinked')
      assert.deepEqual(normalizeCodexNotification({ ...owner, terminal: true }, progressEnvelope),
        { kind: 'ignored', reason: 'inactive_turn' })
  })
})
