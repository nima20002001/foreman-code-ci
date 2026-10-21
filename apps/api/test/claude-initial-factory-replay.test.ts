import { SingleWriterSessionManager } from '../src/modules/interactions/sessionWriter.js'
import { nativeLanes } from './helpers/nativeLanes.js'
import { describe, expect, it, vi } from 'vitest'
import { OperatorConfigurationVersionSchema } from '@foreman-code/contracts'
import { NativeHarnessFactories } from '../src/modules/harnesses/runtimeFactory.js'
import { primeInitialNativeStream } from '../src/modules/harnesses/claudeSdk/initialStream.js'
import { createClaudeSdkRunner } from '../src/modules/harnesses/claudeSdk/runner.js'
import { ClaudeBoundedQueue } from '../src/modules/harnesses/claudeSdk/queue.js'
import { claudePromptUuid } from '../src/modules/harnesses/claudeSdk/sessionManager.js'
import type { ClaudeSdkClient, ClaudeSdkUserMessage } from '../src/modules/harnesses/claudeSdk/port.js'
import type { NativeSessionReference } from '@foreman-code/contracts'
import type { ClaudeLiveCallbackReader } from '../src/modules/harnesses/claudeSdk/callbackAvailability.js'
import { deferred } from './helpers/deferred.js'

/** Synthetic contract replay, never native availability evidence. Actual provider
 * allocator, SDK runner, manager, decoder and first-stream observer are exercised. */
const configuration = OperatorConfigurationVersionSchema.parse({ id: 'version', operatorId: 'operator', version: 1,
  contentHash: 'sha256:synthetic', createdAt: '2026-10-01T00:00:00.000Z', harness: {
    harness: 'claude', model: 'synthetic-model', authMode: 'subscription', configDirectory: '/synthetic-profile',
    permissionMode: 'default', sandbox: 'read-only', tools: [], permissionRules: [], instructions: 'accepted instructions', mcpServers: {},
  } })
const scope = { deviceId: 'synthetic-device', profilePath: '/synthetic-profile', configRevision: 'version', cwd: '/synthetic-work' }
const start = { kind: 'operator' as const, correlationId: 'conversation:request-1', configuration, workingDirectory: scope.cwd }
async function drain<T>(input: AsyncIterable<T>): Promise<T[]> { const out: T[] = []; for await (const value of input) out.push(value); return out }
function fixture(liveCallbacks?: ClaudeLiveCallbackReader, role: 'workflow' | 'operator' | 'agent-chat' = 'operator') {
  const frames = new ClaudeBoundedQueue<unknown>(64)
  const inputReady = deferred<AsyncIterator<ClaudeSdkUserMessage>>()
  const query = vi.fn<ClaudeSdkClient['query']>((input) => {
    inputReady.resolve(input.prompt[Symbol.asyncIterator]())
    return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](), interrupt: async () => undefined,
      initializationResult: async () => ({}), close: () => frames.close() }
  })
  const history = vi.fn<ClaudeSdkClient['getSessionMessages']>(async () => [])
  const fork = vi.fn<ClaudeSdkClient['forkSession']>(async () => ({ sessionId: 'observed-fork' }))
  const client: ClaudeSdkClient = { sdkVersion: '0.3.284', query, getSessionInfo: async (sessionId) => ({ sessionId }),
    getSessionMessages: history, forkSession: fork }
  const runner = createClaudeSdkRunner({ loadClient: async () => client })
  const factories = new NativeHarnessFactories({ codexBinary: '/forbidden-codex',  })
  const allocated = factories.allocate({ harness: 'claude', role, workingDirectory: scope.cwd,
    ownerAgentId: 'operator', appMcpAccess: 'none', runner, scope, sdkOptions: { includePartialMessages: true },
    qualification: { sdkVersion: '0.3.284', cliVersion: '2.1.284', basicTurns: true, resume: true, fork: true, history: true, interactions: true },
    ...(liveCallbacks ? { liveCallbacks } : {}), ownerForStart: () => ({ ownerId: 'conversation', attemptId: 'request-1', generation: 'lease-1' }),
  })
  const init = () => frames.offer({ type: 'system', subtype: 'init', uuid: 'init-event', session_id: 'observed-session', claude_code_version: '2.1.284', cwd: scope.cwd })
  const reply = (uuid: string, text = 'answer') => frames.offer({ type: 'assistant', uuid: `reply-${text}`, session_id: 'observed-session', user_message_uuid: uuid,
    message: { id: `api-${text}`, content: [{ type: 'text', text }] }, parent_tool_use_id: null })
  const result = (uuid: string, failed = false) => frames.offer({ type: 'result', uuid: `result-${uuid}`, session_id: 'observed-session',
    user_message_uuid: uuid, subtype: failed ? 'error_during_execution' : 'success', is_error: failed, result: 'answer' })
  const next = async () => (await (await inputReady.promise).next()).value!
  return { manager: allocated.manager, factories, runner, query, frames, history, fork, init, reply, result, next }
}

describe('Claude actual initial factory replay: ten admitted-boundary cases', () => {
  it('allocates without native query and exposes only actual initial/callback methods', async () => {
    const f = fixture()
    expect(f.query).not.toHaveBeenCalled()
    expect(f.manager.startInitialTurn).toBeTypeOf('function')
    expect(f.manager.waitNativeCallbackContext).toBeTypeOf('function')
    await expect(f.manager.createSession(start)).rejects.toThrow('first input')
    expect(f.query).not.toHaveBeenCalled(); await f.manager.dispose?.()
  })
  it('has no local SID before input; persists observed SID before ACK or text', async () => {
    const f = fixture(), bound = deferred<void>(), sawSid = deferred<NativeSessionReference>(), ack = vi.fn()
    const pending = drain(f.manager.startInitialTurn(start, { prompt: 'first', clientCorrelationId: start.correlationId,
      onSessionObserved: async (session) => { sawSid.resolve(session); await bound.promise }, onMessageSubmitted: ack }))
    const input = await f.next(); expect(ack).not.toHaveBeenCalled()
    void f.init(); const session = await sawSid.promise
    void f.reply(input.uuid); void f.result(input.uuid)
    expect(ack).not.toHaveBeenCalled(); bound.resolve()
    const events = await pending
    expect(session.nativeSessionId).toBe('observed-session')
    expect(ack).toHaveBeenCalledOnce(); expect(events.some((e) => e.type === 'claude.text')).toBe(true)
    await f.manager.dispose?.()
  })
  it('same initial correlation subscribes without another offer or SDK query', async () => {
    const f = fixture(), input = { prompt: 'first', clientCorrelationId: start.correlationId, onSessionObserved: async () => undefined }
    const output = drain(f.manager.startInitialTurn(start, input)); const message = await f.next()
    f.manager.startInitialTurn(start, input)
    expect(f.query).toHaveBeenCalledOnce(); void f.init(); void f.reply(message.uuid); void f.result(message.uuid); await output; await f.manager.dispose?.()
  })
  it('failed SID persistence never exposes body or converts uncertainty into replay', async () => {
    const f = fixture(), ack = vi.fn()
    const pending = drain(f.manager.startInitialTurn(start, { prompt: 'first', clientCorrelationId: start.correlationId,
      onSessionObserved: async () => { throw new Error('injected bind failure') }, onMessageSubmitted: ack }))
    const message = await f.next(); void f.init(); void f.reply(message.uuid)
    await expect(pending).rejects.toThrow('bind failure'); expect(ack).not.toHaveBeenCalled()
    expect(f.query).toHaveBeenCalledOnce(); await f.manager.dispose?.()
  })
  it('second turn reuses the observed native session and initial instructions are not replayed', async () => {
    const f = fixture(); let session!: NativeSessionReference
    const first = drain(f.manager.startInitialTurn(start, { prompt: 'instructions\nfirst', clientCorrelationId: start.correlationId,
      onSessionObserved: async (observed) => { session = observed } }))
    const a = await f.next(); void f.init(); void f.reply(a.uuid); void f.result(a.uuid); await first
    const second = drain(f.manager.startTurn(session, { prompt: 'second', clientCorrelationId: 'conversation:request-2' }))
    const b = await f.next(); expect(b.message.content).toBe('second'); expect(b.uuid).not.toBe(a.uuid)
    void f.reply(b.uuid, 'second'); void f.result(b.uuid); await second
    expect(f.query).toHaveBeenCalledOnce(); await f.manager.dispose?.()
  })
  it('unowned wake result does not settle the newly admitted prompt', async () => {
    const f = fixture(); let session!: NativeSessionReference
    const pending = drain(f.manager.startInitialTurn(start, { prompt: 'first', clientCorrelationId: start.correlationId,
      onSessionObserved: async (observed) => { session = observed } }))
    const input = await f.next(); void f.init(); void f.frames.offer({ type: 'result', uuid: 'wake', session_id: 'observed-session', subtype: 'success', is_error: false })
    void f.reply(input.uuid); void f.result(input.uuid); await pending
    expect((await f.manager.reconcile(session, start.correlationId)).terminalTurn?.providerId).toBe(input.uuid)
    await f.manager.dispose?.()
  })
  it('read-only native history recovers exact v2 input receipt without a prompt or inferred outcome', async () => {
    const f = fixture(), session = { harness: configuration.harness.harness, providerVersion: '2.1.284', nativeSessionId: 'observed-session' }
    await f.manager.attachSession(session, start)
    f.history.mockResolvedValue([{ type: 'user', uuid: claudePromptUuid(start.correlationId), session_id: session.nativeSessionId, parent_tool_use_id: null }])
    const result = await f.manager.reconcile(session, start.correlationId)
    expect(result.nativeSubmission?.nativeMessageId).toBe(claudePromptUuid(start.correlationId))
    expect(result.nativeTurnId).toBeUndefined(); expect(result.terminalResult).toBeUndefined()
    expect(f.query).toHaveBeenCalledOnce(); await f.manager.dispose?.()
  })
  it('observer primer neither loses the first event nor cancels the SDK session on detach', async () => {
    const returned = vi.fn(), event = { type: 'message.submitted', sequence: 0, occurredAt: '2026-10-01T00:00:00.000Z', payload: {} }
    const source = { async *[Symbol.asyncIterator]() { try { yield event; yield { ...event, sequence: 1 } } finally { returned() } } }
    const primed = await primeInitialNativeStream(source); const reader = primed.output[Symbol.asyncIterator]()
    expect((await reader.next()).value).toEqual(event); await reader.return?.(); await primed.close(); expect(returned).toHaveBeenCalledOnce()
  })
  it('concrete factory forwards the actual callback-map reader with its current generation', async () => {
    const inspect = vi.fn<ClaudeLiveCallbackReader['inspectCallbackAvailability']>((query) => ({ nativeSessionId: query.nativeSessionId,
      nativeRequestId: query.nativeRequestId, nativeRequestType: query.nativeRequestType, nativeMessageId: query.nativeMessageId, generation: query.generation,
      qualified: true, state: 'available', path: 'live_callback', reason: 'live_callback' }))
    const f = fixture({ inspectCallbackAvailability: inspect }); let session!: NativeSessionReference
    const events = f.manager.startInitialTurn(start, { prompt: 'first', clientCorrelationId: start.correlationId, onSessionObserved: async (observed) => { session = observed } })[Symbol.asyncIterator]()
    const first = events.next(), input = await f.next(); void f.init(); void f.reply(input.uuid); await first
    expect(f.manager.inspectResponseAvailability).toBeTypeOf('function')
    expect((await f.manager.inspectResponseAvailability!(session, { nativeRequestId: 'actual-control-envelope', nativeRequestType: 'canUseTool' })).state).toBe('available')
    expect(inspect).toHaveBeenCalledOnce(); await events.return?.(); await f.manager.dispose?.()
  })
  it('fork uses the actual helper-returned native ID and preserves the source', async () => {
    const f = fixture(), source = { harness: configuration.harness.harness, providerVersion: '2.1.284', nativeSessionId: 'source-session' }
    const forked = await f.manager.forkSession!(source, start)
    expect(forked.nativeSessionId).toBe('observed-fork'); expect(source.nativeSessionId).toBe('source-session')
    expect(f.fork).toHaveBeenCalledOnce(); await f.manager.dispose?.()
  })
})

it('common writer persists observed SID before message receipt and exposes the owned message lease', async () => {
  const f = fixture()
  const lanes = nativeLanes()
  const writer = new SingleWriterSessionManager(f.manager, lanes, 'operator')
  const observed = deferred<void>()
  const commit = deferred<void>()
  const received: string[] = []
  const events: string[] = []
  const work = (async () => {
    for await (const event of writer.startInitialTurn!(start, {
      prompt: 'accepted input', clientCorrelationId: start.correlationId,
      onSessionObserved: async (session) => {
        expect(writer.currentProjectionLease(session)).toMatchObject({ live: true })
        observed.resolve()
        await commit.promise
      },
      onMessageSubmitted: async (receipt) => {
        const lease = writer.currentProjectionLease({ harness: 'claude', providerVersion: '2.1.284', nativeSessionId: receipt.nativeSessionId })
        expect(lease?.providerId).toBe(receipt.nativeMessageId)
        received.push(receipt.nativeMessageId)
      },
    })) events.push(event.type)
  })()
  const message = await f.next()
  void f.init()
  await observed.promise
  void f.reply(message.uuid)
  expect(received).toEqual([])
  expect(events).toEqual([])
  commit.resolve()
  void f.result(message.uuid)
  await work
  expect(received).toHaveLength(1)
  expect(f.query).toHaveBeenCalledTimes(1)
  expect((await lanes.getLane('claude', 'observed-session'))?.observedStatus).toBe('idle')
  expect((await lanes.getLane('claude', 'observed-session'))?.currentTurnOrMessageId).toBe(received[0])
  await writer.dispose()
})

// Selected-Run chat retains the agent-chat role; provenance does not grant
// workflow or Operator credentials. This checks common allocation only.
it('keeps workflow, Operator, Agent and selected-Run chat managers independently owned', async () => {
  const owners = [fixture(undefined, 'workflow'), fixture(undefined, 'operator'),
    fixture(undefined, 'agent-chat'), fixture(undefined, 'agent-chat')]
  expect(new Set(owners.map(owner => owner.manager)).size).toBe(4)
  for (const owner of owners) {
    expect(owner.query).not.toHaveBeenCalled()
    expect(() => owner.factories.inspector(owner.manager)).toThrow('no MCP inspector')
  }
  await owners[0]!.manager.dispose?.()
  const agent = owners[2]!
  const output = drain(agent.manager.startInitialTurn(start, { prompt: 'still owned',
    clientCorrelationId: start.correlationId, onSessionObserved: async () => undefined }))
  const input = await agent.next()
  void agent.init(); void agent.reply(input.uuid); void agent.result(input.uuid)
  expect((await output).some(event => event.type === 'claude.text')).toBe(true)
  await Promise.all(owners.slice(1).map(owner => owner.manager.dispose?.()))
})
