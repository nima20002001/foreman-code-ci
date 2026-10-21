import { afterEach, describe, expect, it, vi } from 'vitest'
import { OperatorConfigurationVersionSchema, withAdvancedDefaults, type HarnessQualification } from '@foreman-code/contracts'
import type { HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import type pg from 'pg'
import { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { NativeHarnessFactories } from '../src/modules/harnesses/runtimeFactory.js'
import { NativeHarnessConfigurationQualifier } from '../src/modules/harnesses/nativeConfigurationQualifier.js'
import { NativeConfigurationService } from '../src/modules/harnesses/nativeConfiguration.js'
import { ProductionHostHarnessProfileQualifier } from '../src/modules/harnesses/productionProfileQualifier.js'
import type { ProductionHarnessRegistry } from '../src/modules/harnesses/productionRegistry.js'
import { input } from './fixtures/codex-test-helpers.js'
import { commandInputHash } from '../src/modules/commands/postgres.js'
import { WorkerExecutionPolicy } from '../src/modules/settings/workerExecution.js'
import { productionClaudeManager } from '../src/modules/harnesses/claudeSdk/production.js'
import type { ClaudeDomainBinding } from '../src/modules/harnesses/claudeSdk/domainAuthority.js'
import type { AcceptedClaudeProfileAdmission } from '../src/modules/harnesses/instanceSettings/acceptedProfile.js'
import type { ClaudeProfileOwner } from '../src/modules/harnesses/claudeSdk/production.js'
import type { NativeSessionStart } from '../src/modules/harnesses/port.js'
import { requireClaudeProductionCredentialDelivery } from '../src/modules/harnesses/claudeSdk/productionCredentials.js'

const harness = { harness: 'claude' as const, model: 'recorded-model', authMode: 'api-key' as const,
  configDirectory: '/recorded/profile', permissionMode: 'default' as const, sandbox: 'read-only' as const,
  tools: [], permissionRules: [], instructions: '', mcpServers: {} }
const blocked = { code: 'CLAUDE_API_KEY_DELIVERY_UNAVAILABLE', status: 409 }
const qualified: HarnessQualification = { harness: 'claude', version: 'recorded', authenticated: true, ready: true,
  structuredEvents: true, supportsResume: true, supportsCancellation: true, supportsWorkingDirectory: true,
  supportsStartupPrompt: true, supportedNativeTools: [], supportedSettings: [], unsupportedCapabilities: [] }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('production without an authorized Claude credential source', () => {
  it.each(['workflow', 'operator', 'agent-chat'] as const)('refuses %s API-key preparation before profile admission or SDK setup', async role => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-inherited-key')
    const pool = {} as pg.Pool
    const factories = new NativeHarnessFactories({ codexBinary: '/nonexistent-recorded-codex' })
    const admit = vi.fn(async () => { throw new Error('Unexpected profile admission') })
    const loadClient = vi.fn(async () => { throw new Error('Unexpected SDK load') })
    const resolve = vi.fn(async () => null)
    const agent = { ...input('/recorded/work').request.configuration, harness }
    let binding: ClaudeDomainBinding
    let start: NativeSessionStart
    if (role === 'workflow') {
      binding = { kind: 'workflow', runId: 'run', executionId: 'execution', attempt: 1, getOwner: () => undefined }
      start = { request: { ...input('/recorded/work').request, configuration: agent } }
    } else if (role === 'operator') {
      binding = { kind: 'operator', conversationId: 'conversation', repository: new PostgresOperatorConversationRepository(pool) }
      const configuration = OperatorConfigurationVersionSchema.parse({ id: 'configuration', operatorId: 'operator',
        version: 1, harness, contentHash: 'sha256:fixture', createdAt: '2026-10-01T00:00:00.000Z' })
      start = { kind: 'operator', correlationId: 'request', configuration, workingDirectory: '/recorded/work' }
    } else {
      binding = { kind: 'agent', conversationId: 'conversation', workspaceId: 'workspace', repository: new PostgresAgentChatRepository(pool) }
      start = { kind: 'agent-chat', conversationId: 'conversation', workflowId: 'workflow', workflowNodeId: 'node',
        correlationId: 'request', configuration: agent, workingDirectory: '/recorded/work' }
    }
    const production = productionClaudeManager({ pool, factories, registry: {} as ProductionHarnessRegistry,
      profiles: { admit } as unknown as AcceptedClaudeProfileAdmission<ClaudeProfileOwner>,
      binding, role, configuration: harness, workingDirectory: '/recorded/work', ownerAgentId: 'agent',
      accounts: { resolve }, recovery: { root: '/unused', owner: role }, appMcpAccess: role === 'agent-chat' ? 'none' : 'scoped',
      inspectionStart: async () => start, mode: 'native', loadClient })
    try {
      expect(resolve).not.toHaveBeenCalled()
      expect(admit).not.toHaveBeenCalled()
      await expect(production.manager.prepareInspection(start)).rejects.toMatchObject(blocked)
      expect(resolve).not.toHaveBeenCalled()
      expect(admit).not.toHaveBeenCalled()
      expect(loadClient).not.toHaveBeenCalled()
    } finally {
      await production.manager.dispose?.()
    }
  })

  it('uses the selected local account key and refuses a missing key or remote account', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'inherited-key')
    const configuration = { ...harness, accountId: 'managed-account' }
    let apiKey = 'provisioned-key'
    const resolve = vi.fn(async () => ({ accountId: configuration.accountId,
      homePath: configuration.configDirectory, authMode: 'api-key' as const, apiKey }))
    expect(await requireClaudeProductionCredentialDelivery(configuration, { resolve })).toBe('provisioned-key')
    expect(resolve).toHaveBeenCalledWith('claude', configuration.accountId)
    apiKey = '  '
    await expect(requireClaudeProductionCredentialDelivery(configuration, { resolve })).rejects.toMatchObject(blocked)
    const host = { kind: 'device' as const, mainId: '00000000-0000-4000-8000-000000000001',
      deviceId: '00000000-0000-4000-8000-000000000002' }
    const calls = resolve.mock.calls.length
    await expect(requireClaudeProductionCredentialDelivery(configuration, { resolve }, host))
      .rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_TARGET_CONFLICT' })
    expect(resolve).toHaveBeenCalledTimes(calls + 1)
    expect(resolve).toHaveBeenLastCalledWith('claude', configuration.accountId)
  })

  it('refuses launch-ready defaults qualification before querying a native factory', async () => {
    const qualifyConfiguration = vi.fn(async () => qualified)
    const qualifier = new NativeHarnessConfigurationQualifier('/unused', { qualifyConfiguration } as unknown as NativeHarnessFactories)
    await expect(Promise.resolve().then(() => qualifier.qualify(harness, '/recorded/work'))).rejects.toMatchObject(blocked)
    expect(qualifyConfiguration).not.toHaveBeenCalled()
  })

  it('refuses the configuration metadata readiness port before consuming qualified profile evidence', async () => {
    const qualify = vi.fn(async () => qualified)
    const service = new NativeConfigurationService('/unused', '/recorded/work', undefined, { qualify, discover: vi.fn() })
    await expect(service.qualifyConfiguration(harness)).rejects.toMatchObject(blocked)
    expect(qualify).not.toHaveBeenCalled()
    await service.shutdownChecks()
  })

  it('keeps subscription qualification on the existing native and selected-profile ports', async () => {
    const subscription = { ...harness, authMode: 'subscription' as const }
    const qualifyConfiguration = vi.fn(async () => qualified), qualify = vi.fn(async () => qualified)
    const qualifier = new NativeHarnessConfigurationQualifier('/unused', { qualifyConfiguration } as unknown as NativeHarnessFactories)
    const service = new NativeConfigurationService('/unused', '/recorded/work', undefined, { qualify, discover: vi.fn() })
    expect(await qualifier.qualify(subscription, '/recorded/work')).toEqual(qualified)
    expect(await service.qualifyConfiguration(subscription)).toEqual(qualified)
    expect(qualifyConfiguration).toHaveBeenCalledOnce(); expect(qualify).toHaveBeenCalledOnce()
    await service.shutdownChecks()
  })

  it.each(['main', 'device'] as const)('refuses %s host-profile qualification before discovery or remote dispatch', async host => {
    const refreshMain = vi.fn(async () => { throw new Error('Unexpected native inventory') })
    const endpoint = vi.fn(() => { throw new Error('Unexpected remote dispatch') })
    const qualifier = new ProductionHostHarnessProfileQualifier({ refreshMain } as unknown as ProductionHarnessRegistry,
      {} as NativeHarnessFactories, endpoint, '/recorded/work', undefined,
      new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }))
    const mainId = '00000000-0000-4000-8000-000000000001'
    const override: HostHarnessOverride = { instanceId: 'recorded-profile', instanceRevision: '1', revision: 1,
      target: { hostRef: host === 'main' ? { kind: 'main', mainId } : { kind: 'device', mainId, deviceId: '00000000-0000-4000-8000-000000000002' },
        applicationInstallationId: mainId, harnessInstallationId: 'recorded-cli', installationFingerprint: 'recorded-payload' },
      presetId: 'recorded', enabled: true, driverId: 'claude', configuration: harness, configurationFingerprint: commandInputHash(withAdvancedDefaults(harness)), qualification: 'qualified' }
    await expect(qualifier.qualify(override, { checkId: '00000000-0000-4000-8000-000000000003', signal: new AbortController().signal })).rejects.toMatchObject(blocked)
    expect(refreshMain).not.toHaveBeenCalled(); expect(endpoint).not.toHaveBeenCalled()
  })
})
