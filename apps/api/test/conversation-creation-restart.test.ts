import type pg from 'pg'
import { expect, it } from 'vitest'
import { SessionPreferencesSchema, type ExecutionResult, type NativeSessionReference } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { WorkerConversationReceipt } from '@foreman-code/contracts/remote-execution-rpc'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { agentChatCorrelation, type AgentConversationRow, type PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { nativeCorrelation } from '../src/modules/conversations/operatorChatRepository.js'
import { WorkerConversationHost } from '../src/modules/conversations/workerHost.js'
import { WorkerConversationJournal } from '../src/modules/conversations/workerJournal.js'
import { WorkerConversationManager } from '../src/modules/conversations/workerManager.js'
import { MainWorkerConversationBridge } from '../src/modules/conversations/workerBridge.js'
import { workerConversationFixture } from '../src/modules/conversations/workerFixtures.test-support.js'
import type { NativeHarnessSessionManager, NativeSessionStart, NativeInitialTurnInput } from '../src/modules/harnesses/port.js'
import { memoryConversation, operator } from './fixtures/agent1OperatorChat.js'
import { chatWorkflowVersionRow, isCurrentVersionRead, isRunVersionRead, isSavedVersionRead } from './helpers/chatWorkflowVersion.js'
import { memorySessionControlPool } from './support/sessionControls.js'
import { SessionControlStore } from '../src/modules/conversations/sessionControls/store.js'

async function creation(kind: 'operator' | 'agent', fork = false, harness: 'codex' | 'claude' = 'codex',
  selection: 'fresh' | 'worker-profile' | 'main-profile' | 'no-profile' = 'worker-profile') {
  const f = workerConversationFixture(kind, harness)
  if (kind === 'operator' && harness === 'claude') f.binding.appMcpAccess = 'scoped'
  if (selection === 'no-profile') delete f.configuration.harnessProfileSelection
  if (selection === 'main-profile') {
    f.configuration.harnessProfileSelection!.target.hostRef = { kind: 'main', mainId: f.connection.mainId }
  }
  f.binding.owner.configurationHash = commandInputHash(f.configuration)
  if (fork && f.binding.owner.kind === 'agent') {
    const target = f.binding.profile.target
    const digest = 'a'.repeat(64)
    f.binding.sourceExecution = { executionId: 'execution', placement: {
      schemaVersion: 1, mainId: f.connection.mainId, mainInstallationId: f.connection.mainId,
      runId: 'run', nodeId: f.binding.owner.workflowNodeId, hostRef: target.hostRef,
      registration: { workerInstallationId: f.connection.workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
      destination: { canonicalProjectRoot: f.binding.workingDirectory, canonicalCwd: f.binding.workingDirectory,
        managedRuntimeRoot: '/managed/runtime', directoryIdentityHash: digest, rootPolicyId: 'root-policy',
        rootPolicyRevision: '1', locationRevision: '1', attestationId: 'attestation', attestationHash: digest },
      source: { revisionId: 'revision', manifestDigest: digest, materializationId: 'materialization',
        materializationDigest: digest }, bindingHash: digest,
      payload: { kind: 'agent', agentId: f.binding.owner.agentId, agentConfigurationVersionId: f.configuration.id,
        driverId: harness, driverRevision: 'driver', instanceId: f.binding.profile.instanceId,
        instanceRevision: f.binding.profile.instanceRevision, harnessInstallationId: target.harnessInstallationId,
        installationFingerprint: target.installationFingerprint, runtimeContractVersion: 1,
        protocolRevision: 'protocol', credentialScopeRefs: [] },
    }, workingTree: { materializationId: f.connection.connectionEpoch, materializationDigest: digest,
      canonicalProjectRoot: f.binding.workingDirectory, canonicalCwd: f.binding.workingDirectory,
      directoryIdentityHash: digest, filesystem: { device: '1', inode: '2', mountId: '3' },
      accessMode: 'read-only', privateGit: null } }
  }
  const id = f.binding.owner.conversationId
  const requestId = 'original-request'
  const correlationId = kind === 'operator' ? nativeCorrelation(id, requestId) : agentChatCorrelation(id, requestId)
  const preferences = SessionPreferencesSchema.parse({ contextBudget: 240000 })
  const source: NativeSessionReference | undefined = fork ? { ...f.session, nativeSessionId: 'run-source' } : undefined
  const records: WorkerConversationReceipt[] = []
  const journal = new WorkerConversationJournal({ read: async () => structuredClone(records),
    change: async (_id, apply) => structuredClone(apply(records)) }, 8)
  const submission = { kind: 'message' as const, nativeSessionId: f.session.nativeSessionId,
    nativeMessageId: 'original-message', clientCorrelationId: correlationId }
  const history = { events: [], pendingInteractions: [], correlationId, nativeSubmission: submission,
    terminalResult: { outcome: 'succeeded' as const },
    terminalTurn: { correlationId, providerId: submission.nativeMessageId, result: { outcome: 'succeeded' as const } } }
  let creates = 0
  const native = { harness, createSession: async () => { creates++; return f.session },
    forkSession: async () => { creates++; return f.session }, close: async () => {},
    history: async () => history, reconcile: async () => history,
    async *startInitialTurn(_start: NativeSessionStart, input: NativeInitialTurnInput) {
      creates++
      await input.onSessionObserved(f.session)
      await input.onMessageSubmitted?.(submission)
      yield { type: 'session.started', sequence: 1, occurredAt: '2026-10-01T00:00:00Z', payload: {} }
    },
  } as unknown as NativeHarnessSessionManager
  const host = new WorkerConversationHost({ journal, currentBinding: () => f.connection,
    authorize: async () => {}, observeSubmission: async () => {},
    observeSession: async () => { throw new Error('Main disconnected before saving identity') },
    allocate: async () => ({ manager: native, nativeOwner: async () => f.nativeOwner, close: async () => {},
      start: async () => ({ kind: 'operator', configuration: f.configuration,
        correlationId, workingDirectory: f.binding.workingDirectory }) as NativeSessionStart }) })
  if (harness === 'claude' && !fork) {
    await host.handle({ method: 'conversation.initial-turn', binding: f.binding, configuration: f.configuration,
      operationId: correlationId, correlationId, prompt: 'Original input', preferences }, f.connection)
    await host.drainForUpdate()
  } else await expect(host.handle({ method: 'conversation.open', binding: f.binding, configuration: f.configuration,
    operationId: correlationId, mode: fork ? 'fork' : 'create', preferences, ...(source ? { source } : {}) }, f.connection))
    .rejects.toThrow('Main disconnected')
  const bridge = new MainWorkerConversationBridge()
  const methods: string[] = []
  const manager = new WorkerConversationManager({ binding: f.binding, configuration: f.configuration,
    bridge, current: async () => {}, channel: { binding: f.connection, request: async raw => {
      methods.push((raw as { method: string }).method)
      return { payload: await host.handle(raw, f.connection) }
    } } })
  const controlsPool = memorySessionControlPool({ defaults: new Map([
    [JSON.stringify(['owner', kind, 'subject', 'profile']), preferences],
  ]) })
  const controls = new SessionControlStore(controlsPool, kind)
  await controls.read({ conversationId: id, principalId: 'owner', defaultSubject: 'subject',
    profileKey: 'profile', busyReason: null })
  return { ...f, id, requestId, correlationId, source, preferences, controlsPool, controls, journal, manager,
    methods, submission, creates: () => creates,
    async close() { await manager.dispose(); await bridge.close(); await host.shutdown() } }
}

it.each([['codex', false], ['claude', false], ['claude', true]] as const)(
  'recovers %s Operator creation after losing Main memory (session already bound: %s)', async (harness, bound) => {
  const f = await creation('operator', false, harness)
  if (!('operatorId' in f.configuration)) throw new Error('Operator configuration required')
  const owner = operator()
  const stored = memoryConversation(f.configuration, owner.id, f.id)
  Object.assign(stored.row, { active_request_id: f.requestId, active_phase: harness === 'claude' ? 'submitting' : 'creating', turn_state: 'uncertain' })
  if (bound) Object.assign(stored.row, { native_session_id: f.session.nativeSessionId,
    provider_version: f.session.providerVersion, active_phase: 'ready' })
  stored.repository.createSessionControls = () => f.controls
  const submissions: unknown[] = []
  stored.repository.submittedMessage = async (_id, _requestId, receipt) => {
    submissions.push(receipt)
    stored.row.active_phase = 'submitted'
    return true
  }
  stored.repository.createControlCommands = () => ({
    reconcileStoredResponses: async () => {}, drain: async () => {},
  }) as never
  const authority = { current: async () => owner, release: async () => {},
    prepare: async () => { throw new Error('Recovery cannot issue credentials') } }
  const chat = new OperatorChatService(stored.repository, {} as never, (() => f.manager) as never,
    f.binding.workingDirectory, authority as never)
  try {
    await chat.reconcileActive()
    expect(stored.row.native_session_id).toBe(f.session.nativeSessionId)
    expect(stored.row.last_error).toBeNull()
    expect(stored.finishResults).toHaveLength(1)
    expect(f.methods).toContain(bound ? 'conversation.reconcile' : 'conversation.status')
    expect(f.creates()).toBe(1)
    expect((await f.journal.read(f.binding))?.creation?.inputHash).toBe(commandInputHash(harness === 'claude'
      ? { mode: 'initial-turn', correlationId: f.correlationId }
      : { mode: 'create', source: null, preferences: f.preferences }))
    expect(submissions).toEqual(harness === 'claude' ? [f.submission] : [])
    expect(stored.finishResults[0]?.outcome).toBe(harness === 'claude' ? 'succeeded' : 'failed')
  } finally { await chat.shutdown(); await f.close() }
})

it.each([['codex', 'fresh'], ['codex', 'worker-profile'], ['codex', 'main-profile'],
  ['codex', 'no-profile'], ['claude', 'fresh'], ['claude', 'no-profile']] as const)(
  'recovers journaled %s Agent creation after Main restart using the accepted placement (%s)', async (harness, selection) => {
  const fork = selection !== 'fresh'
  const f = await creation('agent', fork, harness, selection)
  if (!('agentId' in f.configuration) || f.binding.owner.kind !== 'agent') throw new Error('Agent configuration required')
  const configuration = structuredClone(f.configuration)
  const now = new Date()
  const row: AgentConversationRow = { id: f.id, agent_key: 'agent-key', workspace_id: configuration.workspaceId,
    workflow_id: f.binding.owner.workflowId, workflow_node_id: f.binding.owner.workflowNodeId,
    agent_id: configuration.agentId, agent_configuration_version_id: configuration.id,
    origin_run_id: fork ? 'run' : null, origin_execution_id: fork ? 'execution' : null,
    harness, native_session_id: null, provider_version: null, active_request_id: f.requestId,
    active_native_turn_id: null, cancel_requested: false, turn_state: 'uncertain', last_error: null,
    revision: 1, pending_interaction: null, last_result: null, created_at: now, updated_at: now,
    record: { origin: fork ? { kind: 'run_execution', runId: 'run', executionId: 'execution',
      sourceNativeSessionId: f.source!.nativeSessionId } : { kind: 'fresh' }, workingDirectory: f.binding.workingDirectory,
      runtimeDirectory: f.binding.workingDirectory, sessionCreation: { requestId: f.requestId } } }
  const submissions: unknown[] = []
  const errors: string[] = []
  const results: ExecutionResult[] = []
  const repository = {
    open: async () => [structuredClone(row)], get: async () => structuredClone(row),
    restoreUnsettled: async () => structuredClone(row), unconfirmedSteers: async () => [],
    nextQueued: async () => undefined,
    turnPreparedInput: async () => undefined,
    initialInputOffered: async () => false,
    bindSession: async (_id: string, version: string, sessionId: string) => {
      row.provider_version = version
      row.native_session_id = sessionId
    },
    acceptedMessage: async (_id: string, _requestId: string, receipt: unknown) => {
      submissions.push(receipt)
      return true
    },
    markSessionUnavailable: async (_id: string, message: string) => { row.record.sessionUnavailable = message },
    abandon: async (_id: string, _requestId: string, message: string) => { errors.push(message) },
    bindCreatedSession: async (_id: string, _requestId: string, _configurationId: string, session: NativeSessionReference) => {
      row.native_session_id = session.nativeSessionId
      row.provider_version = session.providerVersion
    },
    finish: async (_id: string, _requestId: string, result: ExecutionResult) => {
      results.push(result)
      row.active_request_id = null
      return true
    },
  } as unknown as PostgresAgentChatRepository
  const savedVersion = chatWorkflowVersionRow({ workspaceId: configuration.workspaceId, workflowId: row.workflow_id,
    workflowNodeId: row.workflow_node_id, agentId: configuration.agentId, configurationId: configuration.id })
  const pool = { query: async (sql: string, values: unknown[]) => {
    if (isCurrentVersionRead(sql) || isSavedVersionRead(sql)) return { rows: [savedVersion] }
    if (isRunVersionRead(sql)) return { rows: [{ workflow_version_id: savedVersion.id }] }
    if (fork && values[0] === 'execution') return { rows: [{ reference: f.source }] }
    if (sql.includes("payload->>'ownerPrincipalId' as principal_id")) return { rows: [] }
    return f.controlsPool.query(sql, values)
  } } as unknown as pg.Pool
  const workflows = { getAgentConfiguration: async () => configuration,
    getSavedVersion: async () => ({ definition: { nodes: [{ id: row.workflow_node_id, agentId: row.agent_id }] } }) }
  const runs = { getForWorkspace: async () => ({ workflowVersionId: 'version' }) }
  const chat = new AgentChatService(pool, repository, {} as never, workflows as never, runs as never,
    (_id, accepted, _directory, source) => {
      expect(accepted).toEqual(configuration)
      expect(source).toEqual(fork ? { executionId: 'execution' } : undefined)
      // The production factory resolves the accepted execution placement before returning the Worker adapter.
      return f.manager
    }, f.binding.workingDirectory)
  try {
    await chat.recover()
    expect(row.record.sessionUnavailable).toBeUndefined()
    expect(row.native_session_id).toBe(f.session.nativeSessionId)
    expect(errors).toEqual([])
    expect(results).toHaveLength(1)
    const initialTurn = harness === 'claude' && !fork
    expect(results[0]?.outcome).toBe(initialTurn ? 'succeeded' : 'failed')
    expect(submissions).toEqual(initialTurn ? [f.submission] : [])
    expect(f.methods).toContain('conversation.status')
    expect(f.creates()).toBe(1)
  } finally { await chat.shutdown(); await f.close() }
})

it('observes and cancels an unfinished remote Operator turn after Main restarts without refreshing credentials', async () => {
  const f = workerConversationFixture()
  if (!('operatorId' in f.configuration)) throw new Error('Operator configuration required')
  const configuration = f.configuration
  const binding = { ...f.binding, appMcpAccess: 'scoped' as const }
  const id = binding.owner.conversationId
  const requestId = 'unfinished-request'
  const correlationId = nativeCorrelation(id, requestId)
  const owner = operator()
  const stored = memoryConversation(configuration, owner.id, id)
  Object.assign(stored.row, { native_session_id: f.session.nativeSessionId, provider_version: f.session.providerVersion,
    active_request_id: requestId, active_phase: 'submitted', active_native_turn_id: 'native-turn',
    turn_state: 'canceling', cancel_requested: true })
  const records: WorkerConversationReceipt[] = []
  const journal = new WorkerConversationJournal({ read: async () => structuredClone(records),
    change: async (_id, apply) => structuredClone(apply(records)) }, 8)
  await journal.receive(binding, f.connection)
  await journal.reserveCreation(binding, 'original-creation', commandInputHash('original-creation'))
  await journal.bindSession(binding, f.session, f.nativeOwner)
  await journal.reserveTurn(binding, correlationId, commandInputHash('original-prompt'))
  await journal.submitted(binding, correlationId, { nativeTurnId: 'native-turn' })
  let cancellations = 0
  let refreshes = 0
  let allowed = true
  const native = { harness: 'codex', cancel: async () => { cancellations++; return true }, close: async () => {},
    reconcile: async () => ({ events: [], pendingInteractions: [], correlationId, nativeTurnId: 'native-turn',
      terminalResult: { outcome: 'canceled' } }),
  } as unknown as NativeHarnessSessionManager
  const allocation = { manager: native, nativeOwner: async () => f.nativeOwner, close: async () => {},
    start: async () => { throw new Error('Recovery cannot launch a session') },
    refreshApplicationAccess: async () => { refreshes++; throw new Error('AUTH_INVALID cleanup credential') } }
  const host = new WorkerConversationHost({ journal, currentBinding: () => f.connection,
    authorize: async () => { if (!allowed) throw new Error('Conversation access denied') },
    observeSession: async () => {}, observeSubmission: async () => {},
    allocate: async () => { throw new Error('Recovery cannot allocate a new session') }, recover: async () => allocation })
  const bridge = new MainWorkerConversationBridge()
  const manager = new WorkerConversationManager({ binding, configuration,
    bridge, current: async () => {}, channel: { binding: f.connection,
      request: async raw => ({ payload: await host.handle(raw, f.connection) }) } })
  const chat = new OperatorChatService(stored.repository, {} as never, (() => manager) as never,
    binding.workingDirectory, { current: async () => owner, release: async () => {} } as never)
  try {
    await chat.reconcileActive()
    expect(stored.finishResults).toEqual([{ outcome: 'canceled' }])
    expect(cancellations).toBe(1)
    expect(refreshes).toBe(0)
    allowed = false
    await expect(host.handle({ method: 'conversation.history', binding, session: f.session }, f.connection))
      .rejects.toThrow('Conversation access denied')
  } finally { await chat.shutdown(); await manager.dispose(); await bridge.close(); await host.shutdown() }
})
