import { expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, type HarnessConfiguration } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { HarnessCatalogService } from '../src/modules/harnesses/catalog.js'
import type { PostgresSettingsRepository } from '../src/modules/settings/postgres.js'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'

it.each([
  ['read-only', []], ['read-only', ['claude']], ['workspace-write', []], ['workspace-write', ['claude']],
] as const)(
  'leaves a detected Claude %s preset incomplete with unavailable marker %j', async (sandbox, unavailable) => {
    const configuration = { harness: 'claude' as const, model: 'detected-model',
      configDirectory: '/profile', authMode: 'subscription' as const, permissionMode: 'default' as const,
      sandbox, tools: ['Write'], permissionRules: [], instructions: '', mcpServers: {} }
    const settings = { getManagedHarnessDefaults: vi.fn(async () => ({
      defaults: { ...DEFAULT_HARNESS_DEFAULTS, claude: configuration }, revision: 1, unavailable: [...unavailable],
    })) } as unknown as PostgresSettingsRepository
    const qualify = vi.fn(async (value: HarnessConfiguration) => ({
      harness: value.harness, version: 'unit-catalog', authenticated: true, ready: true,
      structuredEvents: true, supportsResume: true, supportsCancellation: true,
      supportsWorkingDirectory: true, supportsStartupPrompt: true,
      supportedNativeTools: [], supportedSettings: [], unsupportedCapabilities: [],
    }))
    const catalog = new HarnessCatalogService({ qualify }, settings, {} as PostgresCommandCoordinator, '/qualification')
    const principal: ManagementPrincipal = { id: 'reader', audience: 'operator', name: 'Reader',
      grants: [{ actions: ['harnesses:read'], scope: {} }],
      expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null }
    const result = await catalog.get(principal, 'claude')
    expect(result).toMatchObject({ defaults: configuration, capability: null,
      discoveryError: { code: 'CLAUDE_FULL_ACCESS_REQUIRED', message: expect.stringContaining('Full access') } })
    expect(qualify).not.toHaveBeenCalled()
    expect(configuration.sandbox).toBe(sandbox)
    const choices = await catalog.list(principal)
    expect(choices.find(entry => entry.harness === 'claude')).toEqual(result)
  },
)
