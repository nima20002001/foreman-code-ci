import { preflightChatInput, restoreAcceptedChatInput } from './nativeChatInput.js'
import { prepareWorkerChatInput } from './workerChatPreparation.js'
import { randomUUID } from 'node:crypto'
import { DomainError } from '../errors.js'
import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { OperatorConfigurationVersionSchema } from '@foreman-code/contracts'
import { WorkerConversationRpcRequestSchema, type WorkerConversationReceipt,
  type WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import { WORKSPACE_ROOT_EXTENSION } from '@foreman-code/contracts/workspace-root-policies'
import { createProductionWorkerConversations } from './workerProduction.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import { workerOperatorDirectory } from './workerOperatorDirectory.js'
import { nativeCorrelation } from './operatorChatRepository.js'
import { workerExecutionConfiguration } from './workerExecutionConfiguration.js'
import { legacyProviderAccountBinding } from '../provider-accounts/acceptedBindings.js'

function agentOwner<T extends { kind: string }>(owner: T): Extract<T, { kind: 'agent' }> {
  if (owner.kind !== 'agent') throw new Error('Expected an Agent chat binding.')
  return owner as Extract<T, { kind: 'agent' }>
}

it.each([false, true].flatMap(fileInputs => [false, true].map(restored => ({ fileInputs, restored }))))(
  'admits a thinking-only next turn through the production Worker channel (attachments: $fileInputs, restored input: $restored)', async ({ fileInputs, restored }) => {
  const f = workerConversationFixture()
  if (!('operatorId' in f.configuration) || f.binding.owner.kind !== 'operator') throw new Error('Operator fixture required')
  const accepted = OperatorConfigurationVersionSchema.parse({ ...f.configuration, id: randomUUID(), version: 2,
    contentHash: `sha256:${'b'.repeat(64)}`, showThinking: true })
  const root = '/approved/runtime'
  const binding = { ...f.binding, appMcpAccess: fileInputs ? 'scoped' as const : 'none' as const, workingDirectory: workerOperatorDirectory(root, f.binding.owner),
    accountBinding: legacyProviderAccountBinding(f.configuration.harness, f.configuration.harnessProfileSelection)! }
  const first = { correlationId: 'first-turn',
    inputHash: commandInputHash({ prompt: 'First turn', mode: 'regular', preferences: null }),
    status: 'completed' as const,
    nativeTurnId: 'first-native-turn', result: { outcome: 'succeeded' as const } }
  const firstSnapshot = structuredClone(first)
  const receipt: WorkerConversationReceipt = { binding, connection: f.connection, session: f.session,
    nativeOwner: f.nativeOwner, revision: 1, closed: false, closing: false, turns: [first],
    compactions: [], desiredPreferences: null, appliedPreferences: null }
  const owner = { id: 'human', name: 'Human', audience: 'operator', delegated_from: null,
    grants: [{ actions: ['operator_chat:read', 'operator_chat:write', 'operator_chat:cancel'], scope: {} }],
    expires_at: new Date(Date.now() + 600_000), revoked_at: null }
  const conversation = { id: binding.owner.conversationId, kind: 'operator', owner_principal_id: owner.id,
    operator_configuration_version_id: accepted.id, active_request_id: 'next-turn',
    native_session_id: f.session.nativeSessionId, deleted_at: null, record: { status: 'open' },
    payload: { ownerPrincipalId: owner.id }, worker_conversation_binding: binding }
  const pool = { query: vi.fn(async (sql: string) => {
    if (sql.includes('from management_principals')) return { rows: [owner] }
    if (sql.includes('from provider_account_accepted_bindings')) return { rows: [{ binding: binding.accountBinding }] }
    return { rows: [conversation], rowCount: 1 }
  }) } as unknown as pg.Pool
  const prepareFiles = vi.fn(async () => undefined)
  const frames: WorkerConversationRpcRequest[] = []
  let connection = f.connection
  const request = async (raw: unknown) => {
    const request = WorkerConversationRpcRequestSchema.parse(raw)
    receipt.connection = connection
    frames.push(request)
    if (request.method === 'conversation.start-turn') {
      if (fileInputs) {
        await production.bridge.handle({ method: 'conversation.files', binding, admissionId: request.admissionId,
          session: f.session, correlationId: request.correlationId,
          action: { phase: 'prepare', executionHostId: 'attachment-host' } }, connection, AbortSignal.timeout(1000))
      }
      receipt.turns.push({ correlationId: request.correlationId,
        inputHash: commandInputHash({ prompt: request.prompt, mode: request.sessionMode ?? 'regular',
          preferences: request.preferences ?? null }),
        status: 'completed', nativeTurnId: 'next-native-turn', result: { outcome: 'succeeded' } })
      receipt.revision++
    }
    if (request.method === 'conversation.history') return { payload: { receipt, context: null,
      history: { events: [], pendingInteractions: [], nextSequence: 0 } } }
    if (request.method === 'conversation.cancel') return { payload: { canceled: true } }
    return { payload: { receipt } }
  }
  let channel = { binding: connection, request }
  const filesystem = { device: '1', inode: '1', mountId: '1' }
  const roots = { binding: f.connection, request: async () => ({ payload: {
    schemaVersion: 1, hostRef: binding.profile.target.hostRef,
    applicationInstallationId: f.connection.workerInstallationId, configurationRevision: '1',
    bases: [{ baseId: randomUUID(), canonicalPath: '/approved', filesystem, accessModes: ['read-write'] }],
    managedRuntimeRoot: root, runtimeFilesystem: filesystem,
  } }) }
  const profiles = { admit: vi.fn(async () => ({ override: {
    configuration: f.configuration.harness, target: binding.profile.target,
  } })), revalidate: vi.fn(async () => {}) }
  const production = createProductionWorkerConversations({ pool,
    endpoint: () => ({ captureRequest: (_device: string, namespace: string) =>
      namespace === WORKSPACE_ROOT_EXTENSION.namespace ? roots : channel }),
    profiles, claudeProfiles: profiles,
    operators: { configuration: async () => f.configuration }, agents: {}, registry: {}, qualifications: {},
    suiteRevisions: {}, access: {}, mcpForward: () => ({}), files: () => prepareFiles,
  } as unknown as Parameters<typeof createProductionWorkerConversations>[0])
  const manager = production.create({ conversationId: conversation.id, configuration: accepted,
    workingDirectory: '/main/runtime', appMcpAccess: binding.appMcpAccess, ...(fileInputs ? { fileInputs } : {}) })
  try {
    if (restored) {
      const turn = { prompt: 'Queued follow-up', clientCorrelationId: 'queued-request' }
      const prepared = await preflightChatInput({ content: turn.prompt }, {
        workerRequired: true, prompt: turn.prompt,
        prepare: async () => prepareWorkerChatInput({ binding, configuration: f.configuration,
          bridge: production.bridge, channel, current: async () => {} }, { kind: 'turn', session: f.session, input: turn }),
      })
      restoreAcceptedChatInput(manager, turn.clientCorrelationId, prepared)
      expect(frames).toEqual([])
    }
    await expect(manager.attachSession(f.session, { kind: 'operator', configuration: accepted,
      correlationId: nativeCorrelation(conversation.id, 'next-turn'), workingDirectory: '/main/runtime' }))
      .resolves.toEqual(f.session)
    const events = []
    for await (const event of manager.startTurn(f.session, { prompt: 'Continue',
      clientCorrelationId: nativeCorrelation(conversation.id, 'next-turn') })) events.push(event)
    expect(events).toEqual([])
    expect(prepareFiles).toHaveBeenCalledTimes(fileInputs ? 1 : 0)
    if (fileInputs) expect(frames.find(frame => frame.method === 'conversation.start-turn')).toMatchObject({ fileInputs: true })
    expect(frames.filter(frame => frame.method === 'conversation.start-turn')).toHaveLength(1)
    expect(frames.find(frame => frame.method === 'conversation.open')).toMatchObject({
      mode: 'attach', binding, configuration: f.configuration,
    })
    expect(receipt.turns[0]).toEqual(firstSnapshot)
    expect(conversation.worker_conversation_binding).toEqual(binding)
    expect(commandInputHash(f.configuration)).toBe(binding.owner.configurationHash)
    connection = { ...connection, connectionGeneration: 2, connectionEpoch: randomUUID() }
    channel = { binding: connection, request }
    await expect(manager.history(f.session)).resolves.toMatchObject({ events: [] })
    await expect(manager.cancel(f.session)).resolves.toBe(true)
    expect(frames.filter(frame => frame.method === 'conversation.open')).toHaveLength(2)
    channel = { binding: { ...connection, workerInstallationId: randomUUID() }, request }
    await expect(manager.history(f.session)).rejects.toMatchObject({ code: 'WORKER_CONVERSATION_UNAVAILABLE' })
    channel = { binding: connection, request }
    owner.grants = [{ actions: ['operator_chat:read'], scope: {} }]
    await expect(manager.attachSession(f.session, { kind: 'operator', configuration: accepted,
      correlationId: 'denied', workingDirectory: '/main/runtime' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await expect(manager.dispose!()).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  } finally { await production.close() }
})

it('rejects execution, profile, owner and bound-hash changes during a presentation transition', () => {
  const f = workerConversationFixture()
  const configuration = f.configuration
  if (!('operatorId' in configuration)) throw new Error('Operator fixture required')
  const accepted = { ...configuration, id: 'presentation', version: 2, showThinking: true }
  expect(workerExecutionConfiguration(f.binding, accepted, configuration)).toEqual(configuration)
  for (const candidate of [
    { ...accepted, harness: { ...accepted.harness, model: 'different' } },
    { ...accepted, operatorId: 'other-owner' },
    { ...accepted, harnessProfileSelection: { ...f.binding.profile, instanceRevision: 'other-profile' } },
  ]) expect(() => workerExecutionConfiguration(f.binding, candidate, configuration)).toThrow()
  expect(() => workerExecutionConfiguration({ ...f.binding, owner: { ...f.binding.owner,
    configurationHash: '0'.repeat(64) } }, accepted, configuration)).toThrow()
})

it.each([['codex', false, false, 'persisted'], ['codex', true, false, 'persisted'],
  ['claude', false, false, 'persisted'], ['claude', true, false, 'persisted'],
  ['codex', true, true, 'persisted'], ['codex', true, true, 'unobserved'],
  ['claude', true, true, 'unobserved']] as const)(
  'recovers journaled %s creation through production (Worker restarted: %s, preview generation: %s, binding: %s)',
  async (harness, restarted, previewGeneration, bindingObservation) => {
  const f = workerConversationFixture('agent', harness)
  if (!('agentId' in f.configuration) || f.binding.owner.kind !== 'agent') throw new Error('Agent fixture required')
  const binding = { ...f.binding,
    ...(previewGeneration ? { sessionGeneration: 'preview-configuration' } : {}),
    accountBinding: legacyProviderAccountBinding(f.configuration.harness, f.configuration.harnessProfileSelection)! }
  const principal = { id: 'owner', name: 'Owner', audience: 'operator', delegated_from: null,
    grants: [{ actions: ['agent_chat:read', 'agent_chat:write'], scope: {} }],
    expires_at: new Date(Date.now() + 600_000), revoked_at: null }
  const conversation = { id: binding.owner.conversationId, kind: 'agent', workspace_id: f.configuration.workspaceId,
    workflow_id: agentOwner(binding.owner).workflowId, workflow_node_id: agentOwner(binding.owner).workflowNodeId,
    agent_id: f.configuration.agentId, agent_configuration_version_id: f.configuration.id,
    active_request_id: 'request', native_session_id: null, deleted_at: null,
    owner_principal_id: principal.id, payload: { ownerPrincipalId: principal.id }, record: { status: 'open',
      ...(previewGeneration ? { workerSessionGeneration: binding.sessionGeneration } : {}) },
    worker_conversation_binding: bindingObservation === 'persisted' ? binding : null }
  const pool = { query: vi.fn(async (sql: string, parameters?: unknown[]) => {
    if (sql.includes('from management_principals')) return { rows: [principal] }
    if (sql.includes('from provider_account_accepted_bindings')) return { rows: [{ binding: binding.accountBinding }] }
    if (sql.startsWith('update operator_conversations set worker_conversation_binding')) {
      conversation.worker_conversation_binding = JSON.parse(parameters![1] as string)
    }
    return { rows: [conversation], rowCount: 1 }
  }) } as unknown as pg.Pool
  const operationId = 'original-creation'
  const receipt: WorkerConversationReceipt = { binding, connection: f.connection, session: f.session,
    nativeOwner: f.nativeOwner, revision: 2, closing: false, closed: false,
    creation: { operationId, inputHash: commandInputHash(harness === 'claude'
      ? { mode: 'initial-turn', correlationId: operationId }
      : { mode: 'create', source: null, preferences: null }) },
    turns: harness === 'claude' ? [{ correlationId: operationId, inputHash: commandInputHash('original prompt'),
      status: 'uncertain', nativeTurnId: null, sessionMode: 'regular', creationOperationId: operationId }] : [],
    compactions: [], desiredPreferences: null, appliedPreferences: null }
  const originalCreation = structuredClone(receipt.creation)
  const originalTurns = structuredClone(receipt.turns)
  const connection = restarted ? { ...f.connection, bootId: randomUUID(), connectionEpoch: randomUUID(),
    connectionGeneration: 2 } : f.connection
  const methods: string[] = []
  const channel = { binding: connection, request: async (raw: unknown) => {
    const request = WorkerConversationRpcRequestSchema.parse(raw)
    methods.push(request.method)
    if (request.method === 'conversation.status') {
      expect(request.binding).toEqual(binding)
      return { payload: { receipt: structuredClone(receipt) } }
    }
    if (request.method === 'conversation.release-runtime') {
      expect(request.session).toEqual(f.session)
      if (receipt.turns.some(turn => !['completed', 'rejected'].includes(turn.status))) {
        throw new DomainError('WORKER_CONVERSATION_UNAVAILABLE', 'Finish the active operation before releasing its native process.', 409)
      }
      expect(receipt.turns).toEqual([])
      receipt.runtimeReleased = true
      receipt.revision++
      return { payload: { receipt: structuredClone(receipt) } }
    }
    if (request.method !== 'conversation.open' || request.mode !== 'attach') {
      throw new Error('Creation recovery may only inspect the journal and attach its original session')
    }
    expect(request).toMatchObject({ mode: 'attach', operationId, source: f.session, binding,
      configuration: f.configuration })
    expect(request).not.toHaveProperty('prompt')
    receipt.connection = connection
    receipt.revision++
    return { payload: { receipt: structuredClone(receipt) } }
  } }
  const profiles = { admit: async () => ({ override: { configuration: f.configuration.harness,
    target: binding.profile.target } }), revalidate: async () => {} }
  const production = createProductionWorkerConversations({ pool, endpoint: () => ({ captureRequest: () => channel }),
    profiles, claudeProfiles: profiles, operators: {}, agents: {}, registry: {}, qualifications: {},
    suiteRevisions: {}, access: {}, mcpForward: () => ({}),
  } as unknown as Parameters<typeof createProductionWorkerConversations>[0])
  const manager = production.create({ conversationId: conversation.id, configuration: f.configuration,
    workingDirectory: binding.workingDirectory, appMcpAccess: 'none' })
  try {
    expect(manager.reconcileSessionCreation).toBeTypeOf('function')
    await expect(manager.reconcileSessionCreation!({ kind: 'agent-chat', configuration: f.configuration,
      conversationId: conversation.id, workflowId: agentOwner(binding.owner).workflowId, workflowNodeId: agentOwner(binding.owner).workflowNodeId,
      workingDirectory: binding.workingDirectory, correlationId: operationId })).resolves.toEqual(f.session)
    expect(methods).toEqual(['conversation.status', 'conversation.open'])
    expect(receipt.connection).toEqual(connection)
    expect(receipt.session).toEqual(f.session)
    expect(receipt.creation).toEqual(originalCreation)
    expect(receipt.turns).toEqual(originalTurns)
    expect(conversation.worker_conversation_binding).toEqual(binding)
    await expect(manager.reconcileSessionCreation!({ kind: 'agent-chat', configuration: f.configuration,
      conversationId: conversation.id, workflowId: agentOwner(binding.owner).workflowId, workflowNodeId: agentOwner(binding.owner).workflowNodeId,
      workingDirectory: binding.workingDirectory, correlationId: 'another-creation' })).rejects.toThrow()
    expect(methods).toEqual(['conversation.status', 'conversation.open', 'conversation.status'])
    if (harness === 'claude') {
      await expect(manager.dispose!()).rejects.toThrow('Finish the active operation')
      expect(receipt.runtimeReleased).not.toBe(true)
      expect(receipt.turns).toEqual(originalTurns)
    } else {
      await manager.dispose!()
      expect(receipt.runtimeReleased).toBe(true)
    }
    expect(methods).toEqual(['conversation.status', 'conversation.open', 'conversation.status', 'conversation.release-runtime'])
  } finally { await production.close() }
})
