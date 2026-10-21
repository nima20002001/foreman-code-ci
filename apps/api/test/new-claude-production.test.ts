import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { managementEndpoint } from './support/claudeProduction.js'
import type pg from 'pg'
import { AgentConfigurationVersionSchema, HarnessExecutionSchema, OperatorConfigurationVersionSchema } from '@foreman-code/contracts'
import { WorkflowRunV3Schema, WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { CLAUDE_QUALIFICATION_CHECKS } from '@foreman-code/contracts/claude-qualification'
import type { HostHarnessOverride, HostHarnessProfileEvidence } from '@foreman-code/contracts/harness-registry'
import { AcceptedClaudeProfileAdmission } from '../src/modules/harnesses/instanceSettings/acceptedProfile.js'
import type { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import type { HostHarnessProfileEvidenceRepository } from '../src/modules/harnesses/instanceSettings/profileRepository.js'
import { HarnessInstanceRegistry, localHarnessDrivers } from '../src/modules/harnesses/instanceRegistry.js'
import { HarnessInstallationRegistry } from '../src/modules/harnesses/installationRegistry.js'
import type { ProductionHarnessRegistry } from '../src/modules/harnesses/productionRegistry.js'
import { NativeHarnessFactories } from '../src/modules/harnesses/runtimeFactory.js'
import { productionClaudeManager } from '../src/modules/harnesses/claudeSdk/production.js'
import { ClaudeBoundedQueue } from '../src/modules/harnesses/claudeSdk/queue.js'
import type { ClaudeDomainBinding } from '../src/modules/harnesses/claudeSdk/domainAuthority.js'
import type { ClaudeSdkClient, ClaudeSdkUserMessage } from '../src/modules/harnesses/claudeSdk/port.js'
import type { NativeSessionStart } from '../src/modules/harnesses/port.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { claudeCallbackDatabase } from './support/claudeCallbackDatabase.js'
import { deferred } from './helpers/deferred.js'

const createdAt = '2026-10-01T00:00:00.000Z'
let endpoint: Awaited<ReturnType<typeof managementEndpoint>>
beforeAll(async () => { endpoint = await managementEndpoint('second-turn-token') })
afterAll(async () => { await endpoint.app.close() })
/** Synthetic installed/profile records and redacted SDK frames. Exercises actual
 * admission/domain/factory/manager classes without native or PostgreSQL claims. */
function fixture(surface: 'workflow' | 'operator' | 'agent' | 'selected-run', sharedFactories?: NativeHarnessFactories) {
  const kind = surface === 'selected-run' ? 'agent' : surface
  const target = { hostRef: { kind: 'main' as const, mainId: '77d29f00-408e-4000-8000-000000000001' },
    applicationInstallationId: '77d29f00-408e-4000-8000-000000000001', harnessInstallationId: 'recorded-cli', installationFingerprint: 'recorded-payload' }
  const harness = { harness: 'claude' as const, model: 'recorded-model', authMode: 'subscription' as const,
    configDirectory: '/recorded/profile', permissionMode: 'default' as const, sandbox: 'danger-full-access' as const,
    tools: [], permissionRules: [], instructions: 'Pinned fixture instructions',
    mcpServers: { graphql: { type: 'http' as const, url: endpoint.url } } }
  const override: HostHarnessOverride = { instanceId: 'recorded-profile', instanceRevision: 'profile-1', revision: 1,
    target, presetId: 'recorded', enabled: true, driverId: 'claude', configuration: harness, configurationFingerprint: 'recorded-config', qualification: 'qualified' }
  const pin = { sdkVersion: '0.3.284', sdkIntegrity: 'recorded-integrity', cliVersion: '2.1.284', executableSha256: 'a'.repeat(64),
    profilePath: harness.configDirectory, configRevision: 'profile-1' }
  const proof: HostHarnessProfileEvidence = { target, instanceRevision: override.instanceRevision, configurationFingerprint: override.configurationFingerprint,
    driverId: 'claude', driverRevision: '1', protocolRevision: 'recorded-protocol', suiteRevision: 'recorded-suite', environmentGeneration: 'recorded-env',
    connectionGeneration: 'recorded-connection', authenticated: true, compatible: true, qualified: true, checkedAt: createdAt,
    claudeProof: { pin, checks: Object.fromEntries(CLAUDE_QUALIFICATION_CHECKS.map(check => [check, { state: 'passed' as const,
      source: 'native_scenario' as const, evidenceId: `synthetic:${check}`, evidenceSha256: 'b'.repeat(64) }])) } }
  const instances = new HarnessInstanceRegistry(localHarnessDrivers)
  instances.reload([{ instanceId: override.instanceId, instanceRevision: override.instanceRevision, driverId: 'claude', enabled: true, configuration: harness }])
  const installations = new HarnessInstallationRegistry(instances)
  const launcher = { requested: '/recorded/claude', resolvedLauncher: '/recorded/claude', fingerprint: target.installationFingerprint,
    status: 'installed' as const, interpreter: null, diagnostics: [], environment: { generation: 'recorded-env', provenance: 'terminal' as const, cwd: '/recorded', path: '/recorded' }, checkedAt: createdAt }
  installations.refresh([{ hostRef: target.hostRef, harnessInstallationId: target.harnessInstallationId, installationFingerprint: target.installationFingerprint,
    driverId: 'claude', driverRevision: '1', protocolRevision: proof.protocolRevision, environmentGeneration: proof.environmentGeneration,
    connectionGeneration: proof.connectionGeneration, launcher, observedVersion: pin.cliVersion, installed: true, authenticated: null, compatible: null, qualified: null }])
  const binding = installations.pin({ instanceId: override.instanceId, hostRef: target.hostRef, harnessInstallationId: target.harnessInstallationId,
    environmentGeneration: proof.environmentGeneration, connectionGeneration: proof.connectionGeneration })
  const client = {} as pg.PoolClient
  const profiles = new AcceptedClaudeProfileAdmission<ClaudeDomainBinding>(
    { readAuthorized: async <T>(read: (sql: pg.PoolClient) => Promise<T>) => read(client), latest: async () => override, lockRevision: async () => {} } as unknown as HarnessInstanceSettingsRepository,
    { latest: async () => proof } as unknown as HostHarnessProfileEvidenceRepository,
    { authorize: async () => {}, current: async () => ({ registry: binding, applicationInstallationId: target.applicationInstallationId, suiteRevision: proof.suiteRevision, pin }), assertCurrent: value => installations.assertCurrent(value) })
  const agent = AgentConfigurationVersionSchema.parse({ id: 'configuration-1', workspaceId: 'workspace', agentId: 'agent', productRole: 'coder', version: 1,
    harness, prompt: {}, assignedSkills: [], contentHash: `sha256:${'0'.repeat(64)}`, createdAt })
  const operator = OperatorConfigurationVersionSchema.parse({ id: 'configuration-1', operatorId: 'operator', version: 1, harness, contentHash: `sha256:${'0'.repeat(64)}`, createdAt })
  const version = WorkflowVersionV3Schema.parse({ id: 'version', workspaceId: 'workspace', workflowId: 'workflow', version: 1, executionSemanticsVersion: 3,
    entryNodeId: 'node', approval: { handler: 'user' }, agentConfigurationVersionIds: { agent: agent.id }, contentHash: `sha256:${'0'.repeat(64)}`, createdAt,
    definition: { id: 'workflow', workspaceId: 'workspace', name: 'Synthetic replay', version: 1, executionSemanticsVersion: 3, entryNodeId: 'node', approval: { handler: 'user' },
      executionCondition: { kind: 'manual' }, executionPolicy: { maxParallelism: 1, maxNodeExecutions: 1 }, nodes: [{ id: 'node', agentId: 'agent', name: 'Agent' }], edges: [] } })
  const run = WorkflowRunV3Schema.parse({ id: 'run', workspaceId: 'workspace', workflowId: 'workflow', workflowVersionId: version.id, executionSemanticsVersion: 3,
    agentConfigurationVersionIds: version.agentConfigurationVersionIds, approval: version.approval, executionCondition: { kind: 'manual' }, executionState: 'running', outcome: 'pending', input: {}, createdAt })
  const execution = HarnessExecutionSchema.parse({ id: 'execution', runId: 'run', workflowNodeId: 'node', agentId: 'agent', agentConfigurationVersionId: agent.id, attempt: 1, state: 'starting', input: {}, createdAt })
  const row = { kind, owner_principal_id: 'sender', workspace_id: 'workspace', workflow_id: 'workflow', origin_run_id: surface === 'selected-run' ? 'selected-run' : null,
    active_request_id: 'request-1', native_session_id: null, provider_version: null, cancel_requested: false, deleted_at: null, record: { status: 'open' }, payload: { ownerPrincipalId: 'sender' } }
  const callbacks = claudeCallbackDatabase()
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    const callbackResult = callbacks(sql, values)
    if (callbackResult) return callbackResult
    if (sql.includes("payload#>>'{nativeSubmission,clientCorrelationId}'")) return { rows: [], rowCount: 0 }
    const rows = sql.includes('e.record as execution') ? [{ run, version, execution, configuration: agent, attempt: 1, stopped: false,
      execution_closed: false, native_reference: null, finalized: false, generation: null, native_owner: null, budget_active: true }]
      : sql.includes("record->>'authorizationPrincipalId'") ? [{ principal_id: 'sender' }]
        : sql.includes('from management_principals where id=') ? [{ id: 'sender', name: 'Recorded sender', audience: 'operator', grants: [{ actions: ['runs:start', 'operator_chat:read', 'operator_chat:write', 'agent_chat:read', 'agent_chat:write'], scope: {} }], expires_at: new Date('2099-01-01'), revoked_at: null, delegated_from: null }]
          : sql.includes('join operator_conversation_turns t') || sql.startsWith('select active_request_id from operator_conversations')
            ? [row] : undefined
    if (!rows) throw new Error('Unexpected SQL in fixture: ' + sql.slice(0, 80))
    return { rows }
  })
  const pool = { query } as unknown as pg.Pool
  const owner = { runId: 'run', client: pool, assertOwned: () => {}, readOneShotFence: async () => ({ ownerId: 'recorded-owner', fence: 'recorded-fence' }) } as unknown as RunOwnership
  const domain: ClaudeDomainBinding = kind === 'workflow' ? { kind, runId: 'run', executionId: 'execution', attempt: 1, getOwner: () => owner }
    : kind === 'operator' ? { kind, conversationId: surface, repository: new PostgresOperatorConversationRepository(pool) }
      : { kind: 'agent', conversationId: surface, workspaceId: 'workspace', repository: new PostgresAgentChatRepository(pool) }
  const start: NativeSessionStart = kind === 'operator' ? { kind: 'operator', correlationId: `${surface}:request-1`, configuration: operator, workingDirectory: '/recorded/work' }
    : { kind: 'workflow', correlationId: `${surface}:request-1`, request: { executionId: 'execution', runId: 'run', workspaceId: 'workspace', workflowNodeId: 'node', workingDirectory: '/recorded/work', runtimeDirectory: '/recorded/runtime', configuration: agent, input: {} } }
  const frames = new ClaudeBoundedQueue<unknown>(64), ready = deferred<AsyncIterator<ClaudeSdkUserMessage>>()
  const setMcpServers = vi.fn(async () => ({ added: ['graphql'], removed: [], errors: {} }))
  const sdkQuery = vi.fn<ClaudeSdkClient['query']>(options => {
    ready.resolve(options.prompt[Symbol.asyncIterator]())
    return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](), close: () => frames.close(), interrupt: async () => undefined,
      initializationResult: async () => ({}), setMcpServers,
      mcpServerStatus: async () => [{ name: 'graphql', status: 'connected', config: { type: 'http', url: harness.mcpServers.graphql.url }, tools: [] }] }
  })
  const sdk: ClaudeSdkClient = { sdkVersion: pin.sdkVersion, query: sdkQuery, getSessionInfo: async sessionId => ({ sessionId }),
    getSessionMessages: async () => [], forkSession: async () => ({ sessionId: 'recorded-fork' }) }
  const loadClient = vi.fn(async () => sdk)
  const factories = sharedFactories ?? new NativeHarnessFactories({ codexBinary: '/forbidden-codex', instances, installations,
    installationDiscovery: async () => launcher })
  const result = productionClaudeManager({ pool, factories, registry: { pinOverride: () => binding } as unknown as ProductionHarnessRegistry,
    profiles, selector: { instanceId: override.instanceId, instanceRevision: override.instanceRevision, target }, binding: domain,
    role: kind === 'agent' ? 'agent-chat' : kind, configuration: harness, workingDirectory: '/recorded/work', ownerAgentId: surface,
    recovery: { root: '/forbidden-native-recovery', owner: surface }, appMcpAccess: kind === 'agent' ? 'none' : 'scoped', mode: 'replay',
    inspectionStart: async () => start, loadClient })
  return { ...result, start, profiles, proof, ready, frames, sdkQuery, loadClient, query, factories, setMcpServers, harness, binding, installations, launcher, sdk }
}

function queries(f: ReturnType<typeof fixture>, resumeHealth = 'connected', acknowledge = true) {
  const opened: Array<{ options: Readonly<Record<string, unknown>>; frames: ClaudeBoundedQueue<unknown>;
    setMcpServers: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>;
    messages: ClaudeSdkUserMessage[] }> = []
  f.sdk.query = input => {
    const frames = new ClaudeBoundedQueue<unknown>(64)
    const query = { options: input.options, frames, messages: [] as ClaudeSdkUserMessage[],
      setMcpServers: vi.fn(async () => ({ added: input.options.resume && !acknowledge ? [] : ['graphql'], removed: [], errors: {} })),
      status: vi.fn(async () => [{ name: 'graphql', status: input.options.resume ? resumeHealth : 'connected',
        config: { type: 'http', url: f.harness.mcpServers.graphql.url }, tools: [] }]), close: vi.fn(() => frames.close()) }
    opened.push(query)
    void (async () => {
      for await (const message of input.prompt) {
        query.messages.push(message)
        void frames.offer({ type: 'system', subtype: 'init', session_id: 'recorded-session', claude_code_version: '2.1.284', cwd: '/recorded/work' })
        void frames.offer({ type: 'assistant', uuid: `reply:${message.uuid}`, session_id: 'recorded-session', user_message_uuid: message.uuid,
          parent_tool_use_id: null, message: { id: `api:${message.uuid}`, content: [{ type: 'text', text: 'Recorded reply' }] } })
        void frames.offer({ type: 'result', uuid: `result:${message.uuid}`, session_id: 'recorded-session', user_message_uuid: message.uuid,
          subtype: 'success', is_error: false, result: 'Recorded reply' })
      }
    })()
    return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](), close: query.close, interrupt: async () => undefined,
      initializationResult: async () => ({}), setMcpServers: query.setMcpServers, mcpServerStatus: query.status }
  }
  return opened
}
const savedSession = { harness: 'claude' as const, providerVersion: '2.1.284', nativeSessionId: 'recorded-session' }
async function scopedInspection(f: ReturnType<typeof fixture>) {
  await f.manager.prepareInspection(f.start)
  const start = { ...f.start, environment: { agentId: 'operator', variables: { GRAPHQL_MCP_TOKEN: 'second-turn-token' } } }
  const servers = { graphql: { ...f.harness.mcpServers.graphql, headers: { Authorization: 'Bearer second-turn-token' } } }
  const inspection = await f.manager.refreshInspectionCredentials(start, servers)
  return { start, servers, inspection }
}
async function drain<T>(events: AsyncIterable<T>) { const values: T[] = []; for await (const event of events) values.push(event); return values }

describe('NEW-CLAUDE F-13 exact resumed query', () => {
  it('disposes the first production turn and acknowledges scoped credentials on the second turn resumed query before input', async () => {
    const first = fixture('operator'), firstQueries = queries(first)
    const observed = vi.fn(async () => undefined)
    try {
      await drain(first.manager.startInitialTurn(first.start, { prompt: 'First', clientCorrelationId: first.start.correlationId!, onSessionObserved: observed }))
      expect(observed).toHaveBeenCalledExactlyOnceWith(savedSession)
    } finally { await first.manager.dispose?.() }
    expect(firstQueries[0]!.close).toHaveBeenCalledOnce()

    const f = fixture('operator'), opened = queries(f)
    try {
      const { start, servers, inspection } = await scopedInspection(f)
      const attached = await f.manager.attachSession(savedSession, start)
      expect(attached).toEqual(savedSession)
      expect(opened).toHaveLength(2)
      const resumed = opened[1]!
      expect(resumed.options.resume).toBe(savedSession.nativeSessionId)
      expect(resumed.setMcpServers).toHaveBeenCalledExactlyOnceWith(servers)
      expect(resumed.status).toHaveBeenCalledOnce()
      expect(opened[0]!.close).toHaveBeenCalledOnce()
      const actual = await f.manager.prepareInspection(start)
      expect(actual.generation).not.toBe(inspection.generation)
      expect(actual.httpCredentialAcknowledgement).toMatchObject({ generation: actual.generation, authorizationScope: actual.currentAuthorizationScope })
      expect((await f.factories.inspector(f.manager).inspect({ harness: 'claude', runnerId: 'runner', workingDirectory: '/recorded/work', serverName: 'graphql' })).generation).toBe(actual.generation)
      expect(JSON.stringify(actual)).not.toContain('second-turn-token')
      expect((await drain(f.manager.startTurn(attached, { prompt: 'Second', clientCorrelationId: 'operator:second' }))).at(-1)?.type).toBe('turn.completed')
      expect(resumed.messages).toHaveLength(1)
      expect(opened[0]!.messages).toHaveLength(0)
      expect((await f.manager.reconcile(attached, 'operator:second')).terminalResult?.output).toBe('Recorded reply')
    } finally { await f.manager.dispose?.() }
  })
  it('requires the resumed query to acknowledge its own scoped header update', async () => {
    const f = fixture('operator'), opened = queries(f, 'connected', false)
    try {
      const { start } = await scopedInspection(f)
      await expect(f.manager.attachSession(savedSession, start)).rejects.toThrow('did not confirm')
      expect(opened.every(query => query.messages.length === 0)).toBe(true)
    } finally { await f.manager.dispose?.() }
  })
  it.each(['failed', 'needs-auth', 'pending'])('blocks resumed input when its own MCP health is %s', async health => {
    const f = fixture('operator'), opened = queries(f, health)
    try {
      const { start } = await scopedInspection(f)
      await expect(f.manager.attachSession(savedSession, start)).rejects.toThrow('resumed')
      expect(opened.every(query => query.messages.length === 0)).toBe(true)
    } finally { await f.manager.dispose?.() }
  })
  it('rejects resume that differs from the exact inspected owner before opening another query', async () => {
    const f = fixture('operator'), opened = queries(f)
    try {
      const { start } = await scopedInspection(f)
      await expect(f.manager.attachSession(savedSession, { ...start, correlationId: 'foreign-owner' })).rejects.toThrow('inspected')
      expect(opened).toHaveLength(1)
    } finally { await f.manager.dispose?.() }
  })
})
