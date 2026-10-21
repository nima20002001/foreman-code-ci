import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CodexHarnessConfigurationSchema, OperatorChatSettingsSchema, applyOperatorChatSettings, operatorChatSettings,
  type HarnessConfiguration,
} from '@foreman-code/contracts'
import { ClaudeHarnessConfigurationSchema } from '@foreman-code/contracts/claude'
import type { ProviderAccountResolver, ResolvedProviderAccount } from '../provider-accounts/service.js'
import { ProviderAccountConfigurationService, harnessSessionChanged } from './providerAccountConfiguration.js'
import { claudeEnvironment } from './claudeSdk/configuration.js'
import { HostHarnessOverrideService } from './instanceSettings/service.js'
import { NativeHarnessFactories } from './runtimeFactory.js'
import { pinnedCodexAccountEnvironment, resolveRuntimeProviderAccount } from './providerAccountRuntime.js'
import { requireClaudeProductionCredentialDelivery } from './claudeSdk/productionCredentials.js'
import { NativeProcessRegistry } from './recovery/processRegistry.js'

const first = '5aa52a3c-c3f7-44cf-b575-dd8ab43b7b4e'
const second = '92a1d19c-a77b-4cd2-936b-518756a6f7ef'
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const codex = CodexHarnessConfigurationSchema.parse({ harness: 'codex', model: 'recorded-model', reasoningEffort: 'medium',
  sandbox: 'read-only', serviceTier: 'standard' })
const claude = ClaudeHarnessConfigurationSchema.parse({ harness: 'claude', model: 'recorded-model',
  authMode: 'subscription', configDirectory: '/ambient/claude', permissionMode: 'default', sandbox: 'danger-full-access',
  tools: [], permissionRules: [], instructions: '', mcpServers: {} })

function resolver(account: ResolvedProviderAccount | null): ProviderAccountResolver {
  return { async resolve(_provider, accountId) {
    if (accountId && accountId !== account?.accountId) throw new Error('Selected account unavailable')
    return account
  } }
}

describe('provider account execution selection', () => {
  it('accepts UUID selection in both harnesses and per-message settings and preserves execution permissions', () => {
    for (const base of [codex, claude]) {
      const selected = { ...base, accountId: first } as HarnessConfiguration
      const settings = OperatorChatSettingsSchema.parse(operatorChatSettings(selected))
      expect(settings.accountId).toBe(first)
      const changed = applyOperatorChatSettings(selected, { ...settings, accountId: second })
      expect(changed.harness).toBe(base.harness)
      expect(changed.accountId).toBe(second)
      expect(changed.sandbox).toBe(base.sandbox)
      expect(harnessSessionChanged(selected, changed)).toBe(true)
      expect(OperatorChatSettingsSchema.safeParse({ ...settings, accountId: '/local/home' }).success).toBe(false)
    }
  })

  it('pins the provider default on new settings and retains that selection after the default changes', async () => {
    let current: ResolvedProviderAccount = { accountId: first, homePath: '/accounts/first/home', authMode: 'subscription' }
    const accounts: ProviderAccountResolver = { async resolve(_provider, id) {
      return id === first ? { accountId: first, homePath: '/accounts/first/home', authMode: 'subscription' } : current
    } }
    const service = new ProviderAccountConfigurationService(accounts)
    const pinned = await service.resolve(codex)
    if (pinned.harness !== 'codex') throw new Error('Expected Codex')
    expect(pinned.accountId).toBe(first)
    current = { accountId: second, homePath: '/accounts/second/home', authMode: 'subscription' }
    expect(await service.resolve(pinned)).toMatchObject({ accountId: first })
    expect(await service.resolve(codex)).toMatchObject({ accountId: second })
  })

  it('keeps one resolved home and strips ambient provider credentials from every Codex process environment', async () => {
    let calls = 0
    let account: ResolvedProviderAccount = { accountId: first, homePath: '/accounts/first/home', authMode: 'subscription' }
    const pin = pinnedCodexAccountEnvironment({ async resolve() { calls++; return account } }, first)
    await pin.prepare()
    account = { accountId: second, homePath: '/accounts/second/home', authMode: 'subscription' }
    await pin.prepare()
    const environment = pin.environment({ CODEX_HOME: '/ambient', OPENAI_API_KEY: 'ambient-key',
      OPENAI_BASE_URL: 'https://ambient.invalid', CLAUDE_CODE_OAUTH_TOKEN: 'ambient-token',
      PATH: '/bin', FOREMAN_CODE_MCP_TOKEN: 'scoped-token' })
    expect(calls).toBe(1)
    expect(environment).toMatchObject({ CODEX_HOME: '/accounts/first/home', HOME: '/accounts/first',
      PATH: '/bin', FOREMAN_CODE_MCP_TOKEN: 'scoped-token' })
    expect(environment.OPENAI_API_KEY).toBeUndefined()
    expect(environment.OPENAI_BASE_URL).toBeUndefined()
    expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  it('uses the server-resolved Claude home/authentication and only the explicitly supplied local key', async () => {
    const selected = await new ProviderAccountConfigurationService(resolver({ accountId: first,
      homePath: '/accounts/first/home', authMode: 'api-key', apiKey: 'local-secret' })).resolve({ ...claude, accountId: first })
    expect(selected).toMatchObject({ accountId: first, configDirectory: '/accounts/first/home', authMode: 'api-key' })
    if (selected.harness !== 'claude') throw new Error('Expected Claude')
    const environment = claudeEnvironment(selected, { ANTHROPIC_API_KEY: 'ambient', ANTHROPIC_AUTH_TOKEN: 'ambient',
      CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_OAUTH_TOKEN: 'ambient', HOME: '/ambient' }, 'local-secret')
    expect(environment).toMatchObject({ CLAUDE_CONFIG_DIR: '/accounts/first/home', HOME: '/ambient',
      ANTHROPIC_API_KEY: 'local-secret', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' })
    expect(environment.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(environment.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
    expect(JSON.stringify(selected)).not.toContain('local-secret')
  })

  it('rejects unavailable selection and managed accounts on registered devices without ambient fallback', async () => {
    const service = new ProviderAccountConfigurationService(resolver({ accountId: first,
      homePath: '/accounts/first/home', authMode: 'subscription' }))
    await expect(service.resolve({ ...codex, accountId: second })).rejects.toThrow('unavailable')
    await expect(service.resolve({ ...codex, accountId: first }, { instanceId: first, instanceRevision: '1', target: {
      hostRef: { kind: 'device', mainId: first, deviceId: second }, applicationInstallationId: first,
      harnessInstallationId: first, installationFingerprint: 'selected-installation',
    } })).rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_LOCAL_ONLY' })
    const ambient = new ProviderAccountConfigurationService(resolver(null))
    expect(await ambient.resolve(codex)).toBe(codex)
    const environment = pinnedCodexAccountEnvironment(resolver(null), undefined)
    await environment.prepare()
    const source = { CODEX_HOME: '/ambient', OPENAI_API_KEY: 'ambient' }
    expect(environment.environment(source)).toBe(source)
  })

  it('requires caller harness grants when preparing a managed Claude account profile', async () => {
    const accounts = new ProviderAccountConfigurationService(resolver({ accountId: first,
      homePath: '/accounts/first/home', authMode: 'subscription' }))
    accounts.bindProfiles(new HostHarnessOverrideService({} as never, {} as never,
      { authorize: async () => undefined }, async () => null))
    const configuration = await accounts.resolve({ ...claude, accountId: first })
    await expect(accounts.profile({ principal: { id: 'reader', name: 'Reader', audience: 'operator',
      revokedAt: null, expiresAt: '2099-01-01T00:00:00Z', grants: [] }, source: 'mcp',
      configuration, selection: undefined, commandId: 'account-change', client: {} as never, check: true,
    })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  })

  it('delivers the selected home at the Codex native qualification boundary', async () => {
    const environments: NodeJS.ProcessEnv[] = []
    const factories = new NativeHarnessFactories({ codexBinary: '/recorded/codex', accounts: resolver({
      accountId: first, homePath: '/accounts/first/home', authMode: 'subscription',
    }) }, { mode: 'native', codex: { mode: 'native', async qualify(_binary, _cwd, environment) {
      environments.push(environment)
      return { providerVersion: '0.156.1' } as never
    } } })
    const allocation = factories.allocate({ harness: 'codex', role: 'operator', ownerAgentId: 'operator',
      workingDirectory: '/project', appMcpAccess: 'scoped', configured: { instanceId: 'operator', instanceRevision: '1',
        enabled: true, driverId: 'codex', configuration: { ...codex, accountId: first } } })
    await allocation.manager.capabilities()
    expect(environments).toHaveLength(1)
    expect(environments[0]).toMatchObject({ CODEX_HOME: '/accounts/first/home', HOME: '/accounts/first' })
    await allocation.manager.dispose()
  })

  it('reuses the accepted account after a runtime restart and fails if that account becomes unavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-account-'))
    directories.push(directory)
    const root = join(directory, 'native-processes')
    const recovery = { root, owner: 'execution:recorded' }
    let available = true
    let defaultId = first
    const accounts: ProviderAccountResolver = { async resolve(_provider, id) {
      if (id === first && !available) throw new Error('Pinned account unavailable')
      return { accountId: id ?? defaultId, homePath: '/selected/home', authMode: 'subscription' }
    } }
    expect(await resolveRuntimeProviderAccount(accounts, 'codex', first, recovery)).toMatchObject({ accountId: first })
    defaultId = second
    expect(await resolveRuntimeProviderAccount(accounts, 'codex', undefined, { ...recovery })).toMatchObject({ accountId: first })
    available = false
    await expect(resolveRuntimeProviderAccount(accounts, 'codex', undefined, { ...recovery })).rejects.toThrow('unavailable')
  })

  it('keeps an ambient runtime ambient after a managed default is added and the runtime restarts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-account-'))
    directories.push(directory)
    const root = join(directory, 'native-processes')
    const recovery = { root, owner: 'conversation:recorded' }
    expect(await resolveRuntimeProviderAccount(resolver(null), 'codex', undefined, recovery)).toBeNull()
    const resolve = vi.fn().mockResolvedValue({ accountId: first, homePath: '/selected/home', authMode: 'subscription' })
    expect(await resolveRuntimeProviderAccount({ resolve }, 'codex', undefined, { ...recovery })).toBeNull()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('leaves a remote saved profile on its own computer authentication without consulting the main default', async () => {
    const resolve = vi.fn().mockResolvedValue({ accountId: first, homePath: '/main/home', authMode: 'subscription' })
    const device = { kind: 'device' as const, mainId: first, deviceId: second }
    expect(await requireClaudeProductionCredentialDelivery(claude, { resolve }, device)).toBeUndefined()
    expect(resolve).not.toHaveBeenCalled()
    await expect(requireClaudeProductionCredentialDelivery({ ...claude, accountId: first }, { resolve }, device))
      .rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_TARGET_CONFLICT' })
    expect(resolve).toHaveBeenCalledWith('claude', first)
  })

  it('inherits a completed source execution account when creating an independent Agent chat runtime', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-account-'))
    directories.push(directory)
    const root = join(directory, 'native-processes')
    const execution = { root, owner: 'execution:source' }
    const firstAccount = resolver({ accountId: first, homePath: '/accounts/first/home', authMode: 'subscription' })
    await resolveRuntimeProviderAccount(firstAccount, 'codex', first, execution)
    const registry = new NativeProcessRegistry(root)
    const launch = await registry.reserveLaunch(execution.owner)
    await registry.abandonReservedLaunch(launch)
    expect(await registry.closeOwner(execution.owner)).toBe(true)
    const accounts: ProviderAccountResolver = { async resolve(_provider, id) {
      return { accountId: id ?? second, homePath: id === first ? '/accounts/first/home' : '/accounts/second/home',
        authMode: 'subscription' }
    } }
    const chat = { root, owner: 'conversation:agent-chat:child' }
    expect(await resolveRuntimeProviderAccount(accounts, 'codex', undefined, chat, execution))
      .toMatchObject({ accountId: first, homePath: '/accounts/first/home' })
    expect(await resolveRuntimeProviderAccount(accounts, 'codex', undefined, { ...chat }))
      .toMatchObject({ accountId: first })
  })

  it('keeps native histories from before managed-account metadata on unmanaged authentication', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-account-'))
    directories.push(directory)
    const root = join(directory, 'native-processes')
    const source = { root, owner: 'execution:historical' }
    const resolve = vi.fn().mockImplementation(async (_provider, id) => ({ accountId: id ?? second,
      homePath: '/accounts/second/home', authMode: 'subscription' }))
    const chat = { root, owner: 'conversation:agent-chat:historical-child' }
    expect(await resolveRuntimeProviderAccount({ resolve }, 'codex', undefined, chat, source)).toBeNull()
    expect(resolve).not.toHaveBeenCalled()
    await expect(resolveRuntimeProviderAccount({ resolve }, 'codex', first, chat, source))
      .rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_BINDING_CONFLICT' })
  })
})


it('preserves a saved Claude profile without consulting the managed default', async () => {
  const resolve = vi.fn().mockResolvedValue({ accountId: first, homePath: '/accounts/first/home', authMode: 'subscription' })
  const service = new ProviderAccountConfigurationService({ resolve })
  expect(await service.resolve(claude)).toBe(claude)
  expect(resolve).not.toHaveBeenCalled()
})
