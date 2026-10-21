import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { unavailableSessionControls, SessionPreferencesSchema } from '@foreman-code/contracts'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart } from '../harnesses/port.js'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { WorkerConversationHost } from './workerHost.js'
import { WorkerConversationManager } from './workerManager.js'
import { MainWorkerConversationBridge } from './workerBridge.js'
import { workerConversationCallbacks } from './workerCallbacks.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import { WorkerConversationRpcRequestSchema, type WorkerConversationRpcRequest,
  type WorkerConversationReceipt } from '@foreman-code/contracts/remote-execution-rpc'

it('reports confirmed runtime release when retirement finds that the Worker process exited', async () => {
  const f = workerConversationFixture('operator')
  const bridge = new MainWorkerConversationBridge()
  const receipt: WorkerConversationReceipt = { binding: f.binding, connection: f.connection,
    revision: 1, closed: false, closing: false, session: f.session, nativeOwner: f.nativeOwner,
    turns: [], compactions: [], desiredPreferences: null, appliedPreferences: null }
  const manager = new WorkerConversationManager({ binding: f.binding, configuration: f.configuration, bridge,
    current: async () => {}, channel: { binding: f.connection, request: async raw => {
      const request = WorkerConversationRpcRequestSchema.parse(raw)
      return { payload: { receipt: { ...receipt,
        ...(request.method === 'conversation.retire-turn' ? { runtimeReleased: true } : {}) } } }
    } } })
  try {
    await manager.attachSession(f.session, { kind: 'operator', configuration: f.configuration as
      Extract<NativeSessionStart, { kind: 'operator' }>['configuration'], workingDirectory: f.binding.workingDirectory,
      correlationId: 'attached-turn' })
    await expect(manager.retireTurn(f.session, 'saved-turn')).resolves.toEqual({ runtimeReleased: true })
  } finally { await manager.dispose(); await bridge.close() }
})

it.each(['codex', 'claude'] as const)('rebinds the next %s credential through the existing Worker owner without creation', async harness => {
  const f = workerConversationFixture('operator', harness)
  if (!('operatorId' in f.configuration)) throw new Error('Operator fixture required')
  const binding = { ...f.binding, appMcpAccess: 'scoped' as const }
  const requests: WorkerConversationRpcRequest[] = []
  const bridge = new MainWorkerConversationBridge()
  const receipt: WorkerConversationReceipt = { binding, connection: f.connection,
    revision: 1, closed: false, closing: false, session: f.session, nativeOwner: f.nativeOwner,
    turns: [], compactions: [], desiredPreferences: null, appliedPreferences: null }
  const manager = new WorkerConversationManager({ binding, configuration: f.configuration, bridge,
    current: async () => {}, channel: { binding: f.connection, request: async raw => {
      const request = WorkerConversationRpcRequestSchema.parse(raw)
      requests.push(request)
      return { payload: request.method === 'conversation.refresh-mcp' ? { acknowledged: true } : { receipt } }
    } } })
  const start: NativeSessionStart = { kind: 'operator', configuration: f.configuration,
    workingDirectory: binding.workingDirectory, correlationId: 'first',
    environment: { agentId: f.configuration.operatorId, variables: { FOREMAN_CODE_MCP_TOKEN: 'first-token' } } }
  try {
    await manager.attachSession(f.session, start)
    const before = requests.length
    await manager.rebindApplicationAccess(f.session, { ...start, correlationId: 'second',
      environment: { agentId: f.configuration.operatorId, variables: { FOREMAN_CODE_MCP_TOKEN: 'second-token' } } })
    expect(requests.slice(before)).toHaveLength(1)
    expect(requests.at(-1)).toMatchObject({
      method: harness === 'codex' ? 'conversation.open' : 'conversation.refresh-mcp',
      binding, applicationAccess: { kind: 'operator-chat-mcp', token: 'second-token' },
    })
    expect(requests.filter(request => request.method === 'conversation.open').every(request => request.mode === 'attach')).toBe(true)
  } finally { await manager.dispose(); await bridge.close() }
})

it('requests incremental events and cancels the outstanding read without idle polling', async () => {
  const f = workerConversationFixture()
  const bridge = new MainWorkerConversationBridge()
  const controller = new AbortController()
  const requests: Array<{ afterSequence: number | undefined; waitForEvents: boolean | undefined }> = []
  let started!: () => void
  const waiting = new Promise<void>(resolve => { started = resolve })
  const receipt: WorkerConversationReceipt = { binding: f.binding, connection: f.connection,
    revision: 1, closed: false, closing: false, session: f.session, nativeOwner: f.nativeOwner,
    turns: [], compactions: [], desiredPreferences: null, appliedPreferences: null }
  const manager = new WorkerConversationManager({ binding: f.binding, configuration: f.configuration,
    bridge, current: async () => {}, channel: { binding: f.connection, request: async (raw, options) => {
      const request = raw as WorkerConversationRpcRequest
      if (request.method === 'conversation.history' && request.correlationId) {
        requests.push({ afterSequence: request.afterSequence, waitForEvents: request.waitForEvents })
        started()
        await new Promise<void>(resolve => {
          if (options?.signal?.aborted) resolve()
          else options?.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      }
      return { payload: request.method === 'conversation.history'
        ? { receipt, context: null, history: { events: [], pendingInteractions: [], nextSequence: 6 } }
        : { receipt } }
    } } })
  await manager.attachSession(f.session, { kind: 'operator',
    configuration: f.configuration as Extract<NativeSessionStart, { kind: 'operator' }>['configuration'],
    workingDirectory: f.binding.workingDirectory, correlationId: 'stream' })
  const reading = (async () => {
    for await (const event of manager.startTurn(f.session,
      { prompt: 'Continue', clientCorrelationId: 'stream' }, controller.signal)) void event
  })().catch(error => { if (!controller.signal.aborted) throw error })
  try {
    await waiting
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(requests).toEqual([{ afterSequence: 5, waitForEvents: true }])
  } finally {
    controller.abort()
    await reading
    await manager.dispose()
    await bridge.close()
  }
})

it.each(['codex', 'claude'] as const)('carries the pinned %s Agent prompt across the worker channel and rejects replacements', async harness => {
  const f = workerConversationFixture('agent', harness)
  if (!('agentId' in f.configuration) || f.binding.owner.kind !== 'agent') throw new Error('Agent fixture required')
  const systemPrompt = { value: { text: 'Original app instructions' }, revision: 3, versionId: 'prompt-version-3' }
  const binding = { ...f.binding, systemPrompt }
  const requests: WorkerConversationRpcRequest[] = []
  const bridge = new MainWorkerConversationBridge()
  const manager = new WorkerConversationManager({ binding, configuration: f.configuration, bridge,
    current: async () => {}, channel: { binding: f.connection, request: async payload => {
      requests.push(WorkerConversationRpcRequestSchema.parse(payload))
      return { payload: { receipt: { binding, connection: f.connection, session: f.session,
        nativeOwner: f.nativeOwner, revision: requests.length, closed: false, closing: false,
        turns: [], compactions: [], desiredPreferences: null, appliedPreferences: null } } }
    } } })
  const start: NativeSessionStart = { kind: 'agent-chat', configuration: f.configuration,
    conversationId: f.binding.owner.conversationId, workflowId: f.binding.owner.workflowId,
    workflowNodeId: f.binding.owner.workflowNodeId, workingDirectory: f.binding.workingDirectory,
    systemPrompt, correlationId: 'first-message' }
  try {
    expect(await manager.attachSession(f.session, start)).toEqual(f.session)
    expect(requests).toMatchObject([{ method: 'conversation.open', mode: 'attach', binding: { systemPrompt } }])
    await expect(manager.attachSession(f.session, { ...start,
      systemPrompt: { ...systemPrompt, revision: 4 } })).rejects.toMatchObject({ code: 'WORKER_CONVERSATION_CONFLICT' })
    const missing = { ...start }
    delete missing.systemPrompt
    await expect(manager.attachSession(f.session, missing)).rejects.toMatchObject({ code: 'WORKER_CONVERSATION_CONFLICT' })
    expect(requests).toHaveLength(1)
  } finally {
    await manager.dispose()
    await bridge.close()
  }
})

it.each(['same-owner', 'foreign-session', 'foreign-owner'] as const)(
  'handles an overtaken controls receipt without accepting %s identity changes', async variant => {
    const f = workerConversationFixture()
    if (!('operatorId' in f.configuration)) throw new Error('Operator fixture required')
    const bridge = new MainWorkerConversationBridge()
    let latest: WorkerConversationReceipt = { binding: f.binding, connection: f.connection,
      revision: 1, closed: false, closing: false, session: f.session, nativeOwner: f.nativeOwner,
      turns: [], compactions: [], desiredPreferences: null, appliedPreferences: null }
    let releaseRead!: () => void
    let startedRead!: () => void
    const gate = new Promise<void>(resolve => { releaseRead = resolve })
    const started = new Promise<void>(resolve => { startedRead = resolve })
    const desired = SessionPreferencesSchema.parse({ contextBudget: 3200 })
    const manager = new WorkerConversationManager({ binding: f.binding, configuration: f.configuration, bridge,
      current: async () => {}, channel: { binding: f.connection, request: async payload => {
        const request = WorkerConversationRpcRequestSchema.parse(payload)
        if (request.method === 'conversation.controls-read') {
          const older = structuredClone(latest)
          if (variant === 'foreign-session') older.session = { ...f.session, nativeSessionId: 'foreign-session' }
          if (variant === 'foreign-owner') older.nativeOwner = { ...f.nativeOwner, processIdentityDigest: 'c'.repeat(64) }
          startedRead()
          await gate
          return { payload: { receipt: older, capabilities: unavailableSessionControls('recorded-controls'),
            context: null, preferences: null } }
        }
        if (request.method === 'conversation.preferences') {
          latest = { ...latest, revision: latest.revision + 1, desiredPreferences: desired, appliedPreferences: desired }
        }
        if (request.method === 'conversation.close') latest = { ...latest, revision: latest.revision + 1, closed: true }
        return { payload: { receipt: structuredClone(latest) } }
      } } })
    try {
      await manager.createSession({ kind: 'operator', configuration: f.configuration,
        correlationId: 'seed', workingDirectory: f.binding.workingDirectory })
      const reading = manager.sessionControlCapabilities(f.session)
      const result = reading.then(value => ({ value }), error => ({ error }))
      await started
      await manager.applySessionPreferences(f.session, desired)
      releaseRead()
      const completed = await result
      if (variant === 'same-owner') expect(completed).toHaveProperty('value')
      else expect(completed).toMatchObject({ error: { code: 'WORKER_CONVERSATION_CONFLICT' } })
      expect(manager.appliedSessionPreferences(f.session)).toEqual(desired)
    } finally {
      releaseRead()
      await manager.dispose()
      await bridge.close()
    }
  })

it('carries Plan and context through the issued-request bridge without creating a Run or another session', async () => {
  const f = workerConversationFixture()
  if (!('operatorId' in f.configuration)) throw new Error('Operator fixture required')
  const configuration = f.configuration
  const root = await mkdtemp(join(tmpdir(), 'worker-manager-'))
  const journal = await RemoteOperationJournal.open(join(root, 'operations.json'), { initializeNewInstallation: true })
  const bridge = new MainWorkerConversationBridge()
  const histories = new Map<string, NativeHistory>()
  const modes: Array<string | undefined> = []
  const acknowledgments: string[] = []
  const responseReads: unknown[] = []
  let creates = 0
  let allowed = true
  const native: NativeHarnessSessionManager = {
    harness: 'codex', capabilities: async () => { throw new Error('Unused native discovery') },
    inspectMcp: async () => { throw new Error('Unused native MCP inspection') },
    createSession: async () => { creates++; return f.session }, attachSession: async () => f.session,
    async *startTurn(_session, input) {
      modes.push(input.sessionMode)
      await input.onSubmitted?.(`observed-turn-${modes.length}`)
      await input.onSettingsApplied?.()
      const event = { sequence: modes.length, type: 'turn.completed', occurredAt: '2026-10-05T00:00:00.000Z', payload: {} }
      const result = { outcome: 'succeeded' as const, output: { text: input.prompt } }
      histories.set(input.clientCorrelationId, { events: [event], pendingInteractions: [],
        correlationId: input.clientCorrelationId, nextSequence: modes.length + 1,
        terminalTurn: { correlationId: input.clientCorrelationId, providerId: `observed-turn-${modes.length}`, result },
        terminalResult: result })
      yield event
    },
    pending: async () => undefined, respond: async () => {}, cancel: async () => true, close: async () => {},
    history: async () => [...histories.values()].at(-1) ?? { events: [], pendingInteractions: [], nextSequence: 1 },
    reconcile: async (_session, correlationId) => histories.get(correlationId) ?? { events: [], pendingInteractions: [] },
    reconcileResponse: async (_session, response) => {
      responseReads.push(response)
      return { events: [], pendingInteractions: [], responseDeliveries: [{ source: 'provider_history',
        harness: 'codex', providerVersion: f.session.providerVersion, nativeSessionId: f.session.nativeSessionId,
        nativeRequestId: response.nativeRequestId, nativeRequestType: response.nativeRequestType,
        optionId: response.option.optionId, semantic: response.option.semantic }] }
    },
    inspectResponseAvailability: async (_session, query) => ({ nativeSessionId: f.session.nativeSessionId,
      nativeRequestId: query.nativeRequestId, nativeRequestType: query.nativeRequestType,
      nativeTurnId: 'observed-turn-2', generation: 'provider-callback-generation', qualified: true,
      state: 'available', path: 'live_callback', reason: 'live_callback' }),
    sessionControlCapabilities: async () => unavailableSessionControls('non-qualifying-provider-fixture'),
    contextSnapshot: () => ({ nativeSessionId: f.session.nativeSessionId, model: 'fixture-model', generation: 'fixture',
      sequence: 1, observedAt: '2026-10-05T00:00:00.000Z', source: 'codex', accuracy: 'native',
      usedTokens: 80, capacityTokens: 1000, lifetimeTokens: 640, cost: null, stale: false }),
    appliedSessionPreferences: () => SessionPreferencesSchema.parse({}),
  }
  const callbacks = workerConversationCallbacks({ currentBinding: () => f.connection,
    capture: () => ({ binding: f.connection, request: async payload => ({
      payload: await bridge.handle(payload, f.connection, AbortSignal.timeout(1000)),
    }) }) })
  const host = new WorkerConversationHost({ ...callbacks, journal: journal.conversations, currentBinding: () => f.connection,
    allocate: async () => ({ manager: native,
      start: async ({ correlationId }) => ({ kind: 'operator', configuration, correlationId, workingDirectory: f.binding.workingDirectory }),
      nativeOwner: async () => f.nativeOwner, close: async () => {} }) })
  const manager = new WorkerConversationManager({ binding: f.binding, configuration, bridge,
    channel: { binding: f.connection, request: async payload => ({ payload: await host.handle(payload, f.connection) }) },
    current: async () => { if (!allowed) throw new Error('Current principal denied') } })
  const start: NativeSessionStart = { kind: 'operator', correlationId: 'first-message',
    configuration, workingDirectory: f.binding.workingDirectory }
  try {
    const session = await manager.createSession(start)
    expect(session).toEqual(f.session)
    const events = []
    for await (const event of manager.startTurn(session, { prompt: 'Planned task', clientCorrelationId: 'planned', sessionMode: 'plan',
      onSubmitted: async id => { acknowledgments.push(id) } })) events.push(event)
    expect(modes).toEqual(['plan'])
    expect(acknowledgments).toEqual(['observed-turn-1'])
    expect(events.map(event => event.sequence)).toEqual([1])
    for await (const event of manager.startTurn(session, { prompt: 'Regular task', clientCorrelationId: 'regular', sessionMode: 'regular' })) {
      expect(event.sequence).toBe(2)
    }
    expect(creates).toBe(1)
    expect(modes).toEqual(['plan', 'regular'])
    await manager.sessionControlCapabilities(session)
    expect(manager.contextSnapshot(session)).toMatchObject({ usedTokens: 80, lifetimeTokens: 640 })
    const query = { nativeRequestId: 'native-request', nativeRequestType: 'approval', expectedNativeTurnId: 'observed-turn-2' }
    expect(await manager.inspectResponseAvailability(session, query)).toMatchObject({ state: 'available', qualified: true })
    expect(await manager.inspectResponseAvailability(session, { ...query, expectedNativeTurnId: 'other-turn' }))
      .toMatchObject({ state: 'unavailable', reason: 'identity_mismatch' })
    const response = { nativeRequestId: query.nativeRequestId, nativeRequestType: query.nativeRequestType,
      option: { optionId: 'approve-once', label: 'Approve once', semantic: 'approve_once' as const,
        persistence: 'request' as const, affectsOtherPendingRequests: false,
        interruptsCurrentTurn: false, mutatesPersistentPolicy: false } }
    expect((await manager.reconcileResponse(session, response)).responseDeliveries)
      .toMatchObject([{ nativeSessionId: session.nativeSessionId, nativeRequestId: query.nativeRequestId,
        optionId: response.option.optionId, semantic: response.option.semantic }])
    expect(responseReads).toEqual([response])
    allowed = false
    await expect(manager.cancel(session)).rejects.toThrow('Current principal denied')
    allowed = true
    await manager.closeForRestart(session)
    expect((await journal.conversations.read(f.binding))?.closed).toBe(false)
  } finally {
    await manager.dispose()
    await bridge.close()
    await host.shutdown()
    await journal.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('maps the admitted Main startup directory to the actual selected worker directory', async () => {
  const f = workerConversationFixture()
  if (!('operatorId' in f.configuration)) throw new Error('Operator fixture required')
  const bridge = new MainWorkerConversationBridge()
  const requests: unknown[] = []
  const manager = new WorkerConversationManager({ binding: f.binding, configuration: f.configuration,
    sourceWorkingDirectory: '/main/operator', bridge, current: async () => {},
    channel: { binding: f.connection, request: async request => {
      requests.push(request)
      return { payload: { receipt: { binding: f.binding, connection: f.connection,
        revision: 1, closed: false, closing: false, session: f.session, nativeOwner: f.nativeOwner,
        turns: [], compactions: [], desiredPreferences: null, appliedPreferences: null } } }
    } } })
  const start: NativeSessionStart = { kind: 'operator', configuration: f.configuration,
    workingDirectory: '/main/operator', correlationId: 'first-message' }
  try {
    expect(await manager.mcpInspectionContext()).toEqual({ runnerId: `device:${f.connection.deviceId}`,
      workingDirectory: f.binding.workingDirectory })
    expect(await manager.createSession(start)).toEqual(f.session)
    expect(requests).toMatchObject([{ method: 'conversation.open', binding: { workingDirectory: f.binding.workingDirectory } }])
    await expect(manager.createSession({ ...start, workingDirectory: '/foreign/startup' }))
      .rejects.toThrow('startup differs')
    expect(requests).toHaveLength(1)
  } finally { await manager.dispose(); await bridge.close() }
})

it('retains a pre-message credential admission until the prepared owner is disposed', async () => {
  const f = workerConversationFixture('operator', 'claude')
  const configuration = f.configuration
  const binding = { ...f.binding, appMcpAccess: 'scoped' as const }
  const bridge = new MainWorkerConversationBridge()
  const requests: WorkerConversationRpcRequest[] = []
  const manager = new WorkerConversationManager({ binding, configuration, bridge,
    current: async () => {}, channel: { binding: f.connection, request: async payload => {
      requests.push(payload as WorkerConversationRpcRequest)
      return { payload: { acknowledged: true } }
    } } })
  await manager.deliverClaudeCredential('recorded-scoped-token', AbortSignal.timeout(1000))
  const request = requests[0]!
  const callback = { method: 'conversation.authorize', binding, admissionId: request.admissionId, request }
  expect(await bridge.handle(callback, f.connection, AbortSignal.timeout(1000))).toEqual({ authorized: true })
  await manager.dispose()
  expect(requests.map(value => value.method)).toEqual(['conversation.refresh-mcp', 'conversation.release-preparation'])
  await expect(bridge.handle(callback, f.connection, AbortSignal.timeout(1000))).rejects.toMatchObject({ status: 403 })
  await bridge.close()
})

it('retains recovered callback admission until native settlement and rechecks revoked grants', async () => {
  const f = workerConversationFixture('agent', 'claude')
  if (!('agentId' in f.configuration) || f.binding.owner.kind !== 'agent') throw new Error('Agent fixture required')
  const correlationId = 'already-submitted-message'
  const submission = { kind: 'message' as const, nativeSessionId: f.session.nativeSessionId,
    nativeMessageId: 'original-native-message', clientCorrelationId: correlationId }
  const receipt: WorkerConversationReceipt = { binding: f.binding, connection: f.connection,
    revision: 1, closed: false, closing: false, session: f.session, nativeOwner: f.nativeOwner,
    turns: [{ correlationId, inputHash: commandInputHash({ prompt: 'Accepted task', mode: 'regular', preferences: null }),
      status: 'submitted', nativeTurnId: null,
      nativeSubmission: submission }], compactions: [], desiredPreferences: null, appliedPreferences: null }
  const bridge = new MainWorkerConversationBridge()
  const requests: WorkerConversationRpcRequest[] = []
  let allowed = true
  const manager = new WorkerConversationManager({ binding: f.binding, configuration: f.configuration, bridge,
    current: async () => { if (!allowed) throw new Error('Current grant revoked') },
    claudeAuthority: async () => ({ authorized: true }),
    channel: { binding: f.connection, request: async payload => {
      const request = WorkerConversationRpcRequestSchema.parse(payload)
      requests.push(request)
      return { payload: request.method === 'conversation.open' ? { receipt }
        : { receipt, context: null, history: { events: [], pendingInteractions: [] } } }
    } } })
  try {
    await manager.attachSession(f.session, { kind: 'agent-chat', configuration: f.configuration,
      conversationId: f.binding.owner.conversationId, workflowId: f.binding.owner.workflowId,
      workflowNodeId: f.binding.owner.workflowNodeId, workingDirectory: f.binding.workingDirectory,
      correlationId, instructionsDelivered: true })
    await manager.respond(f.session, 'original-tool-request', { optionId: 'allow_once', label: 'Allow once',
      semantic: 'approve_once', persistence: 'request', affectsOtherPendingRequests: false,
      interruptsCurrentTurn: false, mutatesPersistentPolicy: false })
    const recovery = requests.at(-2)!
    const callback = { method: 'conversation.claude-authority', binding: f.binding,
      admissionId: recovery.admissionId, request: { phase: 'validate', identity: {
        ownerPrincipalId: 'original-sender', attemptId: 'original-request',
        nativeSessionId: f.session.nativeSessionId, nativeMessageId: submission.nativeMessageId,
        clientCorrelationId: correlationId, generation: 'original-query', toolUseId: 'original-tool',
      } } }
    expect(await bridge.handle(callback, f.connection, AbortSignal.timeout(1000))).toEqual({ authorized: true })
    allowed = false
    await expect(bridge.handle(callback, f.connection, AbortSignal.timeout(1000)))
      .rejects.toThrow('Current grant revoked')
    allowed = true
    receipt.turns[0]!.status = 'completed'
    receipt.turns[0]!.result = { outcome: 'succeeded' }
    receipt.revision++
    await manager.reconcile(f.session, correlationId)
    await expect(bridge.handle(callback, f.connection, AbortSignal.timeout(1000)))
      .rejects.toMatchObject({ status: 403 })
    expect(requests.map(request => request.method)).toEqual([
      'conversation.open', 'conversation.reconcile', 'conversation.respond', 'conversation.reconcile',
    ])
  } finally { await manager.dispose(); await bridge.close() }
})


it.each(['recorded', 'missing', 'foreign-session', 'broken-chain'] as const)(
  'accepts a replacement owner only with a valid persisted transition: %s', async variant => {
    const f = workerConversationFixture('operator', 'claude')
    const previous = f.nativeOwner
    const next = { ...previous, processIdentityDigest: 'c'.repeat(64) }
    let record: WorkerConversationReceipt = { binding: f.binding, connection: f.connection,
      revision: 1, closed: false, closing: false, session: f.session, nativeOwner: previous,
      turns: [], compactions: [], desiredPreferences: null, appliedPreferences: null }
    const older = structuredClone(record)
    let readOlder = false
    const bridge = new MainWorkerConversationBridge()
    const manager = new WorkerConversationManager({ binding: f.binding, configuration: f.configuration, bridge,
      current: async () => {}, channel: { binding: f.connection, request: async payload => {
        const request = WorkerConversationRpcRequestSchema.parse(payload)
        if (request.method === 'conversation.preferences') {
          const transition = variant === 'broken-chain' ? { ...previous, processIdentityDigest: 'd'.repeat(64) } : previous
          record = { ...record, revision: 2, nativeOwner: next,
            ...(variant === 'missing' ? {} : { ownerTransitions: [{ previous: transition, next }] }),
            ...(variant === 'foreign-session' ? { session: { ...f.session, nativeSessionId: 'foreign' } } : {}),
            appliedPreferences: request.preferences, desiredPreferences: request.preferences }
        }
        if (request.method === 'conversation.controls-read') return { payload: { receipt: readOlder ? older : record,
          capabilities: unavailableSessionControls('recorded'), context: null, preferences: record.appliedPreferences } }
        return { payload: { receipt: record } }
      } } })
    try {
      await manager.attachSession(f.session, { kind: 'operator', configuration: f.configuration as
        Extract<NativeSessionStart, { kind: 'operator' }>['configuration'],
        correlationId: 'recorded', workingDirectory: f.binding.workingDirectory })
      const applying = manager.applySessionPreferences(f.session, SessionPreferencesSchema.parse({ autoCompact: 'off' }))
      if (variant === 'recorded') {
        await applying
        readOlder = true
        await expect(manager.sessionControlCapabilities(f.session)).resolves.toBeTruthy()
        expect(manager.appliedSessionPreferences(f.session)?.autoCompact).toBe('off')
      } else {
        await expect(applying).rejects.toMatchObject({ code: 'WORKER_CONVERSATION_CONFLICT' })
        await expect(manager.dispose()).rejects.toMatchObject({ code: 'WORKER_CONVERSATION_CONFLICT' })
      }
    } finally {
      try {
        if (variant === 'recorded') await manager.dispose()
        else await expect(manager.dispose()).rejects.toMatchObject({ code: 'WORKER_CONVERSATION_CONFLICT' })
      } finally { await bridge.close() }
    }
  },
)
