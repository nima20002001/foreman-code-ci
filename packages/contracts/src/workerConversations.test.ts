import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { WorkerConversationBindingSchema, WorkerConversationRpcRequestSchema,
  WorkerConversationHistorySchema, workerConversationProfileSelection } from './workerConversations.js'
import { AgentConfigurationVersionSchema, DEFAULT_HARNESS_DEFAULTS } from './index.js'

function binding(kind: 'operator' | 'agent' = 'operator') {
  const common = { conversationId: randomUUID(), configurationVersionId: 'saved-configuration',
    configurationHash: `sha256:${'a'.repeat(64)}` }
  const owner = kind === 'operator' ? { ...common, kind, operatorId: 'application-operator' }
    : { ...common, kind, workspaceId: 'workspace', workflowId: 'workflow', workflowNodeId: 'node', agentId: 'agent' }
  return { owner, harness: 'codex', workingDirectory: '/approved/project', appMcpAccess: 'none',
    profile: { instanceId: randomUUID(), instanceRevision: 'profile-revision', target: {
      hostRef: { kind: 'device', mainId: randomUUID(), deviceId: randomUUID() },
      applicationInstallationId: randomUUID(), harnessInstallationId: 'installed-driver', installationFingerprint: 'installation',
    } } }
}

it('reads preview session generations without altering the binding used for native ownership', () => {
  const target = { ...binding('agent'), sessionGeneration: 'preview-configuration' }
  expect(WorkerConversationBindingSchema.parse(target)).toEqual(target)
  expect(WorkerConversationBindingSchema.safeParse({ ...target, generation: randomUUID() }).success).toBe(false)
  expect(WorkerConversationBindingSchema.safeParse({ ...binding('operator'), sessionGeneration: 'preview' }).success).toBe(false)
  expect(WorkerConversationBindingSchema.safeParse({ ...binding('agent'), generation: 'invalid' }).success).toBe(false)
})

function historicalBinding() {
  const target = WorkerConversationBindingSchema.parse(binding('agent'))
  if (target.owner.kind !== 'agent' || target.profile.target.hostRef.kind !== 'device') throw new Error('Agent fixture required')
  const configuration = AgentConfigurationVersionSchema.parse({ id: target.owner.configurationVersionId,
    agentId: target.owner.agentId, workspaceId: target.owner.workspaceId, version: 1,
    contentHash: `sha256:${'b'.repeat(64)}`, createdAt: '2026-10-10T00:00:00.000Z',
    harness: DEFAULT_HARNESS_DEFAULTS.codex, prompt: {}, assignedSkills: [],
    harnessProfileSelection: { ...target.profile, instanceId: randomUUID() } })
  const digest = 'a'.repeat(64)
  const placement = { schemaVersion: 1, mainId: target.profile.target.hostRef.mainId, runId: 'source-run',
    nodeId: target.owner.workflowNodeId, hostRef: target.profile.target.hostRef,
    registration: { workerInstallationId: target.profile.target.applicationInstallationId,
      keyRevision: 1, authorizationRevision: 1 }, mainInstallationId: target.profile.target.hostRef.mainId,
    destination: { canonicalProjectRoot: '/approved/project', canonicalCwd: '/approved/project',
      managedRuntimeRoot: '/managed/runtime', directoryIdentityHash: digest, rootPolicyId: 'root-policy',
      rootPolicyRevision: '1', locationRevision: '1', attestationId: 'attestation', attestationHash: digest },
    source: { revisionId: 'source-revision', manifestDigest: digest, materializationId: 'materialization',
      materializationDigest: digest }, bindingHash: digest,
    payload: { kind: 'agent', agentId: target.owner.agentId, agentConfigurationVersionId: configuration.id,
      driverId: 'codex', driverRevision: 'driver', instanceId: target.profile.instanceId,
      instanceRevision: target.profile.instanceRevision, harnessInstallationId: target.profile.target.harnessInstallationId,
      installationFingerprint: target.profile.target.installationFingerprint,
      runtimeContractVersion: 1, protocolRevision: 'protocol', credentialScopeRefs: [] } }
  const accepted = WorkerConversationBindingSchema.parse({ ...target,
    sourceExecution: { executionId: 'source-execution', placement, workingTree: {
      materializationId: randomUUID(), materializationDigest: digest,
      canonicalProjectRoot: target.workingDirectory, canonicalCwd: target.workingDirectory,
      directoryIdentityHash: digest, filesystem: { device: '1', inode: '2', mountId: '3' },
      accessMode: 'read-only', privateGit: null,
    } } })
  return { accepted, configuration, target }
}

it('binds a historical follow-up to its execution profile while preserving the Agent default configuration', () => {
  const { accepted, configuration, target } = historicalBinding()
  expect(WorkerConversationBindingSchema.safeParse({ ...accepted, workingDirectory: '/another-tree' }).success).toBe(false)
  const before = structuredClone(configuration)
  expect(workerConversationProfileSelection(accepted, configuration)).toEqual(target.profile)
  expect(workerConversationProfileSelection(target, configuration)).toEqual(configuration.harnessProfileSelection)
  expect(configuration).toEqual(before)
  expect(WorkerConversationBindingSchema.safeParse({ ...accepted,
    profile: configuration.harnessProfileSelection }).success).toBe(false)
  expect(WorkerConversationBindingSchema.safeParse({ ...accepted,
    owner: { ...target.owner, workflowNodeId: 'other-node' } }).success).toBe(false)
  expect(WorkerConversationBindingSchema.safeParse({ ...accepted,
    owner: { ...target.owner, configurationVersionId: 'another-configuration' } }).success).toBe(false)
  expect(WorkerConversationBindingSchema.safeParse({ ...accepted, owner: binding().owner }).success).toBe(false)
})

it('keeps Run history separate from the qualified harness and profile used for later chat turns', () => {
  const { accepted, configuration } = historicalBinding()
  const profile = { ...accepted.profile, instanceId: randomUUID(), instanceRevision: 'claude-profile',
    target: { ...accepted.profile.target, harnessInstallationId: 'claude-driver', installationFingerprint: 'claude-installation' } }
  const continued = WorkerConversationBindingSchema.parse({ ...accepted, harness: 'claude', profile,
    owner: { ...accepted.owner, configurationVersionId: 'replacement-configuration',
      configurationHash: `sha256:${'d'.repeat(64)}` },
    sourceConfigurationVersionId: configuration.id })
  const selected = AgentConfigurationVersionSchema.parse({ ...configuration, id: continued.owner.configurationVersionId,
    harness: { harness: 'claude', model: 'model-fixture', authMode: 'subscription',
      configDirectory: '/fixture/claude', permissionMode: 'default', sandbox: 'read-only',
      tools: [], permissionRules: [], instructions: '', mcpServers: {} }, harnessProfileSelection: profile })
  expect(continued.sourceExecution).toEqual(accepted.sourceExecution)
  expect(workerConversationProfileSelection(continued, selected)).toEqual(profile)
  expect(WorkerConversationBindingSchema.safeParse({ ...continued, sourceConfigurationVersionId: undefined }).success).toBe(false)
  expect(WorkerConversationBindingSchema.safeParse({ ...continued, workingDirectory: '/another-tree' }).success).toBe(false)
  expect(WorkerConversationBindingSchema.safeParse({ ...continued,
    sourceConfigurationVersionId: continued.owner.configurationVersionId }).success).toBe(false)
  expect(WorkerConversationBindingSchema.safeParse({ ...continued,
    profile: { ...profile, target: { ...profile.target, applicationInstallationId: randomUUID() } } }).success).toBe(false)
  expect(WorkerConversationBindingSchema.safeParse({ ...continued,
    owner: { ...continued.owner, workflowNodeId: 'another-node' } }).success).toBe(false)
  expect(WorkerConversationBindingSchema.safeParse({ ...continued, appMcpAccess: 'scoped' }).success).toBe(false)
})

it('retains native input response digests and confirmed non-submission during Worker history readback', () => {
  const history = { events: [], pendingInteractions: [],
    nonSubmission: { nativeSessionId: 'original-session', clientCorrelationId: 'original-message',
      result: { outcome: 'failed', error: { code: 'CODEX_TURN_START_REJECTED',
        message: 'The native message was not accepted.', retryable: true } } },
    responseDeliveries: [{ source: 'provider_history', harness: 'codex', providerVersion: '0.154.0',
      nativeSessionId: 'original-session', nativeRequestId: 'original-form', nativeRequestType: 'mcpServer/elicitation/request',
      optionId: 'offered-choice', semantic: 'approve_once', responseDigest: 'a'.repeat(64) }] }
  expect(WorkerConversationHistorySchema.parse(history)).toEqual(history)
  expect(WorkerConversationHistorySchema.safeParse({ ...history, responseDeliveries: [
    { ...history.responseDeliveries[0], responseDigest: 'not-a-digest' },
  ] }).success).toBe(false)
})

it('retains the Claude response message and callback generation on Worker readback', () => {
  const history = { events: [], pendingInteractions: [], responseDeliveries: [{ source: 'provider_history',
    harness: 'claude', providerVersion: 'provider-fixture', nativeSessionId: 'session', nativeRequestId: 'permission',
    nativeRequestType: 'can_use_tool', optionId: 'allow_once', semantic: 'approve_once',
    nativeIdentity: { kind: 'message', nativeMessageId: 'input-message', generation: 'callback-generation' } }] }
  expect(WorkerConversationHistorySchema.parse(history)).toEqual(history)
  expect(WorkerConversationHistorySchema.safeParse({ ...history, responseDeliveries: [{
    ...history.responseDeliveries[0], nativeIdentity: { kind: 'message', nativeMessageId: 'input-message' },
  }] }).success).toBe(false)
})

it('addresses an Operator chat without a workflow dispatch or user-grant surrogate', () => {
  const target = binding()
  expect(WorkerConversationRpcRequestSchema.parse({ method: 'conversation.cancel', binding: target,
    session: { harness: 'codex', providerVersion: 'provider-fixture', nativeSessionId: 'observed-session' } }).binding)
    .toEqual(target)
  expect(WorkerConversationBindingSchema.safeParse({ ...target, grants: ['runs:start'] }).success).toBe(false)
  expect(WorkerConversationRpcRequestSchema.safeParse({ method: 'conversation.cancel', binding: target,
    intent: { runId: 'replacement-run' } }).success).toBe(false)
})

it('keeps two nodes with the same Agent independently addressable', () => {
  const first = WorkerConversationBindingSchema.parse(binding('agent'))
  const second = WorkerConversationBindingSchema.parse({ ...first, owner: { ...first.owner,
    conversationId: randomUUID(), workflowNodeId: 'second-node' } })
  expect(first.owner.conversationId).not.toBe(second.owner.conversationId)
  expect(second.profile).toEqual(first.profile)
})

it('preserves the Agent System prompt snapshot across worker messages and excludes the Operator', () => {
  const systemPrompt = { value: { text: 'Shared startup instructions' }, revision: 2, versionId: 'prompt-version-2' }
  const target = { ...binding('agent'), systemPrompt }
  expect(WorkerConversationBindingSchema.parse(target)).toEqual(target)
  const request = { method: 'conversation.status', binding: target }
  expect(WorkerConversationRpcRequestSchema.parse(request)).toEqual(request)
  expect(WorkerConversationBindingSchema.safeParse({ ...binding('operator'), systemPrompt }).success).toBe(false)
})

it('keeps approval recovery on its native request and rejects a prompt or grants in that request', () => {
  const request = { method: 'conversation.response-reconcile', binding: binding(),
    session: { harness: 'codex', providerVersion: 'provider-fixture', nativeSessionId: 'observed-session' },
    response: { nativeRequestId: 'approval-request', nativeRequestType: 'command',
      option: { optionId: 'approve-once', label: 'Approve once', semantic: 'approve_once',
        persistence: 'request', affectsOtherPendingRequests: false,
        interruptsCurrentTurn: false, mutatesPersistentPolicy: false } } }
  expect(WorkerConversationRpcRequestSchema.parse(request)).toEqual(request)
  expect(WorkerConversationRpcRequestSchema.safeParse({ ...request, prompt: 'Replay task' }).success).toBe(false)
  expect(WorkerConversationRpcRequestSchema.safeParse({ ...request, grants: ['agent_chat:respond'] }).success).toBe(false)
})

it('rejects Main profiles and management MCP authority on worker Agent chats', () => {
  const target = binding('agent')
  expect(WorkerConversationBindingSchema.safeParse({ ...target, appMcpAccess: 'scoped' }).success).toBe(false)
  const local = { ...target, profile: { ...target.profile, target: { ...target.profile.target,
    hostRef: { kind: 'main', mainId: target.profile.target.hostRef.mainId } } } }
  expect(WorkerConversationBindingSchema.safeParse(local).success).toBe(false)
})

it('requires the native session and original request identity on compact retries', () => {
  const request = { method: 'conversation.compact', binding: binding(), requestId: 'compact-request',
    correlationId: 'compact-correlation', session: {
      harness: 'codex', providerVersion: 'provider-fixture', nativeSessionId: 'observed-session' } }
  expect(WorkerConversationRpcRequestSchema.parse(request)).toEqual(request)
  expect(WorkerConversationRpcRequestSchema.safeParse({ ...request, session: undefined }).success).toBe(false)
  expect(WorkerConversationRpcRequestSchema.safeParse({ ...request, requestId: '' }).success).toBe(false)
})
