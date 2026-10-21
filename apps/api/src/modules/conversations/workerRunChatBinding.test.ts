import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import type { NodeSkillOverride } from '@foreman-code/contracts/wave25'
import { AgentConfigurationVersionSchema } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { WorkerConversationBindingSchema, WorkerConversationRpcRequestSchema,
  type WorkerConversationReceipt, type WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeHarnessSessionManager, NativeSessionStart } from '../harnesses/port.js'
import type { NativeLaunchObservation } from '../harnesses/recovery/processRegistry.js'
import { createProductionWorkerConversations } from './workerProduction.js'
import { WorkerConversationHost, type WorkerConversationAllocation } from './workerHost.js'
import { WorkerConversationJournal } from './workerJournal.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import { workerConversationProcessDigest } from './workerNativeOwner.js'
import { recoverWorkerConversation } from './recoverWorkerConversation.js'
import { workerConversationCallbacks } from './workerCallbacks.js'
import { legacyProviderAccountBinding } from '../provider-accounts/acceptedBindings.js'
import { configurationWithNodeSkills } from '../skills/nodeSkills.js'
import { agentChatCorrelation } from './agentChatRepository.js'

async function fixture(harness: 'codex' | 'claude', change: 'add' | 'remove' = 'add',
  turnStatus: 'completed' | 'submitted' | 'uncertain' = 'completed', options?: { updatedSettings: true }) {
  const f = workerConversationFixture('agent', harness)
  let base = AgentConfigurationVersionSchema.parse(f.configuration)
  const skill = { skillId: 'node-skill', version: '1', instructions: 'Use the saved node instructions.',
    contentHash: `sha256:${createHash('sha256').update('Use the saved node instructions.').digest('hex')}` }
  const reference = { skillId: skill.skillId, version: skill.version }
  if (change === 'remove') base = { ...base, assignedSkills: [reference], resolvedSkills: [skill] }
  const skills: NodeSkillOverride = change === 'remove' ? { remove: [skill.skillId] } : { add: [reference] }
  const snapshots = change === 'remove' ? [] : [skill]
  const pinnedConfiguration = configurationWithNodeSkills(base, skills, snapshots)
  const configuration = options?.updatedSettings
    ? { ...pinnedConfiguration, id: randomUUID(), harness: { ...base.harness, model: 'changed-model' } }
    : pinnedConfiguration
  const binding = WorkerConversationBindingSchema.parse({ ...f.binding,
    owner: { ...f.binding.owner, configurationHash: commandInputHash(options?.updatedSettings ? pinnedConfiguration : base) },
    accountBinding: legacyProviderAccountBinding(base.harness, base.harnessProfileSelection)! })
  const records: WorkerConversationReceipt[] = []
  const journal = new WorkerConversationJournal({ read: async () => structuredClone(records),
    change: async (_id, apply) => {
      const draft = structuredClone(records)
      const result = apply(draft)
      records.splice(0, records.length, ...structuredClone(draft))
      return structuredClone(result)
    } }, 10)
  const launch: NativeLaunchObservation = { owner: `conversation:${binding.owner.conversationId}`,
    launchId: randomUUID(), bootId: f.connection.bootId, lifecycle: 'closed', closureEvidence: 'cgroup_v2_empty',
    guardian: { pid: 11111, startTicks: '10' }, provider: { pid: 11112, startTicks: '11' },
    boundary: { kind: 'cgroup-v2', path: '/fixture/native-boundary', device: '1', inode: '2' } }
  const nativeOwner = { sessionId: f.session.nativeSessionId,
    processIdentityDigest: workerConversationProcessDigest(binding, launch) }
  await journal.receive(binding, f.connection)
  await journal.reserveCreation(binding, 'original-create', commandInputHash({ mode: 'create' }))
  await journal.bindSession(binding, f.session, nativeOwner)
  await journal.reserveTurn(binding, 'original-input', commandInputHash({ prompt: 'Remember this' }))
  await journal.submitted(binding, 'original-input', { nativeTurnId: 'original-turn' })
  const result = { outcome: 'succeeded' as const }
  if (turnStatus !== 'submitted') {
    await journal.finishTurn(binding, 'original-input', turnStatus === 'completed' ? result : undefined)
  }
  const before = structuredClone(records[0]!)
  const principal = { id: 'fixture-principal', name: 'Fixture', audience: 'operator', delegated_from: null,
    grants: [{ actions: ['agent_chat:read', 'agent_chat:write'], scope: {} }],
    expires_at: new Date(Date.now() + 600_000), revoked_at: null }
  const conversation = { id: binding.owner.conversationId, kind: 'agent', workspace_id: base.workspaceId,
    workflow_id: 'workflow', workflow_node_id: 'node', agent_id: base.agentId,
    agent_configuration_version_id: configuration.id, active_request_id: 'next-input', native_session_id: f.session.nativeSessionId,
    deleted_at: null, owner_principal_id: principal.id, payload: { ownerPrincipalId: principal.id },
    record: { status: 'open', origin: { kind: 'run_execution', runId: 'run', executionId: 'execution' } },
    worker_conversation_binding: binding }
  const version = { id: 'version', workspaceId: base.workspaceId, workflowId: 'workflow', version: 1,
    executionSemanticsVersion: 3, entryNodeId: 'node', approval: { handler: 'user' },
    agentConfigurationVersionIds: { [base.agentId]: base.id }, nodeSkillSnapshots: { node: snapshots },
    definition: { id: 'workflow', workspaceId: base.workspaceId, name: 'Fixture', version: 1,
      executionSemanticsVersion: 3, entryNodeId: 'node', approval: { handler: 'user' },
      executionCondition: { kind: 'manual' }, executionPolicy: { maxParallelism: 1, maxNodeExecutions: 1 },
      nodes: [{ id: 'node', agentId: base.agentId, name: 'Agent', skills }], edges: [] },
    contentHash: `sha256:${'a'.repeat(64)}`, createdAt: base.createdAt }
  let failPersistence = false
  const pool = { query: vi.fn(async (sql: string, args: unknown[]) => {
    if (sql.includes('from management_principals')) return { rows: [principal] }
    if (sql.includes('from provider_account_accepted_bindings')) return { rows: [{ binding: binding.accountBinding }] }
    if (sql.includes('from agent_configuration_versions')) return { rows: [{ record: base, version }] }
    if (sql.startsWith('update operator_conversations')) {
      if (failPersistence) throw new Error('Fixture persistence interrupted.')
      conversation.worker_conversation_binding = JSON.parse(args[1] as string)
      return { rows: [], rowCount: 1 }
    }
    return { rows: [conversation], rowCount: 1 }
  }) } as unknown as pg.Pool
  const frames: WorkerConversationRpcRequest[] = []
  const profiles = { admit: async () => ({ override: { configuration: configuration.harness, target: binding.profile.target } }),
    revalidate: async () => {} }
  const production = createProductionWorkerConversations({ pool,
    endpoint: () => ({ captureRequest: () => ({ binding: f.connection, request: async (raw: unknown) => {
      frames.push(WorkerConversationRpcRequestSchema.parse(raw))
      return { payload: await host.handle(raw, f.connection) }
    } }) }), profiles, claudeProfiles: profiles, operators: {}, agents: {}, registry: {}, qualifications: {},
    suiteRevisions: {}, access: {}, mcpForward: () => ({}),
  } as unknown as Parameters<typeof createProductionWorkerConversations>[0])
  const callbacks = workerConversationCallbacks({ currentBinding: () => f.connection,
    capture: () => ({ binding: f.connection, request: async (raw, options) => ({
      payload: await production.bridge.handle(raw, f.connection, options?.signal ?? AbortSignal.timeout(1000)) }) }) })
  const attach = vi.fn(async () => f.session)
  const forbidden = async (): Promise<never> => { throw new Error('A binding transition cannot create or submit input.') }
  const native: NativeHarnessSessionManager = { harness, attachSession: attach,
    reconcile: async () => ({ correlationId: 'original-input', nativeTurnId: 'original-turn',
      terminalResult: result, events: [], pendingInteractions: [] }),
    capabilities: forbidden, inspectMcp: forbidden, createSession: forbidden, forkSession: forbidden,
    startTurn() { throw new Error('A binding transition cannot submit input.') }, pending: forbidden,
    respond: forbidden, cancel: forbidden, history: async () => ({ events: [], pendingInteractions: [] }), close: forbidden }
  const start: NativeSessionStart = { kind: 'agent-chat', configuration, conversationId: conversation.id,
    workflowId: 'workflow', workflowNodeId: 'node', workingDirectory: binding.workingDirectory,
    correlationId: 'resume', instructionsDelivered: true }
  const allocation: WorkerConversationAllocation = { manager: native, start: async () => start,
    nativeOwner: async () => ({ ...nativeOwner, processIdentityDigest: 'd'.repeat(64) }), close: async () => {} }
  const allocate = vi.fn(async () => allocation)
  const host = new WorkerConversationHost({ journal, currentBinding: () => f.connection, ...callbacks,
    allocate: forbidden,
    recover: async (record, effective, connection, signal, request) => recoverWorkerConversation({
      record, configuration: effective, connection, signal, request, journal, allocate,
      registry: { snapshot: () => ({ revision: '1', launches: [launch] }), closeOwner: async () => true },
      assertCurrent: () => callbacks.authorize(request, connection, signal),
    }) })
  const manager = production.create({ conversationId: conversation.id, configuration,
    workingDirectory: binding.workingDirectory, appMcpAccess: 'none' })
  return { ...f, base, binding, configuration, records, before, principal, conversation, version, journal,
    production, host, manager, start, frames, attach, allocate, allocation, launch,
    failPersistence: () => { failPersistence = true }, restorePersistence: () => { failPersistence = false },
    cleanup: async () => { await manager.dispose?.(); await host.shutdown(); await production.close() } }
}

it.each(['codex', 'claude'] as const)('%s keeps pinned Run node skills when an Agent settings version changes', async harness => {
  const f = await fixture(harness, 'add', 'completed', { updatedSettings: true })
  try {
    await expect(f.manager.attachSession(f.session, f.start)).resolves.toEqual(f.session)
    const saved = f.records[0]!
    expect(saved.binding.owner.configurationVersionId).toBe(f.configuration.id)
    expect(saved.binding.owner.configurationHash).toBe(commandInputHash(f.configuration))
    expect(saved.session).toEqual(f.session)
    expect(saved.turns).toEqual(f.before.turns)
    expect(saved.creation).toEqual(f.before.creation)
    expect(f.conversation.worker_conversation_binding).toEqual(saved.binding)
    expect(f.attach).toHaveBeenCalledTimes(1)
    expect(f.allocate).toHaveBeenCalledTimes(1)
  } finally { await f.cleanup() }
})

it.each([['codex', 'add'], ['claude', 'add'], ['codex', 'remove'], ['claude', 'remove']] as const)(
  '%s reconnects a base-hashed Run chat with a saved skill %s and the same session', async (harness, change) => {
  const f = await fixture(harness, change)
  try {
    await expect(f.manager.attachSession(f.session, f.start)).resolves.toEqual(f.session)
    const saved = f.records[0]!
    expect(saved.binding.owner.configurationHash).toBe(commandInputHash(f.configuration))
    expect(saved.binding.owner.configurationVersionId).toBe(f.base.id)
    expect(saved.session).toEqual(f.session)
    expect(saved.turns).toEqual(f.before.turns)
    expect(saved.creation).toEqual(f.before.creation)
    expect(saved.binding.profile).toEqual(f.before.binding.profile)
    expect(f.conversation.worker_conversation_binding).toEqual(saved.binding)
    expect(f.attach).toHaveBeenCalledTimes(1)
    expect(f.allocate).toHaveBeenCalledTimes(1)
    await expect(f.manager.history(f.session)).resolves.toMatchObject({ events: [] })
  } finally { await f.cleanup() }
})

it.each(['submitted', 'uncertain'] as const)(
  'settles a cold %s turn before applying the saved Run chat skills', async status => {
    const f = await fixture('codex', 'add', status)
    try {
      await expect(f.manager.attachSession(f.session, f.start)).resolves.toEqual(f.session)
      const saved = f.records[0]!
      expect(saved.turns[0]).toMatchObject({ correlationId: 'original-input', nativeTurnId: 'original-turn',
        status: 'completed', result: { outcome: 'succeeded' } })
      expect(saved.binding.owner.configurationHash).toBe(commandInputHash(f.configuration))
      expect(saved.session).toEqual(f.before.session)
      expect(saved.creation).toEqual(f.before.creation)
      expect(f.attach).toHaveBeenCalledOnce()
      expect(f.conversation.worker_conversation_binding).toEqual(saved.binding)
    } finally { await f.cleanup() }
  })

it('settles a dispatched cold compaction before applying the saved Run chat skills', async () => {
  const f = await fixture('codex')
  const reserved = await f.journal.reserveCompact(f.binding, 'original-compact', commandInputHash('compact'))
  const state = await f.journal.compactProgress(f.binding, { ...reserved.state, dispatchPhase: 'dispatched',
    nativeSessionId: f.session.nativeSessionId, nativeOperationId: 'original-boundary', status: 'uncertain' })
  // The native port returns the result of the dispatched operation on the original session.
  f.allocation.manager.readCompaction = async () => ({ ...state, status: 'completed' })
  try {
    await expect(f.manager.attachSession(f.session, f.start)).resolves.toEqual(f.session)
    const saved = f.records[0]!
    expect(saved.compactions[0]?.state).toMatchObject({ requestId: 'original-compact',
      nativeSessionId: f.session.nativeSessionId, nativeOperationId: 'original-boundary', status: 'completed' })
    expect(saved.binding.owner.configurationHash).toBe(commandInputHash(f.configuration))
    expect(f.attach).toHaveBeenCalledOnce()
  } finally { await f.cleanup() }
})

it('keeps the skills binding unchanged when cold native history cannot prove completion', async () => {
  const f = await fixture('codex', 'add', 'submitted')
  f.allocation.manager.reconcile = async () => ({ correlationId: 'original-input', nativeTurnId: 'original-turn',
    events: [], pendingInteractions: [] })
  try {
    await expect(f.manager.attachSession(f.session, f.start)).rejects.toThrow()
    expect(f.records[0]).toEqual(f.before)
    expect(f.conversation.worker_conversation_binding).toEqual(f.binding)
  } finally { await f.cleanup() }
})

it('keeps a live turn running even when its terminal result is already journaled', async () => {
  const f = await fixture('codex')
  let finish!: () => void
  let entered!: () => void
  const held = new Promise<void>(resolve => { finish = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const baseManager = f.production.create({ conversationId: f.conversation.id, configuration: f.base,
    workingDirectory: f.binding.workingDirectory, appMcpAccess: 'none' })
  const correlationId = agentChatCorrelation(f.conversation.id, f.conversation.active_request_id)
  let output: Promise<void> | undefined
  f.allocation.manager.startTurn = async function* (_session, input) {
    await input.onSubmitted?.('live-turn')
    entered()
    await held
    yield { type: 'turn.completed', sequence: 1, occurredAt: f.base.createdAt, payload: {} }
  }
  try {
    await baseManager.attachSession(f.session, { ...f.start, configuration: f.base })
    output = (async () => {
      for await (const event of baseManager.startTurn(f.session, { prompt: 'Continue', clientCorrelationId: correlationId })) {
        void event
      }
    })()
    await started
    await f.journal.finishTurn(f.binding, correlationId, { outcome: 'succeeded' })
    const before = structuredClone(f.records[0])
    await expect(f.manager.attachSession(f.session, f.start)).rejects.toThrow('busy')
    expect(f.records[0]).toEqual(before)
    expect(f.conversation.worker_conversation_binding).toEqual(f.binding)
    expect(f.attach).toHaveBeenCalledOnce()
  } finally {
    finish()
    await output
    await baseManager.dispose?.()
    await f.cleanup()
  }
})

it.each(['denied', 'foreign-hash', 'wrong-node', 'unsaved-skills', 'harness-change'] as const)(
  'rejects a Run chat transition with %s before native recovery', async kind => {
    const f = await fixture('claude')
    if (kind === 'denied') f.principal.grants = [{ actions: ['agent_chat:read'], scope: {} }]
    if (kind === 'foreign-hash') f.conversation.worker_conversation_binding.owner.configurationHash = `sha256:${'f'.repeat(64)}`
    if (kind === 'wrong-node') f.version.definition.nodes[0]!.agentId = 'another-agent'
    if (kind === 'unsaved-skills') f.version.nodeSkillSnapshots.node[0]!.instructions = 'Changed snapshot'
    if (kind === 'harness-change') f.configuration.harness.model = 'another-model'
    try {
      await expect(f.manager.attachSession(f.session, f.start)).rejects.toThrow()
      expect(f.allocate).not.toHaveBeenCalled()
      expect(f.records[0]).toEqual(f.before)
    } finally { await f.cleanup() }
  })

it('retries a Worker-applied binding transition after Main persistence was interrupted', async () => {
  const f = await fixture('claude')
  try {
    f.failPersistence()
    await expect(f.manager.attachSession(f.session, f.start)).rejects.toThrow('Fixture persistence interrupted.')
    expect(f.records[0]!.binding.owner.configurationHash).toBe(commandInputHash(f.configuration))
    expect(f.conversation.worker_conversation_binding).toEqual(f.binding)
    f.restorePersistence()
    await expect(f.manager.attachSession(f.session, f.start)).resolves.toEqual(f.session)
    expect(f.conversation.worker_conversation_binding).toEqual(f.records[0]!.binding)
    expect(f.attach).toHaveBeenCalledTimes(1)
    expect(f.allocate).toHaveBeenCalledTimes(1)
    expect(f.records[0]!.turns).toEqual(f.before.turns)
  } finally { await f.cleanup() }
})

it('refuses a binding transition until the original native process is positively closed', async () => {
  const f = await fixture('codex')
  Object.assign(f.launch, { lifecycle: 'active' })
  Reflect.deleteProperty(f.launch, 'closureEvidence')
  try {
    await expect(f.manager.attachSession(f.session, f.start)).rejects.toMatchObject({
      code: 'WORKER_CONVERSATION_RECOVERY_REQUIRED' })
    expect(f.allocate).not.toHaveBeenCalled()
    expect(f.records[0]).toEqual(f.before)
  } finally { await f.cleanup() }
})

it('requires a validated skills transition to read Claude callbacks through a different binding hash', async () => {
  const f = await fixture('claude')
  const next = WorkerConversationBindingSchema.parse({ ...f.binding, owner: { ...f.binding.owner,
    configurationHash: commandInputHash(f.configuration) } })
  const request = WorkerConversationRpcRequestSchema.parse({ method: 'conversation.open', mode: 'attach',
    binding: next, previousBinding: f.binding, configuration: f.configuration, previousConfiguration: f.base,
    source: f.session, operationId: 'resume' })
  try {
    await expect(f.journal.inspectBinding(next)).rejects.toThrow()
    await expect(f.journal.claudeCallbackJournal(next, request).acknowledged(f.session.nativeSessionId)).resolves.toEqual([])
    await expect(f.journal.inspectSkillsTransition(f.binding, next,
      { ...f.base, harness: { ...f.base.harness, model: 'another-model' } }, f.configuration)).rejects.toThrow()
    expect(f.records[0]).toEqual(f.before)
  } finally { await f.cleanup() }
})

it('retains and retires Claude callback records while recovering a skills binding transition', async () => {
  const f = await fixture('claude')
  const next = WorkerConversationBindingSchema.parse({ ...f.binding, owner: { ...f.binding.owner,
    configurationHash: commandInputHash(f.configuration) } })
  const request = WorkerConversationRpcRequestSchema.parse({ method: 'conversation.open', mode: 'attach',
    binding: next, previousBinding: f.binding, configuration: f.configuration, previousConfiguration: f.base,
    source: f.session, operationId: 'resume' })
  const identity = { ownerPrincipalId: f.principal.id, attemptId: 'original-input', nativeSessionId: f.session.nativeSessionId,
    nativeMessageId: 'original-message', clientCorrelationId: 'original-input', generation: 'original-generation',
    toolUseId: 'original-tool' }
  const key = commandInputHash(identity)
  const callback = { identity, inputHash: commandInputHash({ input: 'original' }), toolName: 'Read',
    state: 'submitted' as const, acknowledged: true }
  try {
    await f.journal.claudeCallbackJournal(f.binding).write(key, callback)
    const callbacks = f.journal.claudeCallbackJournal(next, request)
    await expect(callbacks.acknowledged(f.session.nativeSessionId)).resolves.toEqual([callback])
    await callbacks.write(key, { ...callback, retired: true })
    await expect(callbacks.read(key)).resolves.toEqual({ ...callback, retired: true })
    expect(f.records[0]!.binding).toEqual(f.binding)
    expect(f.records[0]!.session).toEqual(f.session)
    expect(f.records[0]!.turns).toEqual(f.before.turns)
    await expect(f.manager.attachSession(f.session, f.start)).resolves.toEqual(f.session)
    await expect(callbacks.read(key)).resolves.toEqual({ ...callback, retired: true })
    expect(f.records[0]!.binding).toEqual(next)
  } finally { await f.cleanup() }
})
