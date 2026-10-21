import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { PendingNativeInteractionSchema, type AgentHarness } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { NativeHistory, NativeHarnessSessionManager, NativeSessionStart } from '../harnesses/port.js'
import type { NativeLaunchObservation } from '../harnesses/recovery/processRegistry.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import { workerConversationProcessDigest } from './workerNativeOwner.js'
import { recoverWorkerConversation } from './recoverWorkerConversation.js'
import type { WorkerConversationAllocation } from './workerHost.js'
import type { WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import { createClaudeSdkRunner } from '../harnesses/claudeSdk/runner.js'
import { claudePromptUuid, createClaudeNativeSessionManager } from '../harnesses/claudeSdk/sessionManager.js'
import { ClaudeBoundedQueue } from '../harnesses/claudeSdk/queue.js'
import type { ClaudeSdkClient } from '../harnesses/claudeSdk/port.js'

/** Recorded native/process ports verify recovery behavior, not installed harness qualification. */
async function fixture(harness: AgentHarness = 'codex', kind: 'operator' | 'agent' = 'agent',
  options: { journalStatus?: 'completed' | 'uncertain'; appMcpAccess?: 'none' | 'scoped'; managedAccount?: boolean } = {}) {
  const f = workerConversationFixture(kind, harness)
  if (options.managedAccount && (harness === 'codex' || harness === 'claude')) {
    const accountId = randomUUID()
    f.binding.accountBinding = { kind: 'slot', accountId, provider: harness, profileRef: accountId, bindingRevision: 1,
      subject: null, target: { hostRef: { kind: 'device', mainId: f.connection.mainId, deviceId: f.connection.deviceId },
        applicationInstallationId: f.connection.workerInstallationId, keyRevision: f.connection.keyRevision,
        authorizationRevision: f.connection.authorizationRevision } }
    if (f.configuration.harness.harness === 'codex' || f.configuration.harness.harness === 'claude') {
      f.configuration.harness.accountId = accountId
      f.binding.owner.configurationHash = commandInputHash(f.configuration)
    }
  }
  if (options.appMcpAccess) f.binding.appMcpAccess = options.appMcpAccess
  const directory = await privateFixtureDirectory('worker-recovery-')
  const journal = await RemoteOperationJournal.open(join(directory, 'operations.json'), { initializeNewInstallation: true })
  const launch: NativeLaunchObservation = { owner: `conversation:${f.binding.owner.conversationId}`,
    launchId: randomUUID(), bootId: f.connection.bootId, lifecycle: 'closed', closureEvidence: 'cgroup_v2_empty',
    guardian: { pid: 11111, startTicks: '10' }, provider: { pid: 11112, startTicks: '11' },
    boundary: { kind: 'cgroup-v2', path: '/recorded/native-boundary', device: '1', inode: '2' } }
  const owner = { sessionId: f.session.nativeSessionId,
    processIdentityDigest: workerConversationProcessDigest(f.binding, launch) }
  const result = { outcome: 'succeeded' as const, output: { text: 'Remembered context' } }
  const submission = { kind: 'message' as const, nativeSessionId: f.session.nativeSessionId,
    nativeMessageId: harness === 'claude' ? claudePromptUuid('original-input') : 'native-message',
    clientCorrelationId: 'original-input' }
  await journal.conversations.receive(f.binding, f.connection)
  await journal.conversations.reserveCreation(f.binding, 'original-create', commandInputHash({ mode: 'create' }))
  await journal.conversations.bindSession(f.binding, f.session, owner)
  await journal.conversations.reserveTurn(f.binding, 'original-input', commandInputHash({ prompt: 'Remembered context' }))
  await journal.conversations.submitted(f.binding, 'original-input', harness === 'claude'
    ? { nativeSubmission: submission } : { nativeTurnId: 'native-turn' })
  await journal.conversations.finishTurn(f.binding, 'original-input', options.journalStatus === 'uncertain' ? undefined : result)
  const record = (await journal.conversations.read(f.binding))!
  const connection = { ...f.connection, bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 2 }
  const attach = vi.fn(async () => f.session)
  const observed: NativeHistory = { correlationId: 'original-input', events: [], pendingInteractions: [],
    ...(harness === 'claude' ? { nativeSubmission: submission } : { nativeTurnId: 'native-turn' }), terminalResult: result }
  const reconcile = vi.fn(async () => observed)
  const forbidden = async (): Promise<never> => { throw new Error('Recovery cannot submit a new model input') }
  const manager: NativeHarnessSessionManager = { harness, attachSession: attach, reconcile,
    capabilities: forbidden, inspectMcp: forbidden, createSession: forbidden,
    startTurn() { throw new Error('Recovery cannot submit a new model input') },
    pending: forbidden, respond: forbidden, cancel: forbidden, history: forbidden, close: forbidden }
  const start = vi.fn(async (): Promise<NativeSessionStart> => {
    const configuration = f.configuration
    if ('operatorId' in configuration) return { kind: 'operator', configuration,
      correlationId: 'original-create', workingDirectory: f.binding.workingDirectory }
    if (f.binding.owner.kind !== 'agent') throw new Error('Recorded Agent owner required')
    return { kind: 'agent-chat', configuration, conversationId: f.binding.owner.conversationId,
      workflowId: f.binding.owner.workflowId, workflowNodeId: f.binding.owner.workflowNodeId,
      correlationId: 'original-create', workingDirectory: f.binding.workingDirectory, instructionsDelivered: true }
  })
  const nextOwner = { sessionId: f.session.nativeSessionId, processIdentityDigest: 'd'.repeat(64) }
  const close = vi.fn(async () => {})
  const allocation: WorkerConversationAllocation = { manager, start, close, nativeOwner: async () => nextOwner }
  const allocate = vi.fn(async () => allocation)
  const closeOwner = vi.fn(async () => true)
  const assertCurrent = vi.fn(async () => {})
  const recover = (request: WorkerConversationRpcRequest = { method: 'conversation.open', binding: f.binding,
    configuration: f.configuration, operationId: 'original-create', mode: 'attach', source: f.session }) =>
    recoverWorkerConversation({ record, configuration: f.configuration, connection, request,
    registry: { snapshot: () => ({ revision: 'recorded-registry', launches: [launch] }), closeOwner },
    journal: journal.conversations, allocate, assertCurrent, signal: AbortSignal.timeout(1000) })
  return { ...f, record, connection, launch, owner, nextOwner, observed, result,
    attach, reconcile, start, close, allocate, closeOwner, assertCurrent, recover, allocation, journal,
    async cleanup() { await journal.close(); await rm(directory, { recursive: true, force: true }) } }
}

it('recovers a completed Claude result with a fresh SDK manager and matching native input history', async () => {
  const f = await fixture('claude')
  const frames = new ClaudeBoundedQueue<unknown>(2)
  const offered = vi.fn()
  const client: ClaudeSdkClient = {
    sdkVersion: '0.3.284',
    query(input) {
      void (async () => { for await (const message of input.prompt) offered(message) })()
      return {
        [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](),
        close: () => frames.close(),
        interrupt: async () => {},
        initializationResult: async () => ({}),
      }
    },
    getSessionInfo: async sessionId => ({ sessionId }),
    getSessionMessages: async () => [{ type: 'user', session_id: f.session.nativeSessionId,
      uuid: claudePromptUuid('original-input'), parent_tool_use_id: null }],
    forkSession: async () => { throw new Error('Recovery cannot fork') },
  }
  const manager = createClaudeNativeSessionManager({
    runner: createClaudeSdkRunner({ loadClient: async () => client }),
    scope: { deviceId: f.connection.deviceId, profilePath: '/recorded/profile',
      configRevision: '1', cwd: f.binding.workingDirectory },
    sdkOptions: {},
    qualification: { sdkVersion: '0.3.284', cliVersion: f.session.providerVersion,
      basicTurns: true, resume: true, fork: false, history: true },
  })
  f.allocation.manager = manager
  try {
    expect(await f.recover()).toBe(f.allocation)
    const saved = await f.journal.conversations.read(f.binding)
    expect(saved?.session).toEqual(f.session)
    expect(saved?.turns).toEqual(f.record.turns)
    expect(saved?.nativeOwner).toEqual(f.nextOwner)
    expect((await manager.reconcile(f.session, 'original-input')).terminalResult).toBeUndefined()
    expect(offered).not.toHaveBeenCalled()
  } finally {
    await manager.dispose?.()
    await f.cleanup()
  }
})

it.each(['unfinished', 'different-receipt', 'different-result', 'unconfirmed-close', 'changed-authority'] as const)(
  'refuses Claude receipt-only recovery with %s', async fault => {
    const f = await fixture('claude', 'agent', { journalStatus: fault === 'unfinished' ? 'uncertain' : 'completed' })
    delete f.observed.terminalResult
    try {
      if (fault === 'different-receipt') f.observed.nativeSubmission!.nativeMessageId = 'another-input'
      if (fault === 'different-result') f.observed.terminalResult = { outcome: 'succeeded', output: 'another-result' }
      if (fault === 'unconfirmed-close') delete (f.launch as { closureEvidence?: unknown }).closureEvidence
      if (fault === 'changed-authority') f.connection.authorizationRevision++
      await expect(f.recover()).rejects.toMatchObject({ code: 'WORKER_CONVERSATION_RECOVERY_REQUIRED' })
      expect((await f.journal.conversations.read(f.binding))?.nativeOwner).toEqual(f.owner)
    } finally { await f.cleanup() }
  },
)

for (const harness of ['codex', 'claude'] as const) {
  it.each(['none', 'scoped'] as const)(`${harness}: changes Operator App MCP access from %s on the same native session`, async previous => {
    const f = await fixture(harness, 'operator', { appMcpAccess: previous })
    const next = { ...f.binding, appMcpAccess: previous === 'none' ? 'scoped' as const : 'none' as const }
    try {
      const reserved = await f.journal.conversations.reserveApplicationAccess(f.binding, next, 'access-message', f.session)
      Object.assign(f.record, reserved.record)
      const access = next.appMcpAccess === 'scoped'
        ? { kind: 'operator-chat-mcp' as const, token: 'normally-issued-credential' } : undefined
      expect(await f.recover({ method: 'conversation.open', binding: next, previousBinding: f.binding,
        mode: 'attach', source: f.session, configuration: f.configuration, operationId: 'access-message',
        ...(access ? { applicationAccess: access } : {}) })).toBe(f.allocation)
      expect(f.start).toHaveBeenCalledWith({ correlationId: 'original-create', instructionsDelivered: true,
        ...(access ? { applicationAccess: access } : {}) })
      const saved = await f.journal.conversations.read(next)
      expect(saved?.session).toEqual(f.session)
      expect(saved?.turns).toEqual(f.record.turns)
      expect(saved?.nativeOwner).toEqual(f.nextOwner)
      expect(saved?.applicationAccessChange?.state).toBe('applied')
      expect(f.attach).toHaveBeenCalledOnce()
      expect(f.reconcile).toHaveBeenCalledOnce()
    } finally { await f.cleanup() }
  })
  it.each(['operator', 'agent'] as const)(`${harness}: reattaches the same settled %s chat after verified process closure`, async kind => {
    const f = await fixture(harness, kind)
    try {
      expect(await f.recover()).toBe(f.allocation)
      expect(f.attach).toHaveBeenCalledWith(f.session, expect.objectContaining({ correlationId: 'original-create' }), expect.any(AbortSignal))
      expect(f.start).toHaveBeenCalledWith({ correlationId: 'original-create', instructionsDelivered: true })
      expect(f.reconcile).toHaveBeenCalledWith(f.session, 'original-input', expect.any(AbortSignal))
      const saved = await f.journal.conversations.read(f.binding)
      expect(saved?.nativeOwner).toEqual(f.nextOwner)
      expect(saved?.session).toEqual(f.session)
      expect(saved?.connection).toEqual(f.connection)
      expect(saved?.turns).toEqual(f.record.turns)
      expect(f.close).not.toHaveBeenCalled()
      expect(f.assertCurrent).toHaveBeenCalledTimes(2)
    } finally { await f.cleanup() }
  })
}

it.each(['active-process', 'foreign-process', 'unacknowledged-turn', 'undispatched-compaction', 'revoked-device'] as const)(
  'refuses %s before allocating or stopping native work', async fault => {
    const f = await fixture()
    try {
      if (fault === 'active-process') Object.assign(f.launch, { lifecycle: 'active', closureEvidence: undefined })
      if (fault === 'foreign-process') Object.assign(f.launch, { provider: { pid: 22222, startTicks: '20' } })
      if (fault === 'unacknowledged-turn') Object.assign(f.record.turns[0]!, { status: 'uncertain', nativeTurnId: null })
      if (fault === 'undispatched-compaction') f.record.compactions.push({ inputHash: commandInputHash('compact'), state: {
        requestId: 'compact', nativeSessionId: f.session.nativeSessionId, nativeOperationId: null,
        status: 'uncertain', dispatchPhase: 'reserved', beforeTokens: null,
        observedAt: new Date().toISOString(), message: 'Pending native result',
      } })
      if (fault === 'revoked-device') f.connection.authorizationRevision++
      await expect(f.recover()).rejects.toMatchObject({ status: 409 })
      expect(f.allocate).not.toHaveBeenCalled()
      expect(f.closeOwner).not.toHaveBeenCalled()
      expect((await f.journal.conversations.read(f.binding))?.nativeOwner).toEqual(f.owner)
    } finally { await f.cleanup() }
  })

it.each(['foreign-session', 'missing-result', 'different-turn', 'pending-approval'] as const)(
  'closes only the new allocation after %s and keeps the original journal owner', async fault => {
    const f = await fixture()
    try {
      if (fault === 'foreign-session') f.attach.mockResolvedValueOnce({ ...f.session, nativeSessionId: randomUUID() })
      if (fault === 'missing-result') delete f.observed.terminalResult
      if (fault === 'different-turn') f.observed.nativeTurnId = 'different-turn'
      if (fault === 'pending-approval') f.observed.pendingInteractions = [PendingNativeInteractionSchema.parse({
        session: f.session, turn: { nativeTurnId: 'native-turn', nativeRequestId: 'approval' },
        nativeRequestType: 'command_approval', request: { command: 'recorded permission request' },
        responseOptions: [{ optionId: 'reject', semantic: 'reject', label: 'Reject', persistence: 'request',
          affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false }],
      })]
      await expect(f.recover()).rejects.toMatchObject({ status: 409 })
      expect(f.close).toHaveBeenCalledOnce()
      expect((await f.journal.conversations.read(f.binding))?.nativeOwner).toEqual(f.owner)
    } finally { await f.cleanup() }
  })

it('rechecks revoked Main authority before ownership persistence and closes the new allocation', async () => {
  const f = await fixture()
  try {
    f.assertCurrent.mockResolvedValueOnce().mockRejectedValueOnce(new Error('Original caller revoked'))
    await expect(f.recover()).rejects.toThrow('Original caller revoked')
    expect(f.close).toHaveBeenCalledOnce()
    expect((await f.journal.conversations.read(f.binding))?.nativeOwner).toEqual(f.owner)
  } finally { await f.cleanup() }
})

for (const harness of ['codex', 'claude'] as const) {
  it.each(['succeeded', 'failed'] as const)(`${harness}: saves an unrecorded native %s result without another input`, async outcome => {
    const f = await fixture(harness, 'agent', { journalStatus: 'uncertain' })
    const result = outcome === 'succeeded' ? f.result : {
      outcome, error: { code: 'NATIVE_TURN_FAILED', message: 'Recorded native failure', retryable: false },
    }
    f.observed.terminalResult = result
    try {
      expect(await f.recover()).toBe(f.allocation)
      const saved = await f.journal.conversations.read(f.binding)
      expect(saved?.turns).toEqual([{ ...f.record.turns[0], status: 'completed', result }])
      expect(saved?.nativeOwner).toEqual(f.nextOwner)
      expect(saved?.session).toEqual(f.session)
      expect(f.reconcile).toHaveBeenCalledOnce()
      expect(f.attach).toHaveBeenCalledOnce()
    } finally { await f.cleanup() }
  })
}

it.each(['missing-result', 'foreign-message', 'changed-sender'] as const)(
  'keeps an uncertain Claude turn fenced after %s', async fault => {
    const f = await fixture('claude', 'agent', { journalStatus: 'uncertain' })
    try {
      if (fault === 'missing-result') delete f.observed.terminalResult
      if (fault === 'foreign-message') f.observed.nativeSubmission = {
        ...f.observed.nativeSubmission!, nativeSessionId: 'foreign-session',
      }
      if (fault === 'changed-sender') f.assertCurrent.mockResolvedValueOnce()
        .mockRejectedValueOnce(new Error('Original sender revoked'))
      await expect(f.recover()).rejects.toThrow()
      const saved = await f.journal.conversations.read(f.binding)
      expect(saved?.turns[0]?.status).toBe('uncertain')
      expect(saved?.turns[0]?.result).toBeUndefined()
      expect(saved?.nativeOwner).toEqual(f.owner)
      expect(f.close).toHaveBeenCalledOnce()
    } finally { await f.cleanup() }
  })

it.each(['completed', 'failed', 'no-op'] as const)('recovers the dispatched native compact outcome %s by reading history', async status => {
  const f = await fixture()
  try {
    const reservation = await f.journal.conversations.reserveCompact(f.binding, 'original-compact', commandInputHash('compact'))
    const dispatched = { ...reservation.state, status: 'uncertain' as const, dispatchPhase: 'dispatched' as const,
      nativeOperationId: 'native-compact' }
    await f.journal.conversations.compactProgress(f.binding, dispatched)
    f.record.compactions = (await f.journal.conversations.read(f.binding))!.compactions
    const terminal = { ...dispatched, status, message: 'Native compact result' }
    const read = vi.fn(async () => terminal)
    f.allocation.manager.readCompaction = read
    expect(await f.recover()).toBe(f.allocation)
    expect(read).toHaveBeenCalledWith(f.session, expect.objectContaining({ correlationId: 'original-create' }),
      dispatched, expect.any(AbortSignal))
    const saved = await f.journal.conversations.read(f.binding)
    expect(saved?.compactions[0]?.state).toEqual(terminal)
    expect(saved?.nativeOwner).toEqual(f.nextOwner)
  } finally { await f.cleanup() }
})

it('refuses an unknown compact result without changing the native owner or dispatching again', async () => {
  const f = await fixture()
  try {
    const reservation = await f.journal.conversations.reserveCompact(f.binding, 'original-compact', commandInputHash('compact'))
    const dispatched = { ...reservation.state, status: 'uncertain' as const, dispatchPhase: 'dispatched' as const }
    await f.journal.conversations.compactProgress(f.binding, dispatched)
    f.record.compactions = (await f.journal.conversations.read(f.binding))!.compactions
    f.allocation.manager.readCompaction = async () => dispatched
    await expect(f.recover()).rejects.toMatchObject({ status: 409 })
    expect((await f.journal.conversations.read(f.binding))?.nativeOwner).toEqual(f.owner)
    expect((await f.journal.conversations.read(f.binding))?.compactions[0]?.state).toEqual(dispatched)
    expect(f.close).toHaveBeenCalledOnce()
  } finally { await f.cleanup() }
})


it.each(['codex', 'claude'] as const)('retains the accepted %s account during cold Worker recovery', async harness => {
  const f = await fixture(harness, 'agent', { managedAccount: true })
  try {
    expect(await f.recover()).toBe(f.allocation)
    const saved = await f.journal.conversations.read(f.binding)
    expect(saved?.binding.accountBinding).toEqual(f.record.binding.accountBinding)
    expect(saved?.session).toEqual(f.session)
    expect(f.attach).toHaveBeenCalledWith(f.session, expect.objectContaining({ configuration: f.configuration }), expect.anything())
    expect(f.allocate).toHaveBeenCalledTimes(1)
  } finally { await f.cleanup() }
})

it('keeps account-bound recovery blocked without positive original process closure', async () => {
  const f = await fixture('claude', 'agent', { managedAccount: true })
  delete (f.launch as { closureEvidence?: unknown }).closureEvidence
  try {
    await expect(f.recover()).rejects.toThrow('positively closed')
    expect(f.allocate).not.toHaveBeenCalled()
    expect((await f.journal.conversations.read(f.binding))?.binding.accountBinding).toEqual(f.binding.accountBinding)
  } finally { await f.cleanup() }
})

it('rejects another Worker account binding without replacement allocation', async () => {
  const f = await fixture('codex', 'agent', { managedAccount: true })
  const binding = structuredClone(f.binding)
  if (binding.accountBinding?.kind !== 'slot') throw new Error('Account fixture required')
  binding.accountBinding.accountId = randomUUID()
  try {
    await expect(f.recover({ method: 'conversation.open', binding, configuration: f.configuration,
      operationId: 'original-create', mode: 'attach', source: f.session })).rejects.toThrow('changed')
    expect(f.allocate).not.toHaveBeenCalled()
  } finally { await f.cleanup() }
})

it('does not invent terminal proof from account-bound Claude input receipts', async () => {
  const f = await fixture('claude', 'agent', { managedAccount: true, journalStatus: 'uncertain' })
  delete f.observed.terminalResult
  try {
    await expect(f.recover()).rejects.toMatchObject({ code: 'WORKER_CONVERSATION_RECOVERY_REQUIRED' })
    const saved = await f.journal.conversations.read(f.binding)
    expect(saved?.binding.accountBinding).toEqual(f.binding.accountBinding)
    expect(saved?.turns[0]?.status).toBe('uncertain')
  } finally { await f.cleanup() }
})

it('retains a matching completed Claude journal result for account-bound recovery', async () => {
  const f = await fixture('claude', 'agent', { managedAccount: true, journalStatus: 'completed' })
  delete f.observed.terminalResult
  try {
    expect(await f.recover()).toBe(f.allocation)
    const saved = await f.journal.conversations.read(f.binding)
    expect(saved?.turns[0]?.result).toEqual(f.result)
    expect(saved?.binding.accountBinding).toEqual(f.binding.accountBinding)
  } finally { await f.cleanup() }
})

it('attaches a cold scoped Operator as an observer when no management credential can be issued', async () => {
  const f = await fixture('codex', 'operator', { appMcpAccess: 'scoped' })
  try {
    expect(await f.recover()).toBe(f.allocation)
    expect(f.attach).toHaveBeenCalledWith(f.session, expect.objectContaining({
      kind: 'operator', observationOnly: true,
    }), expect.any(AbortSignal))
    expect((await f.journal.conversations.read(f.binding))?.session).toEqual(f.session)
  } finally { await f.cleanup() }
})
