import { describe, expect, it, vi } from 'vitest'
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
import { deferred } from './helpers/deferred.js'

const createdAt = '2026-10-01T00:00:00.000Z'
/** Synthetic installed/profile records and redacted SDK frames. Exercises actual
 * admission/domain/factory/manager classes without native or PostgreSQL claims. */
function fixture(surface: 'workflow' | 'operator' | 'agent' | 'selected-run', sharedFactories?: NativeHarnessFactories, credentials: { authMode?: 'api-key' | 'subscription'; apiKey?: string } = {}) {
  const kind = surface === 'selected-run' ? 'agent' : surface
  const target = { hostRef: { kind: 'main' as const, mainId: '77d29f00-408e-4000-8000-000000000001' },
    applicationInstallationId: '77d29f00-408e-4000-8000-000000000001', harnessInstallationId: 'recorded-cli', installationFingerprint: 'recorded-payload' }
  const harness = { harness: 'claude' as const, model: 'recorded-model', authMode: credentials.authMode ?? 'subscription',
    configDirectory: '/recorded/profile', permissionMode: 'default' as const, sandbox: 'danger-full-access' as const,
    tools: [], permissionRules: [], instructions: 'Pinned fixture instructions', mcpServers: { graphql: { type: 'http' as const, url: 'http://127.0.0.1:3000/mcp' } } }
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
  const query = vi.fn(async (sql: string) => {
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
    inspectionStart: async () => start, loadClient, ...(credentials.apiKey !== undefined ? { apiKey: credentials.apiKey } : {}) })
  return { ...result, start, profiles, proof, ready, frames, sdkQuery, loadClient, query, factories, setMcpServers, harness, binding, installations, launcher, sdk }
}

describe('NEW-CLAUDE F-14 explicitly provisioned production authentication', () => {
  it('launches an exactly qualified API-key profile with only the explicitly supplied credential', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'inherited-key-must-not-be-used')
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'inherited-oauth-must-not-be-used')
    const f = fixture('operator', undefined, { authMode: 'api-key', apiKey: 'explicit-profile-key' })
    try {
      await f.manager.prepareInspection(f.start)
      expect(f.sdkQuery).toHaveBeenCalledOnce()
      expect(f.sdkQuery.mock.calls[0]![0].options.env).toMatchObject({ ANTHROPIC_API_KEY: 'explicit-profile-key', CLAUDE_CONFIG_DIR: '/recorded/profile' })
      expect(f.sdkQuery.mock.calls[0]![0].options.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN')
      expect(f.loadClient).toHaveBeenCalledOnce()
      expect(f.harness).not.toHaveProperty('apiKey')
    } finally { await f.manager.dispose?.(); vi.unstubAllEnvs() }
  })
  it('requires explicit delivery even when an API key is present in the parent environment', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'inherited-key-must-not-be-used')
    const f = fixture('operator', undefined, { authMode: 'api-key' })
    try {
      await expect(f.manager.capabilities()).rejects.toMatchObject({
        code: 'CLAUDE_API_KEY_DELIVERY_UNAVAILABLE', status: 409,
      })
      await expect(f.manager.prepareInspection(f.start)).rejects.toMatchObject({
        code: 'CLAUDE_API_KEY_DELIVERY_UNAVAILABLE', status: 409,
      })
      expect(f.loadClient).not.toHaveBeenCalled()
      expect(f.sdkQuery).not.toHaveBeenCalled()
    } finally { await f.manager.dispose?.(); vi.unstubAllEnvs() }
  })
  it('launches subscription mode without delivering inherited authentication secrets', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'inherited-key-must-not-be-used')
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'inherited-oauth-must-not-be-used')
    const f = fixture('operator')
    try {
      await f.manager.prepareInspection(f.start)
      expect(f.sdkQuery).toHaveBeenCalledOnce()
      expect(f.sdkQuery.mock.calls[0]![0].options.env).not.toHaveProperty('ANTHROPIC_API_KEY')
      expect(f.sdkQuery.mock.calls[0]![0].options.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN')
      expect(f.sdkQuery.mock.calls[0]![0].options.env).toMatchObject({ CLAUDE_CONFIG_DIR: '/recorded/profile' })
    } finally { await f.manager.dispose?.(); vi.unstubAllEnvs() }
  })
  it('rejects an explicitly supplied API key in subscription mode before loading the SDK', async () => {
    const f = fixture('operator', undefined, { apiKey: 'explicit-profile-key' })
    try {
      await expect(f.manager.capabilities()).rejects.toThrow('Subscription mode cannot receive an API key')
      expect(f.loadClient).not.toHaveBeenCalled()
    } finally { await f.manager.dispose?.() }
  })
})
