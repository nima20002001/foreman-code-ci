import { createHash, randomUUID } from 'node:crypto'
import { beforeEach, expect, it, vi } from 'vitest'
import { AgentConfigurationVersionSchema, type ExecutionResult, type NativeSessionReference } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { WorkerConversationReceipt, WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeHistory, NativeSessionStart } from '../harnesses/port.js'
import type { NativeLaunchObservation, NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
import type { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { createInstalledWorkerConversations } from './installedWorkerConversations.js'
import { MainWorkerConversationBridge } from './workerBridge.js'
import { WorkerConversationJournal } from './workerJournal.js'
import { WorkerConversationManager } from './workerManager.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'

const provider = vi.hoisted(() => ({
  session: { harness: 'codex' as const, providerVersion: 'fixture-codex', nativeSessionId: 'original-session' } as NativeSessionReference,
  starts: [] as NativeSessionStart[],
  history: { events: [], pendingInteractions: [] } as NativeHistory,
  creates: 0,
}))
vi.mock('../runs/remote/installedWorkflowConfiguration.js', () => ({
  readInstalledWorkflowConfiguration: async () => ({}),
}))
vi.mock('./installedConversationDirectory.js', () => ({
  installedConversationDirectory: async () => ({ assertCurrent: async () => {} }),
}))
vi.mock('./installedNativeProfile.js', () => ({
  createInstalledConversationNativeReader: () => ({ repository: {}, capture: async () => ({
    inspection: { installation: { launcher: { resolvedLauncher: '/fixture/codex' } } },
    qualification: { version: 'fixture-codex' },
  }) }),
}))
vi.mock('./installedClaudeConversationProfile.js', () => ({
  createInstalledClaudeConversationProfile: () => ({ capture: async () => ({
    installation: { launcher: { resolvedLauncher: '/fixture/claude' } }, sdk: { entrypoint: '/fixture/sdk' },
    accepted: { currentBinding: { pin: { sdkVersion: '0.3.284', cliVersion: '2.1.284', configRevision: 'fixture' } } },
  }) }),
}))
vi.mock('../harnesses/claudeSdk/configuration.js', () => ({
  compileClaudeConfiguration: (configuration: unknown) => ({ configuration, mcpServers: {}, env: {},
    qualification: { basicTurns: true, resume: true, history: true, policy: { alwaysAppliedToolHook: true } } }),
}))
vi.mock('../harnesses/claudeSdk/official.js', () => ({ loadInstalledClaudeSdk: async () => ({}) }))
vi.mock('./workerClaudeFiles.js', () => ({ createWorkerClaudeFiles: () => undefined }))
vi.mock('../harnesses/claudeSdk/composition.js', () => ({ allocateClaudeNativeHarness: () => ({ manager: {
  harness: 'claude', createSession: async () => { provider.creates++; return provider.session },
  attachSession: async (session: NativeSessionReference, start: NativeSessionStart) => { provider.starts.push(start); return session },
  history: async () => structuredClone(provider.history), reconcile: async () => structuredClone(provider.history),
  pending: async () => undefined, cancel: async () => false, dispose: async () => {},
  notifyPendingChanged: () => {},
  startInitialTurn() { throw new Error('Recovery must not replay the first input') },
  startTurn() { throw new Error('Recovery must not replay input') },
} }) }))
// Only provider IO and installation qualification are replaced; host, callbacks, journal and recovery are real.
vi.mock('../harnesses/codexAppServer.js', async importOriginal => ({
  ...await importOriginal<typeof import('../harnesses/codexAppServer.js')>(),
  CodexAppServerSessionManager: class {
    readonly harness = 'codex'
    async createSession() { provider.creates++; return provider.session }
    async attachSession(session: typeof provider.session, start: NativeSessionStart) {
      provider.starts.push(start)
      return session
    }
    async history() { return structuredClone(provider.history) }
    async reconcile() { return structuredClone(provider.history) }
    async pending() { return undefined }
    async cancel() { return false }
    async dispose() {}
  },
}))
beforeEach(() => {
  provider.starts.length = 0
  provider.creates = 0
  provider.history = { events: [], pendingInteractions: [], correlationId: 'unfinished', nativeTurnId: 'native-turn',
    terminalResult: { outcome: 'succeeded', output: 'Saved native answer' } }
})

async function fixture(harness: 'codex' | 'claude' = 'codex') {
  const f = workerConversationFixture('agent', harness)
  let connection = f.connection
  provider.session.harness = harness
  if (harness === 'claude') {
    delete provider.history.nativeTurnId
    provider.history.nativeSubmission = { kind: 'message', nativeSessionId: provider.session.nativeSessionId,
      nativeMessageId: 'native-message', clientCorrelationId: 'unfinished' }
  }
  const base = AgentConfigurationVersionSchema.parse(f.configuration)
  const instructions = 'Use the node skill.'
  const configuration = { ...base, assignedSkills: [{ skillId: 'node-skill', version: '1' }],
    resolvedSkills: [{ skillId: 'node-skill', version: '1', instructions,
      contentHash: `sha256:${createHash('sha256').update(instructions).digest('hex')}` }] }
  const binding = { ...f.binding, owner: { ...f.binding.owner, configurationHash: commandInputHash(configuration) } }
  const records: WorkerConversationReceipt[] = []
  const journal = new WorkerConversationJournal({ read: async () => structuredClone(records),
    change: async (_id, apply) => structuredClone(apply(records)) }, 8)
  const launches: NativeLaunchObservation[] = []
  let archived = false
  let closureConfirmed = true
  const closeOwner = vi.fn(async (owner: string) => {
    if (!closureConfirmed) return false
    for (const [index, launch] of launches.entries()) {
      if (launch.owner === owner) launches[index] = { ...launch, lifecycle: 'closed', closureEvidence: 'cgroup_v2_empty' }
    }
    return true
  })
  const registry = {
    scope: (owner: string) => ({ owner, root: '/fixture/native-processes' }),
    reserveLaunch: async (owner: string) => {
      const launch: NativeLaunchObservation = { owner, launchId: randomUUID(), bootId: connection.bootId,
        lifecycle: 'active', guardian: { pid: 11111, startTicks: '10' }, provider: { pid: 11112, startTicks: '11' },
        boundary: { kind: 'cgroup-v2', path: '/fixture/native-boundary', device: '1', inode: '2' } }
      launches.push(launch)
      return { launchId: launch.launchId }
    },
    snapshot: () => ({ revision: 'fixture', launches: archived ? [] : launches }),
    closedRegistration: (owner: string, id?: string) => launches.findLast(launch => launch.owner === owner
      && (!id || launch.launchId === id) && launch.lifecycle === 'closed'),
    closeOwner, abandonReservedLaunch: async () => {},
  } as unknown as NativeProcessRegistry
  const bridge = new MainWorkerConversationBridge()
  const signal = new AbortController().signal
  const createHost = async () => {
    const value = await createInstalledWorkerConversations({ stateDirectory: '/fixture/worker-state', configuration: null,
      registry, journal: async () => ({ conversations: journal }) as unknown as RemoteOperationJournal,
      current: () => connection,
      capture: () => ({ binding: connection, request: async raw => ({ payload: await bridge.handle(raw, connection, signal) }) }),
      request: async () => { throw new Error('Recovery cannot use an application credential') },
      approvedRoots: async () => { throw new Error('Directory admission is supplied by this fixture') },
      codexSuiteRevision: 'fixture-suite', signal })
    if (!value) throw new Error('Installed conversation host required')
    return value
  }
  let host = await createHost()
  const channel = () => {
    const captured = connection
    return { binding: captured, request: async (raw: unknown) => ({ payload: await host.handle(raw, captured, signal) }) }
  }
  const request = async (input: WorkerConversationRpcRequest) => {
    const lease = bridge.capture({ request: input, current: async () => {},
      callbacks: { sessionObserved: async session => { expect(session).toEqual(provider.session) } }, channel: channel() })
    try { return await lease.request() } finally { await lease.close() }
  }
  await request({ method: 'conversation.open', binding: f.binding, configuration: base,
    mode: 'create', operationId: 'original-create' })
  await journal.reserveTurn(f.binding, 'unfinished', commandInputHash('original-input'))
  await journal.submitted(f.binding, 'unfinished', harness === 'codex'
    ? { nativeTurnId: 'native-turn' } : { nativeSubmission: provider.history.nativeSubmission! })
  await journal.finishTurn(f.binding, 'unfinished')
  launches[0] = { ...launches[0]!, lifecycle: 'ended' }
  const attach = () => request({ method: 'conversation.open', binding: f.binding, configuration: base,
    mode: 'attach', source: provider.session, operationId: 'reconnect' })
  const transition = () => request({ method: 'conversation.open', binding, configuration, previousBinding: f.binding,
    previousConfiguration: base, mode: 'attach', source: provider.session, operationId: 'skills' })
  const observer = async () => {
    if (f.binding.owner.kind !== 'agent') throw new Error('Agent fixture required')
    const manager = new WorkerConversationManager({ binding: f.binding, configuration: base, bridge,
      current: async () => {}, channel: channel(), currentChannel: channel })
    await manager.attachSession(provider.session, { kind: 'agent-chat', configuration: base,
      conversationId: f.binding.owner.conversationId, workflowId: f.binding.owner.workflowId,
      workflowNodeId: f.binding.owner.workflowNodeId, workingDirectory: f.binding.workingDirectory, correlationId: 'observer' })
    return manager
  }
  return { ...f, get connection() { return connection }, originalBinding: f.binding, base, binding, configuration,
    journal, launches, attach, transition, closeOwner, request, observer,
    archive: () => { archived = true },
    restart: async () => {
      await host.close()
      connection = { ...connection, bootId: randomUUID(), connectionGeneration: connection.connectionGeneration + 1,
        connectionEpoch: randomUUID() }
      host = await createHost()
    },
    release: () => request({ method: 'conversation.release-runtime', binding: f.binding, session: provider.session }),
    retire: () => request({ method: 'conversation.retire-turn', binding: f.binding,
      session: provider.session, correlationId: 'unfinished' }),
    setClosureConfirmed(value: boolean) { closureConfirmed = value },
    cleanup: async () => { closureConfirmed = true; await host.close(); await bridge.close() } }
}

it('releases a positively exited process when retiring its saved successful turn', async () => {
  const f = await fixture()
  try {
    await f.journal.finishTurn(f.originalBinding, 'unfinished', { outcome: 'succeeded' })
    await expect(f.retire()).resolves.toMatchObject({ receipt: { runtimeReleased: true, session: provider.session } })
    await expect(f.retire()).resolves.toMatchObject({ receipt: { runtimeReleased: true } })
    expect(f.closeOwner).toHaveBeenCalledTimes(1)
    expect(provider.creates).toBe(1)
    expect(provider.starts).toEqual([])
  } finally { await f.cleanup() }
})

it('releases an exited native process and retries cleanup after its process has already closed', async () => {
  const f = await fixture()
  try {
    await f.journal.finishTurn(f.originalBinding, 'unfinished', { outcome: 'succeeded' })
    f.setClosureConfirmed(false)
    await expect(f.release()).rejects.toThrow('closure is unconfirmed')
    expect((await f.journal.read(f.originalBinding))?.runtimeReleased).not.toBe(true)
    f.setClosureConfirmed(true)
    await f.closeOwner(`conversation:${f.originalBinding.owner.conversationId}`)
    await expect(f.release()).resolves.toMatchObject({ receipt: { runtimeReleased: true, session: provider.session } })
    await expect(f.release()).resolves.toMatchObject({ receipt: { runtimeReleased: true } })
    expect(provider.creates).toBe(1)
    expect(provider.starts).toEqual([])
  } finally { await f.cleanup() }
})

it('refuses runtime release when the exited native process identity has changed', async () => {
  const f = await fixture()
  try {
    await f.journal.finishTurn(f.originalBinding, 'unfinished', { outcome: 'succeeded' })
    f.launches[0] = { ...f.launches[0]!, provider: { pid: 22222, startTicks: '22' },
      lifecycle: 'closed', closureEvidence: 'cgroup_v2_empty' }
    await expect(f.release()).rejects.toThrow('unavailable or changed')
    expect(f.closeOwner).not.toHaveBeenCalled()
    expect((await f.journal.read(f.originalBinding))?.runtimeReleased).not.toBe(true)
  } finally { await f.cleanup() }
})

it('retries the release journal write after native closure without requiring a replacement process', async () => {
  const f = await fixture()
  const saving = vi.spyOn(f.journal, 'runtimeReleased').mockRejectedValueOnce(new Error('Release save interrupted'))
  try {
    await f.journal.finishTurn(f.originalBinding, 'unfinished', { outcome: 'succeeded' })
    await expect(f.release()).rejects.toThrow('Release save interrupted')
    expect(f.launches[0]).toMatchObject({ lifecycle: 'closed', closureEvidence: 'cgroup_v2_empty' })
    expect((await f.journal.read(f.originalBinding))?.runtimeReleased).not.toBe(true)
    await expect(f.release()).resolves.toMatchObject({ receipt: { runtimeReleased: true, session: provider.session } })
    expect(provider.creates).toBe(1)
    expect(provider.starts).toEqual([])
  } finally { saving.mockRestore(); await f.cleanup() }
})

it('refuses to release an exited owner when another active process occupies that conversation', async () => {
  const f = await fixture()
  try {
    await f.journal.finishTurn(f.originalBinding, 'unfinished', { outcome: 'succeeded' })
    f.launches[0] = { ...f.launches[0]!, lifecycle: 'closed', closureEvidence: 'cgroup_v2_empty' }
    f.launches.push({ ...f.launches[0]!, launchId: randomUUID(), lifecycle: 'active',
      provider: { pid: 22222, startTicks: '22' } })
    await expect(f.release()).rejects.toThrow('unavailable or changed')
    expect(f.closeOwner).not.toHaveBeenCalled()
    expect((await f.journal.read(f.originalBinding))?.runtimeReleased).not.toBe(true)
  } finally { await f.cleanup() }
})

it.each(['succeeded', 'failed'] as const)(
  'recovers the saved %s result under the original skills after the resident process exits', async outcome => {
    const f = await fixture()
    const result: ExecutionResult = outcome === 'succeeded' ? { outcome, output: 'Saved native answer' }
      : { outcome, error: { code: 'NATIVE_FAILURE', message: 'Saved native failure', retryable: false } }
    provider.history.terminalResult = result
    try {
      const response = await f.transition() as { receipt: WorkerConversationReceipt }
      expect(response.receipt.binding).toEqual(f.binding)
      expect(response.receipt.session).toEqual(provider.session)
      expect(response.receipt.creation?.operationId).toBe('original-create')
      expect(response.receipt.turns[0]).toMatchObject({ status: 'completed', nativeTurnId: 'native-turn', result })
      expect(provider.starts.map(start => 'configuration' in start && start.configuration)).toEqual([f.base, f.configuration])
      expect(response.receipt.ownerTransitions).toHaveLength(2)
      expect(f.launches.slice(0, 2).every(launch => launch.lifecycle === 'closed' && launch.closureEvidence)).toBe(true)
      expect(provider.creates).toBe(1)
    } finally { await f.cleanup() }
  })

it('retains the old binding while closure is unconfirmed and recovers on retry without a Worker restart', async () => {
  const f = await fixture()
  try {
    f.setClosureConfirmed(false)
    await expect(f.transition()).rejects.toThrow('closure is unconfirmed')
    expect((await f.journal.read(f.originalBinding))?.turns[0]?.status).toBe('uncertain')
    expect(provider.starts).toHaveLength(0)
    expect(f.launches).toHaveLength(1)
    f.setClosureConfirmed(true)
    await expect(f.transition()).resolves.toMatchObject({ receipt: { binding: f.binding } })
    expect(provider.creates).toBe(1)
  } finally { await f.cleanup() }
})

it('keeps the old binding and uncertain turn when the exited process has no saved terminal result', async () => {
  const f = await fixture()
  delete provider.history.terminalResult
  try {
    await expect(f.transition()).rejects.toThrow('could not be recovered')
    const saved = await f.journal.read(f.originalBinding)
    expect(saved?.binding).toEqual(f.originalBinding)
    expect(saved?.turns[0]?.status).toBe('uncertain')
    expect(saved?.turns[0]?.result).toBeUndefined()
    expect(provider.starts.map(start => 'configuration' in start && start.configuration)).toEqual([f.base])
    expect(provider.creates).toBe(1)
  } finally { await f.cleanup() }
})

it('settles a live resident without replacing it before the skills migration', async () => {
  const f = await fixture()
  f.launches[0] = { ...f.launches[0]!, lifecycle: 'active' }
  try {
    await expect(f.transition()).resolves.toMatchObject({ receipt: { binding: f.binding } })
    expect(provider.starts.map(start => 'configuration' in start && start.configuration)).toEqual([f.configuration])
    expect(provider.creates).toBe(1)
  } finally { await f.cleanup() }
})

it('refuses a different exited process without closing it or rewriting its saved turn', async () => {
  const f = await fixture()
  f.launches[0] = { ...f.launches[0]!, provider: { pid: 22222, startTicks: '22' } }
  try {
    await expect(f.transition()).rejects.toThrow('unavailable or changed')
    expect(f.closeOwner).not.toHaveBeenCalled()
    expect(provider.starts).toHaveLength(0)
    expect((await f.journal.read(f.originalBinding))?.turns[0]?.status).toBe('uncertain')
  } finally { await f.cleanup() }
})

it.each(['succeeded', 'failed'] as const)(
  'reattaches an exited resident with unchanged skills and its saved %s result', async outcome => {
    const f = await fixture()
    const result: ExecutionResult = outcome === 'succeeded' ? { outcome, output: 'Saved native answer' }
      : { outcome, error: { code: 'NATIVE_FAILURE', message: 'Saved native failure', retryable: false } }
    provider.history.terminalResult = result
    try {
      const response = await f.attach() as { receipt: WorkerConversationReceipt }
      expect(response.receipt.binding).toEqual(f.originalBinding)
      expect(response.receipt.session).toEqual(provider.session)
      expect(response.receipt.creation?.operationId).toBe('original-create')
      expect(response.receipt.turns[0]).toMatchObject({ status: 'completed', nativeTurnId: 'native-turn', result })
      expect(provider.starts.map(start => 'configuration' in start && start.configuration)).toEqual([f.base])
      expect(response.receipt.ownerTransitions).toHaveLength(1)
      expect(f.launches[0]).toMatchObject({ lifecycle: 'closed', closureEvidence: 'cgroup_v2_empty' })
      expect(provider.creates).toBe(1)
      await expect(f.attach()).resolves.toMatchObject({ receipt: {
        binding: f.originalBinding, session: provider.session, turns: response.receipt.turns,
        nativeOwner: response.receipt.nativeOwner, ownerTransitions: response.receipt.ownerTransitions,
      } })
      expect(provider.starts).toHaveLength(1)
      expect(f.launches).toHaveLength(2)
    } finally { await f.cleanup() }
  })

it('retries ordinary attachment after closure is confirmed without restarting the Worker', async () => {
  const f = await fixture()
  try {
    f.setClosureConfirmed(false)
    await expect(f.attach()).rejects.toThrow('closure is unconfirmed')
    expect((await f.journal.read(f.originalBinding))?.turns[0]?.status).toBe('uncertain')
    expect(provider.starts).toHaveLength(0)
    expect(f.launches).toHaveLength(1)
    f.setClosureConfirmed(true)
    await expect(f.attach()).resolves.toMatchObject({ receipt: { binding: f.originalBinding,
      turns: [{ status: 'completed', nativeTurnId: 'native-turn', result: provider.history.terminalResult }] } })
    expect(provider.creates).toBe(1)
  } finally { await f.cleanup() }
})

it('keeps an ordinary attachment uncertain until its saved terminal result is available', async () => {
  const f = await fixture()
  const result = provider.history.terminalResult!
  delete provider.history.terminalResult
  try {
    await expect(f.attach()).rejects.toThrow('could not be recovered')
    const saved = await f.journal.read(f.originalBinding)
    expect(saved?.binding).toEqual(f.originalBinding)
    expect(saved?.turns[0]?.status).toBe('uncertain')
    expect(saved?.turns[0]?.result).toBeUndefined()
    expect(provider.starts.map(start => 'configuration' in start && start.configuration)).toEqual([f.base])
    provider.history.terminalResult = result
    await expect(f.attach()).resolves.toMatchObject({ receipt: { binding: f.originalBinding,
      turns: [{ status: 'completed', nativeTurnId: 'native-turn', result }] } })
    expect(provider.creates).toBe(1)
  } finally { await f.cleanup() }
})

it('does not replace a live resident during ordinary attachment', async () => {
  const f = await fixture()
  f.launches[0] = { ...f.launches[0]!, lifecycle: 'active' }
  try {
    await expect(f.attach()).resolves.toMatchObject({ receipt: { binding: f.originalBinding } })
    expect(provider.starts).toHaveLength(0)
    expect(f.closeOwner).not.toHaveBeenCalled()
    expect(f.launches).toHaveLength(1)
    expect(provider.creates).toBe(1)
  } finally { await f.cleanup() }
})

it('refuses a different exited process during ordinary attachment without closing it', async () => {
  const f = await fixture()
  f.launches[0] = { ...f.launches[0]!, provider: { pid: 22222, startTicks: '22' } }
  try {
    await expect(f.attach()).rejects.toThrow('unavailable or changed')
    expect(f.closeOwner).not.toHaveBeenCalled()
    expect(provider.starts).toHaveLength(0)
    expect((await f.journal.read(f.originalBinding))?.turns[0]?.status).toBe('uncertain')
  } finally { await f.cleanup() }
})

for (const method of ['conversation.history', 'conversation.reconcile', 'conversation.pending', 'conversation.cancel'] as const) {
  it.each(['codex', 'claude'] as const)(`recovers an exited %s owner during ${method} on the unchanged device connection`, async harness => {
    const f = await fixture(harness)
    try {
      if (method === 'conversation.reconcile') {
        await f.request({ method, binding: f.originalBinding, session: provider.session, correlationId: 'unfinished' })
      } else {
        await f.request({ method, binding: f.originalBinding, session: provider.session })
      }
      const saved = (await f.journal.read(f.originalBinding))!
      expect(saved.session).toEqual(provider.session)
      expect(saved.connection).toEqual(f.connection)
      expect(saved.turns[0]).toMatchObject({ status: 'completed', result: provider.history.terminalResult,
        ...(harness === 'codex' ? { nativeTurnId: 'native-turn' } : { nativeSubmission: provider.history.nativeSubmission }) })
      expect(saved.ownerTransitions).toHaveLength(1)
      expect(provider.starts.map(start => 'configuration' in start && start.configuration)).toEqual([f.base])
      expect(provider.creates).toBe(1)
      expect(f.launches[0]).toMatchObject({ lifecycle: 'closed', closureEvidence: 'cgroup_v2_empty' })
      await f.request({ method: 'conversation.history', binding: f.originalBinding, session: provider.session,
        correlationId: 'unfinished' })
      expect(provider.starts).toHaveLength(1)
    } finally { await f.cleanup() }
  })
}

it('retries observation of an exited owner on the same connection after its closure is confirmed', async () => {
  const f = await fixture()
  const observe = () => f.request({ method: 'conversation.history', binding: f.originalBinding,
    session: provider.session, correlationId: 'unfinished' })
  try {
    f.setClosureConfirmed(false)
    await expect(observe()).rejects.toThrow('closure is unconfirmed')
    expect((await f.journal.read(f.originalBinding))?.turns[0]?.status).toBe('uncertain')
    expect(provider.starts).toHaveLength(0)
    f.setClosureConfirmed(true)
    await expect(observe()).resolves.toMatchObject({ receipt: { session: provider.session,
      turns: [{ status: 'completed', nativeTurnId: 'native-turn', result: provider.history.terminalResult }] } })
    expect(provider.creates).toBe(1)
  } finally { await f.cleanup() }
})

it.each([['codex', false], ['claude', false], ['codex', true], ['claude', true]] as const)(
  'disposes a nonresident %s owner after Worker restart without reopening the provider (archived: %s)', async (harness, archived) => {
  const f = await fixture(harness)
  let manager: WorkerConversationManager | undefined
  try {
    await f.attach()
    manager = await f.observer()
    const before = (await f.journal.read(f.originalBinding))!
    await f.restart()
    if (archived) f.archive()
    expect((await f.journal.read(f.originalBinding))?.runtimeReleased).not.toBe(true)
    const starts = provider.starts.length
    const creates = provider.creates
    await manager.dispose()
    const released = (await f.journal.read(f.originalBinding))!
    expect(released).toMatchObject({ runtimeReleased: true, closed: false, session: provider.session, connection: f.connection })
    expect(released.turns).toEqual(before.turns)
    expect(released.nativeOwner).toEqual(before.nativeOwner)
    expect(provider.starts).toHaveLength(starts)
    expect(provider.creates).toBe(creates)
    await f.restart()
    await expect(f.request({ method: 'conversation.release-runtime', binding: f.originalBinding, session: provider.session }))
      .resolves.toMatchObject({ receipt: { runtimeReleased: true, connection: f.connection } })
    expect(provider.starts).toHaveLength(starts)
  } finally { await manager?.closeForRestart(provider.session); await f.cleanup() }
})

it.each(['unconfirmed-closure', 'changed-owner'] as const)('refuses nonresident release with %s', async fault => {
  const f = await fixture()
  let manager: WorkerConversationManager | undefined
  try {
    await f.attach()
    manager = await f.observer()
    await f.restart()
    const last = f.launches.at(-1)!
    const changed = { ...last }
    if (fault === 'unconfirmed-closure') delete changed.closureEvidence
    else changed.provider = { pid: 33333, startTicks: '33' }
    f.launches[f.launches.length - 1] = changed
    const starts = provider.starts.length
    await expect(manager.dispose()).rejects.toThrow()
    expect((await f.journal.read(f.originalBinding))?.runtimeReleased).not.toBe(true)
    expect(provider.starts).toHaveLength(starts)
  } finally { await manager?.closeForRestart(provider.session); await f.cleanup() }
})
