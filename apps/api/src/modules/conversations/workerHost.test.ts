import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionPreferencesSchema,
  type AgentHarness, type CompactionState, type NativeSessionReference, type SessionPreferences } from '@foreman-code/contracts'
import { WorkerConversationReceiptSchema } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeHarnessSessionManager, NativeHistory, NativeInitialTurnInput, NativeSessionStart,
  NativeTurnInput, NativeCompactInput } from '../harnesses/port.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { createRemoteExecutionHandler } from '../runs/remote/executionRouter.js'
import { WorkerConversationHost, type WorkerConversationHostPorts } from './workerHost.js'
import { pendingSessionControls } from '../harnesses/sessionControlDefaults.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import { DeviceApplicationChannel, extensionDescriptors, type DeviceExtensionRegistration } from '../devices/deviceApplicationChannel.js'
import { adaptDeviceSocket } from '../devices/deviceWire.js'
import { negotiateDeviceExtensions } from '@foreman-code/contracts/device-application'
import { CodexRpcError } from '../harnesses/codexStdioTransport.js'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { NativeDeliveryError } from '../harnesses/errors.js'

/** Provider I/O fixture only; these cases do not qualify native installations. */
class ProviderFixture implements NativeHarnessSessionManager {
  creates = 0
  compactCalls = 0
  modes: Array<NativeTurnInput['sessionMode']> = []
  prompts: string[] = []
  configured: SessionPreferences | null = null
  holdCompact = false
  releaseCompact: (() => void) | undefined
  latestCompaction: CompactionState | undefined
  private readonly histories = new Map<string, NativeHistory>()
  constructor(readonly harness: AgentHarness, readonly session: NativeSessionReference) {}
  async capabilities() {
    return { provider: this.harness, providerVersion: 'provider-fixture', persistentSessions: true, reconnect: true,
      sameRequestResponses: true, cancellation: true, history: true, configurationInspection: false,
      mcpDetection: false, supportedInteractionKinds: [] }
  }
  async inspectMcp(): Promise<never> { throw new Error('MCP setup is not replaced by this fixture.') }
  async configureSessionPreferences(preferences: SessionPreferences) { this.configured = preferences }
  async applySessionPreferences(_session: NativeSessionReference, preferences: SessionPreferences) { this.configured = preferences }
  appliedSessionPreferences() { return this.configured }
  async sessionControlCapabilities() {
    return { ...pendingSessionControls({ harness: 'codex', model: 'model-fixture', reasoningEffort: 'low',
      sandbox: 'read-only', serviceTier: 'standard' }), plan: { supported: true, reason: null } }
  }
  contextSnapshot() {
    return { nativeSessionId: this.session.nativeSessionId, model: 'model-fixture', generation: 'fixture-generation',
      sequence: 1, observedAt: '2026-10-05T00:00:00.000Z', source: this.harness,
      accuracy: 'native' as const, usedTokens: 50, capacityTokens: 1000, lifetimeTokens: 350, cost: null, stale: false }
  }
  async createSession() { this.creates++; return this.session }
  async attachSession() { return this.session }
  async forkSession() { this.creates++; return this.session }
  async *startTurn(_session: NativeSessionReference, input: NativeTurnInput):
    ReturnType<NativeHarnessSessionManager['startTurn']> {
    this.modes.push(input.sessionMode)
    this.prompts.push(input.prompt)
    const id = `fixture-turn-${this.prompts.length}`
    await input.onSubmitted?.(id)
    await input.onSettingsApplied?.()
    const result = { outcome: 'succeeded' as const, output: { text: input.prompt } }
    this.histories.set(input.clientCorrelationId, { correlationId: input.clientCorrelationId,
      nativeTurnId: id, terminalTurn: { correlationId: input.clientCorrelationId, providerId: id, result },
      events: [], pendingInteractions: [], terminalResult: result })
    yield { sequence: this.prompts.length, type: 'turn.completed', occurredAt: '2026-10-05T00:00:00.000Z', payload: {} }
  }
  async *startInitialTurn(_start: NativeSessionStart, input: NativeInitialTurnInput) {
    this.creates++
    await input.onSessionObserved(this.session)
    await input.onMessageSubmitted?.({ kind: 'message', nativeSessionId: this.session.nativeSessionId,
      nativeMessageId: 'observed-message', clientCorrelationId: input.clientCorrelationId })
    yield* this.startTurn(this.session, input)
  }
  async compactSession(_session: NativeSessionReference, input: NativeCompactInput) {
    await input.onDispatch?.()
    this.compactCalls++
    const state: CompactionState = { requestId: input.requestId, nativeSessionId: this.session.nativeSessionId,
      nativeOperationId: 'observed-boundary', status: 'running', beforeTokens: 50,
      observedAt: '2026-10-05T00:00:00.000Z', message: 'Compacting fixture context.' }
    this.latestCompaction = state
    await input.onProgress(state)
    if (this.holdCompact) await new Promise<void>(resolve => { this.releaseCompact = resolve })
    this.latestCompaction = { ...state, status: 'completed' }
    return this.latestCompaction
  }
  async reconcileCompaction(_session: NativeSessionReference, state: CompactionState) { return this.latestCompaction ?? state }
  async pending() { return undefined }
  async respond() {}
  async cancel() { return true }
  async history(): Promise<NativeHistory> { return { events: [], pendingInteractions: [] } }
  async reconcile(_session: NativeSessionReference, correlationId: string) {
    return this.histories.get(correlationId) ?? { events: [], pendingInteractions: [] }
  }
  async close() {}
}

const closing: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closing.splice(0).reverse()) await close() })
async function setup(harness: AgentHarness = 'codex') {
  const f = workerConversationFixture('operator', harness)
  const root = await mkdtemp(join(tmpdir(), 'worker-chat-host-'))
  closing.push(() => rm(root, { recursive: true, force: true }))
  const journal = await RemoteOperationJournal.open(join(root, 'operations.json'), { initializeNewInstallation: true })
  closing.push(() => journal.close())
  const manager = new ProviderFixture(harness, f.session)
  let allowed = true
  let current = f.connection
  const observed = { sessions: [] as NativeSessionReference[], turns: [] as string[] }
  const ports: WorkerConversationHostPorts = {
    journal: journal.conversations, currentBinding: () => current,
    authorize: async () => { if (!allowed) throw new Error('Current Main authority denied the operation.') },
    allocate: async () => ({ manager,
      start: async ({ correlationId }) => {
        if (!('operatorId' in f.configuration)) throw new Error('This fixture starts only Operator native sessions.')
        return { kind: 'operator', correlationId, configuration: f.configuration, workingDirectory: f.binding.workingDirectory }
      }, nativeOwner: async () => f.nativeOwner, close: async () => {} }),
    observeSession: async (_binding, session) => {
      expect((await journal.conversations.read(f.binding))?.session).toEqual(session)
      observed.sessions.push(session)
    },
    observeSubmission: async (_binding, correlationId) => { observed.turns.push(correlationId) },
  }
  const host = new WorkerConversationHost(ports)
  closing.push(async () => { manager.releaseCompact?.(); await host.shutdown() })
  const request = (input: Record<string, unknown>) => host.handle({ ...input, binding: f.binding }, current)
  const open = { method: 'conversation.open', operationId: 'original-message', mode: 'create', configuration: f.configuration }
  return { ...f, root, journal, journalPath: join(root, 'operations.json'), manager, ports, host, observed, request, open,
    deny: () => { allowed = false },
    replaceConnection: (changes: Partial<typeof current> = {}) => {
      current = { ...current, connectionEpoch: randomUUID(), ...changes }
      return current
    } }
}
function receipt(value: unknown) {
  return WorkerConversationReceiptSchema.parse((value as { receipt: unknown }).receipt)
}

it('closes a released persisted session without allocating a replacement writer', async () => {
  const f = await setup()
  const allocate = vi.spyOn(f.ports, 'allocate')
  await f.request(f.open)
  await f.request({ method: 'conversation.release-runtime', session: f.session })
  const before = (await f.journal.conversations.read(f.binding))!
  expect(before.runtimeReleased).toBe(true)
  await expect(f.request({ method: 'conversation.close',
    session: { ...f.session, nativeSessionId: 'another-native-session' } }))
    .rejects.toMatchObject({ code: 'WORKER_CONVERSATION_UNAVAILABLE' })
  expect(await f.journal.conversations.read(f.binding)).toEqual(before)
  const closed = receipt(await f.request({ method: 'conversation.close', session: f.session }))
  expect(closed).toMatchObject({ closed: true, session: f.session, turns: before.turns, compactions: before.compactions })
  expect(receipt(await f.request({ method: 'conversation.close', session: f.session }))).toEqual(closed)
  expect(allocate).toHaveBeenCalledOnce()
  expect(f.manager.creates).toBe(1)
  f.deny()
  await expect(f.request({ method: 'conversation.close', session: f.session })).rejects.toThrow('authority denied')
  expect(await f.journal.conversations.read(f.binding)).toEqual(closed)
})

it('keeps cold closure unavailable without persisted process release', async () => {
  const f = await setup()
  await f.request(f.open)
  await f.host.shutdown()
  const before = await f.journal.conversations.read(f.binding)
  const allocate = vi.spyOn(f.ports, 'allocate')
  const host = new WorkerConversationHost(f.ports)
  closing.push(() => host.shutdown())
  await expect(host.handle({ method: 'conversation.close', binding: f.binding, session: f.session }, f.connection))
    .rejects.toMatchObject({ code: 'WORKER_CONVERSATION_UNAVAILABLE' })
  expect(await f.journal.conversations.read(f.binding)).toEqual(before)
  expect(allocate).not.toHaveBeenCalled()
})

it('rebinds released-session closure to the authenticated Worker boot without native attachment', async () => {
  const f = await setup()
  await f.request(f.open)
  await f.request({ method: 'conversation.release-runtime', session: f.session })
  const before = (await f.journal.conversations.read(f.binding))!
  await f.host.shutdown()
  const connection = f.replaceConnection({ bootId: randomUUID(), connectionGeneration: 2 })
  const allocate = vi.spyOn(f.ports, 'allocate')
  const host = new WorkerConversationHost(f.ports)
  closing.push(() => host.shutdown())
  const closed = receipt(await host.handle({ method: 'conversation.close', binding: f.binding, session: f.session }, connection))
  expect(closed).toMatchObject({ closed: true, connection, session: before.session,
    nativeOwner: before.nativeOwner, turns: before.turns, compactions: before.compactions })
  expect(await f.journal.conversations.read(f.binding)).toEqual(closed)
  expect(receipt(await host.handle({ method: 'conversation.close', binding: f.binding, session: f.session }, connection)))
    .toEqual(closed)
  expect(allocate).not.toHaveBeenCalled()
})

it.each(['keyRevision', 'authorizationRevision'] as const)(
  'rejects released-session closure after the paired Worker %s changes', async field => {
    const f = await setup()
    await f.request(f.open)
    await f.request({ method: 'conversation.release-runtime', session: f.session })
    const before = await f.journal.conversations.read(f.binding)
    await f.host.shutdown()
    const connection = f.replaceConnection({ bootId: randomUUID(), [field]: f.connection[field] + 1 })
    const host = new WorkerConversationHost(f.ports)
    closing.push(() => host.shutdown())
    await expect(host.handle({ method: 'conversation.close', binding: f.binding, session: f.session }, connection))
      .rejects.toMatchObject({ code: 'WORKER_CONVERSATION_UNAVAILABLE' })
    expect(await f.journal.conversations.read(f.binding)).toEqual(before)
  })

it('returns only events after the requested sequence while preserving terminal metadata', async () => {
  const f = await setup()
  await f.request(f.open)
  const history: NativeHistory = { events: [1, 2, 3].map(sequence => ({ sequence,
    type: 'event', occurredAt: '2026-10-05T00:00:00.000Z', payload: {} })),
    pendingInteractions: [], firstRetainedSequence: 1, nextSequence: 4,
    terminalTurn: { correlationId: 'finished', providerId: 'finished-turn', result: { outcome: 'succeeded' } } }
  vi.spyOn(f.manager, 'history').mockResolvedValue(history)
  const result = await f.request({ method: 'conversation.history', session: f.session, afterSequence: 2 })
  expect(result).toMatchObject({ history: { events: [history.events[2]],
    firstRetainedSequence: 1, nextSequence: 4, terminalTurn: history.terminalTurn } })
  expect(history.events).toHaveLength(3)
})

it.each(['first message', 'continuation'])('reads a %s before Worker reservation without changing native ownership', async phase => {
  const f = await setup()
  await f.request(f.open)
  if (phase === 'continuation') {
    await f.request({ method: 'conversation.start-turn', session: f.session,
      prompt: 'Previous message', correlationId: 'previous' })
    await f.host.drainForUpdate()
    expect((await f.journal.conversations.read(f.binding))?.turns[0]?.status).toBe('completed')
  }
  const before = await f.journal.conversations.read(f.binding)
  const reconcile = vi.spyOn(f.manager, 'reconcile')
  let entered!: () => void
  const entering = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void
  const authorization = new Promise<void>(resolve => { release = resolve })
  const authorize = f.ports.authorize
  f.ports.authorize = async (request, connection, signal) => {
    await authorize(request, connection, signal)
    if (request.method === 'conversation.start-turn' && request.correlationId === 'next') {
      entered()
      await authorization
    }
  }
  const next = { method: 'conversation.start-turn', session: f.session,
    prompt: 'Next message', correlationId: 'next' }
  const sending = f.request(next)
  try {
    await entering
    for (const method of ['conversation.history', 'conversation.reconcile']) {
      const result = await f.request({ method, session: f.session, correlationId: 'next' })
      expect(result).toMatchObject({ history: { events: [], pendingInteractions: [] } })
      expect(receipt(result)).toEqual(before)
    }
    expect(reconcile).not.toHaveBeenCalled()
  } finally {
    release()
    await sending
    await f.host.drainForUpdate()
  }
  const completed = await f.journal.conversations.read(f.binding)
  expect(completed?.session).toEqual(f.session)
  expect(completed?.turns.at(-1)).toMatchObject({ correlationId: 'next', status: 'completed',
    result: { outcome: 'succeeded', output: { text: next.prompt } } })
  const prompts = phase === 'continuation' ? ['Previous message', next.prompt] : [next.prompt]
  expect(f.manager.prompts).toEqual(prompts)
  await f.request(next)
  await f.host.drainForUpdate()
  expect(f.manager.prompts).toEqual(prompts)
  expect(f.manager.creates).toBe(1)
})

it('keeps file callbacks with the live turn while its submitted input is still activating', async () => {
  const f = await setup()
  const allocation = await f.ports.allocate(f.binding, f.configuration, f.connection, AbortSignal.timeout(1000))
  const recoverFiles = vi.fn(async () => { throw new Error('The live file owner is still activating.') })
  f.ports.allocate = async () => ({ ...allocation, recoverFiles })
  await f.request(f.open)
  let submitted!: () => void
  const submission = new Promise<void>(resolve => { submitted = resolve })
  let release!: () => void
  const activation = new Promise<void>(resolve => { release = resolve })
  f.ports.observeSubmission = async () => {
    submitted()
    await activation
  }
  try {
    await f.request({ method: 'conversation.start-turn', session: f.session,
      prompt: 'Keep the original callbacks', correlationId: 'activating-turn' })
    await submission
    const result = await f.request({ method: 'conversation.reconcile', session: f.session,
      correlationId: 'activating-turn' })
    expect(receipt(result).turns[0]?.nativeTurnId).toBe('fixture-turn-1')
    expect(recoverFiles).not.toHaveBeenCalled()
  } finally { release() }
  await f.host.drainForUpdate()
  expect((await f.journal.conversations.read(f.binding))?.turns[0]?.status).toBe('completed')
  expect(f.manager.prompts).toEqual(['Keep the original callbacks'])
})

it('closes only the idle old owner and attaches the same session under the requested App MCP access', async () => {
  const f = await setup()
  const allocation = await f.ports.allocate(f.binding, f.configuration, f.connection, AbortSignal.timeout(1000))
  const closeOld = vi.fn(async () => {})
  f.ports.allocate = async () => ({ ...allocation, close: closeOld })
  await f.request(f.open)
  const next = { ...f.binding, appMcpAccess: 'scoped' as const }
  const owner = { ...f.nativeOwner, processIdentityDigest: 'c'.repeat(64) }
  const recover = vi.fn(async (...args: Parameters<NonNullable<WorkerConversationHostPorts['recover']>>) => {
    const [record, configuration, connection, signal, request] = args
    expect(configuration).toEqual(f.configuration)
    expect(signal.aborted).toBe(false)
    expect(closeOld).toHaveBeenCalledOnce()
    expect(record.applicationAccessChange?.state).toBe('reserved')
    expect('applicationAccess' in request && request.applicationAccess)
      .toEqual({ kind: 'operator-chat-mcp', token: 'normally-issued-credential' })
    await f.journal.conversations.recoveredOwner(f.binding, connection, f.nativeOwner, owner, { targetBinding: next })
    return { ...allocation, nativeOwner: async () => owner }
  }) satisfies WorkerConversationHostPorts['recover']
  f.ports.recover = recover
  const request = { method: 'conversation.open', binding: next, previousBinding: f.binding,
    mode: 'attach', source: f.session, operationId: 'access-message', configuration: f.configuration,
    applicationAccess: { kind: 'operator-chat-mcp', token: 'normally-issued-credential' } }
  const changed = receipt(await f.host.handle(request, f.connection))
  expect(changed.binding).toEqual(next)
  expect(changed.session).toEqual(f.session)
  expect(changed.nativeOwner).toEqual(owner)
  expect(f.manager.creates).toBe(1)
  expect(f.manager.prompts).toEqual([])
  expect(receipt(await f.host.handle(request, f.connection)).nativeOwner).toEqual(owner)
  expect(closeOld).toHaveBeenCalledOnce()
  expect(recover).toHaveBeenCalledOnce()
})

it('keeps the old owner alive when an access handoff addresses another native session', async () => {
  const f = await setup()
  const allocation = await f.ports.allocate(f.binding, f.configuration, f.connection, AbortSignal.timeout(1000))
  const closeOld = vi.fn(async () => {})
  f.ports.allocate = async () => ({ ...allocation, close: closeOld })
  await f.request(f.open)
  await expect(f.host.handle({ method: 'conversation.open', binding: { ...f.binding, appMcpAccess: 'scoped' },
    previousBinding: f.binding, mode: 'attach', source: { ...f.session, nativeSessionId: 'foreign-session' },
    operationId: 'foreign-access', configuration: f.configuration }, f.connection)).rejects.toThrow('settled Operator')
  expect(closeOld).not.toHaveBeenCalled()
  expect((await f.journal.conversations.read(f.binding))?.applicationAccessChange).toBeUndefined()
})

it('keeps fresh inspection separate from the first admitted Claude message owner', async () => {
  const f = await setup('claude')
  const base = await f.ports.allocate(f.binding, f.configuration, f.connection, AbortSignal.timeout(1000))
  const inspected = new ProviderFixture('claude', f.session)
  const closeInspection = vi.fn(async () => {})
  f.ports.prepare = vi.fn(async () => ({ ...base, manager: inspected, close: closeInspection }))
  const nativeStart = vi.fn(async (input: Parameters<typeof base.start>[0]) => {
    expect(closeInspection).toHaveBeenCalledOnce()
    return base.start(input)
  })
  const allocate = vi.fn(async () => ({ ...base, start: nativeStart }))
  f.ports.allocate = allocate
  const startInitialTurn = f.manager.startInitialTurn.bind(f.manager)
  const nativeCompleted = new Promise<void>((resolve, reject) => {
    f.manager.startInitialTurn = async function* (start, input) {
      try {
        yield* startInitialTurn(start, input)
        resolve()
      } catch (error) {
        reject(error)
        throw error
      }
    }
  })
  await f.request({ method: 'conversation.capabilities', configuration: f.configuration })
  expect(allocate).not.toHaveBeenCalled()
  expect(f.manager.creates).toBe(0)
  const [value] = await Promise.all([
    f.request({ method: 'conversation.initial-turn', operationId: 'message-creation',
      correlationId: 'actual-native-message', configuration: f.configuration, prompt: 'One admitted task' }),
    nativeCompleted,
  ])
  expect(receipt(value).creation?.operationId).toBe('message-creation')
  expect(f.manager.prompts).toEqual(['One admitted task'])
  expect(f.observed.sessions).toEqual([f.session])
  expect((await f.journal.conversations.read(f.binding))?.turns[0]?.nativeSubmission).toMatchObject({
    nativeSessionId: f.session.nativeSessionId, nativeMessageId: 'observed-message',
    clientCorrelationId: 'actual-native-message',
  })
  expect(nativeStart).toHaveBeenCalledWith({ correlationId: 'actual-native-message', instructionsDelivered: false })
  expect(allocate).toHaveBeenCalledOnce()
  expect(closeInspection).toHaveBeenCalledOnce()
  expect(f.manager.creates).toBe(1)
})

it.each(['codex'] as const)('inspects %s configuration without borrowing or closing the active conversation owner', async harness => {
  const f = await setup(harness)
  const allocation = await f.ports.allocate(f.binding, f.configuration, f.connection, AbortSignal.timeout(1000))
  const closeWriter = vi.fn(async () => {})
  f.ports.allocate = async () => ({ ...allocation, close: closeWriter })
  await f.request(f.open)
  const before = await f.journal.conversations.read(f.binding)
  const closeInspection = vi.fn(async () => {})
  const inspect = vi.fn(async () => ({
    harness, providerVersion: f.session.providerVersion, runnerId: `device:${f.connection.deviceId}`,
    workingDirectory: f.binding.workingDirectory, inspectedAt: '2026-10-05T00:00:00.000Z',
    entry: { name: 'foreman-code', transport: 'stdio' as const, enabled: true },
  }))
  f.ports.prepare = vi.fn(async () => ({ ...allocation, inspector: { inspect }, close: closeInspection }))
  const result = await f.request({ method: 'conversation.inspect-entry', configuration: f.configuration,
    inspection: { harness, runnerId: `device:${f.connection.deviceId}`, workingDirectory: f.binding.workingDirectory,
      serverName: 'foreman-code', phase: 'configuration' } })
  expect(result).toMatchObject({ entry: { name: 'foreman-code', enabled: true } })
  expect(closeInspection).toHaveBeenCalledOnce()
  expect(closeWriter).not.toHaveBeenCalled()
  expect(await f.journal.conversations.read(f.binding)).toEqual(before)
  expect(f.manager.creates).toBe(1)
  await f.request({ method: 'conversation.close', session: f.session })
  const preparedCount = vi.mocked(f.ports.prepare!).mock.calls.length
  await expect(f.request({ method: 'conversation.inspect-entry', configuration: f.configuration,
    inspection: { harness, runnerId: `device:${f.connection.deviceId}`, workingDirectory: f.binding.workingDirectory,
      serverName: 'foreman-code', phase: 'configuration' } })).rejects.toThrow('not available for inspection')
  expect(f.ports.prepare).toHaveBeenCalledTimes(preparedCount)
})

it('inspects a cold saved chat on a separate preparation and rechecks its scoped credential before attachment', async () => {
  const f = await setup('claude')
  f.binding.appMcpAccess = 'scoped'
  const created = receipt(await f.request(f.open))
  expect(created.session).toEqual(f.session)
  await f.host.shutdown()
  const inspectManager = new ProviderFixture('claude', f.session)
  const preparedClose = vi.fn(async () => {})
  const delivered = vi.fn(async () => {})
  const allocated = await f.ports.allocate(f.binding, f.configuration, f.connection, AbortSignal.timeout(1000))
  const prepare = vi.fn(async () => ({ ...allocated, manager: inspectManager,
    deliverClaudeCredential: delivered, close: preparedClose }))
  const recover = vi.fn(async () => allocated)
  const restored = new WorkerConversationHost({ ...f.ports, prepare, recover })
  const request = (input: Record<string, unknown>) => restored.handle({ ...input, binding: f.binding }, f.connection)
  try {
    await Promise.all([request({ method: 'conversation.capabilities', configuration: f.configuration }),
      request({ method: 'conversation.capabilities', configuration: f.configuration })])
    expect(prepare).toHaveBeenCalledOnce()
    expect(recover).not.toHaveBeenCalled()
    await request({ method: 'conversation.refresh-mcp', configuration: f.configuration,
      applicationAccess: { kind: 'operator-chat-mcp', token: 'recorded-scoped-credential' } })
    expect(delivered).toHaveBeenCalledWith('recorded-scoped-credential', expect.any(AbortSignal))
    await request({ ...f.open, mode: 'attach', source: f.session,
      applicationAccess: { kind: 'operator-chat-mcp', token: 'recorded-scoped-credential' } })
    expect(recover).toHaveBeenCalledWith(expect.objectContaining({ session: f.session }), f.configuration,
      f.connection, expect.any(AbortSignal), expect.objectContaining({ applicationAccess: {
        kind: 'operator-chat-mcp', token: 'recorded-scoped-credential' } }))
    expect(preparedClose).toHaveBeenCalledOnce()
    expect((await f.journal.conversations.read(f.binding))?.session).toEqual(f.session)
  } finally { await restored.shutdown() }
})

it('closes an unused prepared owner without closing a conversation that has admitted native input', async () => {
  const f = await setup('claude')
  const allocate = f.ports.allocate
  const close = vi.fn(async () => {})
  f.ports.allocate = async (...args) => ({ ...await allocate(...args), close })
  await f.request({ method: 'conversation.capabilities', configuration: f.configuration })
  expect(await f.request({ method: 'conversation.release-preparation' })).toEqual({ acknowledged: true })
  expect(close).toHaveBeenCalledTimes(1)
  expect(f.manager.creates).toBe(0)
  await f.request(f.open)
  await expect(f.request({ method: 'conversation.release-preparation' })).rejects.toThrow('cannot close an admitted model message')
  expect(close).toHaveBeenCalledTimes(1)
  expect((await f.journal.conversations.read(f.binding))?.closed).toBe(false)
})

for (const harness of ['codex', 'claude'] as const) {
  it(`forwards native Plan, preferences and separate usage through the ${harness} adapter port`, async () => {
    const f = await setup(harness)
    const preferences = SessionPreferencesSchema.parse(harness === 'claude' ? { autoCompact: 'off' } : {})
    expect(receipt(await f.request({ ...f.open, preferences })).session).toEqual(f.session)
    await f.request({ method: 'conversation.start-turn', session: f.session, prompt: 'One planned task',
      correlationId: 'planned-message', sessionMode: 'plan', preferences })
    await vi.waitFor(async () => expect((await f.journal.conversations.read(f.binding))?.turns[0]?.status).toBe('completed'))
    expect(f.manager.prompts).toEqual(['One planned task'])
    expect(f.manager.modes).toEqual(['plan'])
    expect((await f.journal.conversations.read(f.binding))?.turns[0]?.sessionMode).toBe('plan')
    const controls = await f.request({ method: 'conversation.controls-read', session: f.session })
    expect(controls).toMatchObject({ context: { usedTokens: 50, capacityTokens: 1000, lifetimeTokens: 350 }, preferences })
    expect(receipt(controls).closed).toBe(false)
    await f.request({ method: 'conversation.start-turn', session: f.session, prompt: 'Regular follow-up',
      correlationId: 'regular-message', sessionMode: 'regular' })
    await vi.waitFor(() => expect(f.manager.modes).toEqual(['plan', 'regular']))
    expect(f.manager.creates).toBe(1)
  })
}

it('deduplicates concurrent native session creation and refuses mismatched configuration before allocation', async () => {
  const f = await setup()
  const results = await Promise.all([f.request(f.open), f.request(f.open)])
  await vi.waitFor(() => expect(f.observed.sessions).toHaveLength(1))
  expect(results.map(value => receipt(value).binding)).toEqual([f.binding, f.binding])
  expect(f.manager.creates).toBe(1)
  await expect(f.request({ ...f.open, configuration: { ...f.configuration, version: 2 } })).rejects.toThrow('configuration differs')
  expect(f.manager.creates).toBe(1)
})

it('rejects a changed configuration before persisting a new conversation owner', async () => {
  const f = await setup('claude')
  const allocate = vi.spyOn(f.ports, 'allocate')
  await expect(f.request({ ...f.open, configuration: { ...f.configuration, version: 2 } }))
    .rejects.toThrow('configuration differs')
  expect(allocate).not.toHaveBeenCalled()
  expect(await f.journal.conversations.read(f.binding)).toBeUndefined()
})

it('reauthorizes controls and rejects a foreign native session or replaced channel', async () => {
  const f = await setup()
  await f.request(f.open)
  await expect(f.request({ method: 'conversation.cancel', session: { ...f.session, nativeSessionId: 'foreign' } }))
    .rejects.toThrow('not resident')
  f.deny()
  await expect(f.request({ method: 'conversation.controls-read', session: f.session })).rejects.toThrow('authority denied')
  const other = await setup()
  other.replaceConnection()
  await expect(other.host.handle({ ...other.open, binding: other.binding }, other.connection)).rejects.toThrow('connection changed')
  expect(other.manager.creates).toBe(0)
})

it.each(['codex', 'claude'] as const)(
  'retains %s compaction across a lost response without blocking reads or dispatching twice', async harness => {
  const f = await setup(harness)
  await f.request(f.open)
  f.manager.holdCompact = true
  const compact = { method: 'conversation.compact', session: f.session,
    requestId: 'original-compact', correlationId: 'original-compact-correlation' }
  await f.request(compact)
  await vi.waitFor(() => expect(f.manager.compactCalls).toBe(1))
  const replay = await f.request(compact)
  expect(replay).toMatchObject({ compaction: { status: 'running', nativeOperationId: 'observed-boundary' } })
  expect(await f.request({ method: 'conversation.controls-read', session: f.session })).toMatchObject({ context: { usedTokens: 50 } })
  await expect(f.request({ method: 'conversation.start-turn', session: f.session, prompt: 'too early', correlationId: 'early' }))
    .rejects.toThrow('pending')
  f.manager.releaseCompact!()
  await vi.waitFor(async () => expect((await f.journal.conversations.read(f.binding))?.compactions[0]?.state.status).toBe('completed'))
  expect(await f.request(compact)).toMatchObject({ compaction: { status: 'completed' } })
  expect(f.manager.compactCalls).toBe(1)
  expect((await f.journal.conversations.read(f.binding))?.closed).toBe(false)
})

for (const harness of ['codex', 'claude'] as const) {
  it.each(['timeout', 'disconnect'] as const)(
    `keeps uncertain ${harness} compaction blocked after %s and restart until its terminal result`, async outcome => {
      const f = await setup(harness)
      await f.request(f.open)
      let offered!: () => void
      const dispatched = new Promise<void>(resolve => { offered = resolve })
      const compact = vi.spyOn(f.manager, 'compactSession').mockImplementation(async (_session, input) => {
        await input.onProgress({ requestId: input.requestId, nativeSessionId: f.session.nativeSessionId,
          nativeOperationId: 'compaction-operation', status: 'running', beforeTokens: 50,
          observedAt: new Date().toISOString(), message: 'Compacting context' })
        await input.onDispatch?.()
        offered()
        if (outcome === 'timeout') throw new DOMException('Response timed out', 'TimeoutError')
        throw new Error('Native connection closed')
      })
      const request = { method: 'conversation.compact', session: f.session,
        requestId: 'uncertain-request', correlationId: 'uncertain-correlation' }
      await f.request(request)
      await dispatched
      await f.host.shutdown()
      expect((await f.journal.conversations.read(f.binding))?.compactions[0]?.state.status).toBe('uncertain')
      await f.journal.close()
      const reopened = await RemoteOperationJournal.open(f.journalPath)
      closing.push(() => reopened.close())
      const state = (await reopened.conversations.read(f.binding))!.compactions[0]!.state
      expect(await reopened.conversations.reserveCompact(f.binding, request.requestId,
        commandInputHash({ session: f.session, correlationId: request.correlationId })))
        .toMatchObject({ dispatch: false, state: { status: 'uncertain' } })
      let terminal = false
      const read = vi.fn(async () => terminal ? { ...state, status: 'completed' as const } : state)
      const allocation = vi.fn(async (): Promise<never> => { throw new Error('Read opened a writer') })
      const restarted = new WorkerConversationHost({ ...f.ports,
        journal: reopened.conversations, readCompaction: read, allocate: allocation })
      closing.push(() => restarted.shutdown())
      const recovery = { method: 'conversation.compact-read', binding: f.binding,
        configuration: f.configuration, session: f.session, state, correlationId: 'recovery-read' }
      expect(await restarted.handle(recovery, f.connection)).toMatchObject({ compaction: { status: 'uncertain' } })
      await expect(reopened.conversations.reserveTurn(f.binding, 'early', commandInputHash('early-input'))).rejects.toThrow('pending')
      terminal = true
      expect(await restarted.handle(recovery, f.connection)).toMatchObject({ compaction: { status: 'completed' } })
      expect((await reopened.conversations.reserveTurn(f.binding, 'followup', commandInputHash('followup-input'))).dispatch).toBe(true)
      expect(compact).toHaveBeenCalledOnce()
      expect(allocation).not.toHaveBeenCalled()
    },
  )
}

it.each(['codex', 'claude'] as const)(
  'persists %s definite compaction rejection and allows the next turn after restart', async harness => {
    const f = await setup(harness)
    await f.request(f.open)
    const error = {
      codex: new CodexRpcError('thread/compact/start', 'compact-rpc', false, 'REJECTED'),
      claude: Object.assign(new Error('Command was not delivered'), { deliveryState: 'not-delivered' }),
    }[harness]
    let offered!: () => void
    const dispatched = new Promise<void>(resolve => { offered = resolve })
    const compact = vi.spyOn(f.manager, 'compactSession').mockImplementation(async (_session, input) => {
      await input.onDispatch?.()
      offered()
      throw error
    })
    const request = { method: 'conversation.compact', session: f.session,
      requestId: 'rejected-compact', correlationId: 'rejected-correlation' }
    await f.request(request)
    await dispatched
    expect(await f.request(request)).toMatchObject({ compaction: { requestId: 'rejected-compact' } })
    await f.host.shutdown()
    expect((await f.journal.conversations.read(f.binding))?.compactions[0]?.state)
      .toMatchObject({ status: 'failed', dispatchPhase: 'dispatched' })
    await f.journal.close()
    const reopened = await RemoteOperationJournal.open(f.journalPath)
    closing.push(() => reopened.close())
    const coldRead = vi.fn(async () => { throw new Error('A terminal outcome must not read provider history') })
    const restarted = new WorkerConversationHost({ ...f.ports, journal: reopened.conversations, readCompaction: coldRead })
    closing.push(() => restarted.shutdown())
    const saved = (await reopened.conversations.read(f.binding))!.compactions[0]!.state
    expect(await restarted.handle({ method: 'conversation.compact-read', binding: f.binding,
      configuration: f.configuration, session: f.session, state: saved, correlationId: 'recovery-read' }, f.connection))
      .toMatchObject({ compaction: { status: 'failed' } })
    expect(coldRead).not.toHaveBeenCalled()
    expect(await reopened.conversations.reserveCompact(f.binding, request.requestId,
      commandInputHash({ session: f.session, correlationId: request.correlationId })))
      .toMatchObject({ dispatch: false, state: { status: 'failed' } })
    expect((await reopened.conversations.reserveTurn(f.binding, 'after-rejection', commandInputHash('next-input'))).dispatch).toBe(true)
    expect(compact).toHaveBeenCalledOnce()
  },
)

it('keeps the native boundary when the provider saves progress before dispatch', async () => {
  const f = await setup('claude')
  await f.request(f.open)
  let finish!: () => void
  const finished = new Promise<void>(resolve => { finish = resolve })
  const compact = vi.spyOn(f.manager, 'compactSession').mockImplementation(async (_session, input) => {
    const state: CompactionState = { requestId: input.requestId, nativeSessionId: f.session.nativeSessionId,
      nativeOperationId: 'history-baseline', status: 'running', beforeTokens: 50,
      observedAt: new Date().toISOString(), message: 'Compacting context' }
    try {
      await input.onProgress(state)
      await input.onDispatch?.()
      await input.onProgress(state)
      return { ...state, status: 'completed' }
    } finally { finish() }
  })
  await f.request({ method: 'conversation.compact', session: f.session,
    requestId: 'progress-first', correlationId: 'progress-first' })
  await finished
  await f.host.shutdown()
  expect((await f.journal.conversations.read(f.binding))?.compactions[0]?.state)
    .toMatchObject({ status: 'completed', nativeOperationId: 'history-baseline', dispatchPhase: 'dispatched' })
  expect(compact).toHaveBeenCalledOnce()
})

it('forks independently, keeps its source untouched and carries real initial-message observations', async () => {
  const f = await setup()
  const source = { ...f.session, nativeSessionId: 'observed-source-session' }
  const before = structuredClone(source)
  expect(receipt(await f.request({ ...f.open, mode: 'fork', source })).session).toEqual(f.session)
  expect(source).toEqual(before)
  expect(f.session.nativeSessionId).not.toBe(source.nativeSessionId)
  const initial = await setup('claude')
  await initial.request({ method: 'conversation.initial-turn', operationId: 'initial-request', configuration: initial.configuration,
    prompt: 'Initial task', correlationId: 'initial-correlation', sessionMode: 'plan' })
  await vi.waitFor(async () => expect((await initial.journal.conversations.read(initial.binding))?.turns[0]?.status)
    .toBe('completed'), { timeout: 10000 })
  expect(initial.observed.sessions).toEqual([initial.session])
  expect((await initial.journal.conversations.read(initial.binding))?.turns[0]?.nativeSubmission).toMatchObject({
    nativeSessionId: initial.session.nativeSessionId, nativeMessageId: 'observed-message' })
})

it('reads fork history during preparation and reconciles the message after native submission', async () => {
  const f = await setup()
  const source = { ...f.session, nativeSessionId: 'historical-source-session' }
  await f.request({ ...f.open, mode: 'fork', source })
  let began!: () => void
  const preparing = new Promise<void>(resolve => { began = resolve })
  let release!: () => void
  const preparation = new Promise<void>(resolve => { release = resolve })
  let completed!: () => void
  const completion = new Promise<void>(resolve => { completed = resolve })
  const startTurn = f.manager.startTurn.bind(f.manager)
  vi.spyOn(f.manager, 'startTurn').mockImplementation(async function* (session, input) {
    began()
    await preparation
    yield* startTurn(session, input)
    completed()
  })
  const retained = { events: [{ sequence: 1, type: 'thread.forked',
    occurredAt: '2026-10-05T00:00:00.000Z', payload: {} }], pendingInteractions: [] }
  vi.spyOn(f.manager, 'history').mockResolvedValue(retained)
  const readPage = vi.fn((session: NativeSessionReference, correlationId: string) =>
    f.manager.reconcile(session, correlationId))
  Object.assign(f.manager, { reconcileHistoryPage: readPage })
  const correlationId = 'fork-follow-up'
  try {
    await f.request({ method: 'conversation.start-turn', session: f.session,
      prompt: 'Continue the saved task', correlationId })
    await preparing
    const request = { method: 'conversation.history', session: f.session, correlationId, afterSequence: -1 }
    expect(await f.request(request)).toMatchObject({ history: retained })
    expect(readPage).not.toHaveBeenCalled()
    expect((await f.journal.conversations.read(f.binding))?.turns[0]).toHaveProperty('nativeTurnId', null)
    release()
    await completion
    expect(await f.request(request)).toMatchObject({ history: { correlationId, nativeTurnId: 'fixture-turn-1' } })
    expect(readPage).toHaveBeenCalledOnce()
  } finally {
    release()
    await f.host.shutdown()
  }
})

it('routes chats on execution-v1 without entering the workflow handler', async () => {
  const f = await setup()
  const workflow = vi.fn(async () => { throw new Error('A chat must not enter workflow dispatch.') })
  const route = createRemoteExecutionHandler({ handle: workflow }, undefined, {
    handle: raw => f.host.handle(raw, f.connection),
  })
  expect(receipt(await route({ ...f.open, binding: f.binding })).session).toEqual(f.session)
  expect(workflow).not.toHaveBeenCalled()
  expect(() => route({ method: 'conversation.cancel', binding: f.binding })).toThrow()
  expect(workflow).not.toHaveBeenCalled()
  const unsupported = createRemoteExecutionHandler({ handle: workflow })
  expect(() => unsupported({ ...f.open, binding: f.binding })).toThrow('chat runtime is unavailable')
})

it('reads persisted ownership without allocating another native process', async () => {
  const f = await setup()
  const allocate = vi.spyOn(f.ports, 'allocate')
  expect(await f.request({ method: 'conversation.status' })).toEqual({ receipt: undefined })
  expect(allocate).not.toHaveBeenCalled()
  await f.request(f.open)
  const cold = new WorkerConversationHost(f.ports)
  try {
    expect(receipt(await cold.handle({ method: 'conversation.status', binding: f.binding }, f.connection)).session)
      .toEqual(f.session)
    expect(allocate).toHaveBeenCalledOnce()
    expect(f.manager.creates).toBe(1)
  } finally { await cold.shutdown() }
})

class MemorySocket extends EventEmitter {
  bufferedAmount = 0
  peer: MemorySocket | undefined
  closed = false
  send(text: string) {
    queueMicrotask(() => { if (!this.closed && !this.peer?.closed) this.peer?.emit('message', Buffer.from(text), false) })
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
    this.peer?.close()
  }
}

it('carries conversation operations on the paired channel and applies Main denial before effects', async () => {
  const f = await setup()
  const left = new MemorySocket()
  const right = new MemorySocket()
  left.peer = right
  right.peer = left
  const mainSocket = adaptDeviceSocket(left)
  const workerSocket = adaptDeviceSocket(right)
  const mainRegistration: DeviceExtensionRegistration = { namespace: 'execution-v1', version: 1,
    role: 'client', maxJsonBytes: 1_048_576, maxBinaryBytes: 0 }
  const workerRegistration: DeviceExtensionRegistration = { ...mainRegistration, role: 'server',
    handle: async (raw, context) => ({ payload: await f.host.handle(raw, context.binding, context.signal) }) }
  const extensions = negotiateDeviceExtensions(extensionDescriptors([mainRegistration]), extensionDescriptors([workerRegistration]))
  const lifetime = new AbortController()
  const revalidate = vi.fn(async () => {})
  const main = new DeviceApplicationChannel({ side: 'main', binding: f.connection, socket: mainSocket,
    signal: lifetime.signal, extensions, registrations: [mainRegistration], revalidate })
  const worker = new DeviceApplicationChannel({ side: 'worker', binding: f.connection, socket: workerSocket,
    signal: lifetime.signal, extensions, registrations: [workerRegistration] })
  const readers = [main.run(mainSocket.messages[Symbol.asyncIterator](), 10_000),
    worker.run(workerSocket.messages[Symbol.asyncIterator](), 10_000)]
  for (const task of readers) void task.catch(() => {
    // ignore: shutdown awaits both channel readers below.
  })
  try {
    const result = await main.request('execution-v1', { ...f.open, binding: f.binding })
    expect(receipt(result.payload).session).toEqual(f.session)
    expect(revalidate).toHaveBeenCalled()
    f.deny()
    await expect(main.request('execution-v1', { method: 'conversation.start-turn', binding: f.binding,
      session: f.session, prompt: 'Denied message', correlationId: 'denied-message' })).rejects.toThrow()
    expect(f.manager.prompts).toEqual([])
    expect((await f.journal.conversations.read(f.binding))?.turns).toEqual([])
  } finally {
    lifetime.abort()
    main.close()
    worker.close()
    await Promise.allSettled(readers)
    await Promise.all([main.join(), worker.join()])
  }
})


it('persists definite non-delivery and admits a later message without replaying the rejected one', async () => {
  const f = await setup('claude')
  await f.request(f.open)
  const start = f.manager.startTurn.bind(f.manager)
  f.manager.startTurn = async function* (session, input) {
    if (input.clientCorrelationId === 'rejected') {
      throw Object.assign(new Error('Settings failed before offer'), {
        certainty: 'definite', deliveryState: 'not-delivered',
      })
    }
    yield* start(session, input)
  }
  const rejected = { method: 'conversation.start-turn', session: f.session,
    prompt: 'Never offered', correlationId: 'rejected' }
  await f.request(rejected)
  await vi.waitFor(async () => expect((await f.journal.conversations.read(f.binding))?.turns[0]?.status).toBe('rejected'))
  const history = await f.request({ method: 'conversation.reconcile', session: f.session, correlationId: 'rejected' })
  expect(history).toMatchObject({ history: { nonSubmission: {
    nativeSessionId: f.session.nativeSessionId, clientCorrelationId: 'rejected', result: { outcome: 'failed' },
  } } })
  await f.request(rejected)
  await f.request({ ...rejected, prompt: 'Delivered later', correlationId: 'later' })
  await vi.waitFor(async () => expect((await f.journal.conversations.read(f.binding))?.turns[1]?.status).toBe('completed'))
  expect(f.manager.prompts).toEqual(['Delivered later'])
  expect(f.manager.creates).toBe(1)
})

it.each(['confirmed', 'pending'] as const)('persists native non-delivery with %s cleanup', async cleanup => {
  const f = await setup()
  await f.request(f.open)
  const start = f.manager.startTurn.bind(f.manager)
  f.manager.startTurn = async function* (session, input) {
    if (input.clientCorrelationId === 'not-sent') {
      throw new NativeDeliveryError('turn_submission', 'not_sent', new Error('Native startup refused input'), cleanup)
    }
    yield* start(session, input)
  }
  const message = { method: 'conversation.start-turn', session: f.session,
    prompt: 'Never submitted', correlationId: 'not-sent' }
  await f.request(message)
  await f.host.drainForUpdate()
  expect((await f.journal.conversations.read(f.binding))?.turns[0]?.status)
    .toBe(cleanup === 'confirmed' ? 'rejected' : 'uncertain')
  const next = { ...message, prompt: 'Continue later', correlationId: 'later' }
  if (cleanup === 'pending') {
    await expect(f.request(next)).rejects.toThrow('pending')
    expect(f.manager.prompts).toEqual([])
  } else {
    const history = await f.request({ method: 'conversation.reconcile', session: f.session, correlationId: 'not-sent' })
    expect(history).toMatchObject({ history: { nonSubmission: {
      nativeSessionId: f.session.nativeSessionId, clientCorrelationId: 'not-sent', result: { outcome: 'failed' },
    } } })
    await f.request(message)
    await f.request(next)
    await f.host.drainForUpdate()
    expect((await f.journal.conversations.read(f.binding))?.turns[1]?.status).toBe('completed')
    expect(f.manager.prompts).toEqual([next.prompt])
    expect(f.manager.creates).toBe(1)
  }
})

it('keeps a possibly delivered message fenced even if an error claims non-delivery', async () => {
  const f = await setup('claude')
  await f.request(f.open)
  f.manager.startTurn = (_session, input) => ({
    [Symbol.asyncIterator]() {
      return { next: async () => {
        await input.onMessageSubmitted?.({ kind: 'message', nativeSessionId: f.session.nativeSessionId,
          nativeMessageId: 'already-offered', clientCorrelationId: input.clientCorrelationId })
        throw Object.assign(new Error('Submission acknowledgement failed'), {
          certainty: 'definite', deliveryState: 'not-delivered',
        })
      } }
    },
  })
  await f.request({ method: 'conversation.start-turn', session: f.session, prompt: 'Offered', correlationId: 'uncertain' })
  await vi.waitFor(async () => expect((await f.journal.conversations.read(f.binding))?.turns[0]?.status).toBe('uncertain'))
  await expect(f.request({ method: 'conversation.start-turn', session: f.session,
    prompt: 'Blocked', correlationId: 'blocked' })).rejects.toThrow('pending')
})

it('recovers an initial startup failure after reservation and preserves retry idempotency across journal reopen', async () => {
  const f = await setup('claude')
  const allocation = await f.ports.allocate(f.binding, f.configuration, f.connection, AbortSignal.timeout(1000))
  let fail = true
  const startup = vi.fn(async (input: Parameters<typeof allocation.start>[0]) => {
    if (fail) throw new Error('Profile changed before native startup')
    return allocation.start(input)
  })
  f.ports.allocate = async () => ({ ...allocation, start: startup })
  const initial = { method: 'conversation.initial-turn', operationId: 'initial-operation', configuration: f.configuration,
    prompt: 'Initial input', correlationId: 'initial-message' }
  expect(receipt(await f.request(initial))).toMatchObject({
    creation: { status: 'rejected' }, turns: [{ status: 'rejected', result: { outcome: 'failed' } }],
  })
  expect(f.manager.creates).toBe(0)
  await f.journal.close()
  const reopened = await RemoteOperationJournal.open(join(f.root, 'operations.json'))
  closing.push(() => reopened.close())
  const host = new WorkerConversationHost({ ...f.ports, journal: reopened.conversations,
    observeSession: async (_binding, session) => {
      expect((await reopened.conversations.read(f.binding))?.session).toEqual(session)
      f.observed.sessions.push(session)
    } })
  closing.push(() => host.shutdown())
  fail = false
  const request = (input: Record<string, unknown>) => host.handle({ ...input, binding: f.binding }, f.connection)
  expect(receipt(await request(initial)).turns[0]?.status).toBe('rejected')
  expect(startup).toHaveBeenCalledOnce()
  await request({ ...initial, operationId: 'retry-operation', correlationId: 'retry-message' })
  await vi.waitFor(async () => expect((await reopened.conversations.read(f.binding))?.turns[1]?.status).toBe('completed'))
  expect(f.manager.prompts).toEqual(['Initial input'])
  expect(f.manager.creates).toBe(1)
})
