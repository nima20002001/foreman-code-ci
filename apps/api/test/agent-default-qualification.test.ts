import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import type { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { FoundationSettingsManagementService } from '../src/modules/settings/management.js'
import type { HarnessCatalogService } from '../src/modules/harnesses/catalog.js'
import { normalizeHarnessDefaults } from '../src/modules/settings/postgres.js'

const principal: ManagementPrincipal = { id: 'p', name: 'p', audience: 'operator', grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }], expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }
function fixture() {
  const write = vi.fn(async () => ({ value: DEFAULT_AGENT_DEFAULTS, revision: 2, versionId: 'v2' }))
  const previous = structuredClone(DEFAULT_AGENT_DEFAULTS)
  for (const role of ['orchestrator', 'coder', 'operator'] as const) {
    previous[role].harness.model = `${previous[role].harness.model}-previous`
  }
  const settings = {
    getAgentDefaults: vi.fn(async () => ({ value: previous, revision: 1, versionId: 'v1' })),
    updateManagedAgentDefaults: write,
  } as unknown as PostgresFoundationSettingsRepository
  const client = { query: vi.fn(async () => ({ rows: [{
    ...principal, expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null,
  }] })) } as unknown as pg.PoolClient
  const pool = { connect: async () => ({
    query: client.query.bind(client),
    release() {},
  }) } as unknown as pg.Pool
  const execute = vi.fn(async (input: Parameters<PostgresCommandCoordinator['execute']>[0]) => {
    await input.authorize?.(client)
    await input.prepare?.(pool)
    await input.authorize?.(client)
    if (input.preparedMutation) {
      expect(await input.preparedMutation.validate(client)).toBe(true)
    }
    return { value: await input.perform(client), replayed: false }
  })
  const commands = { execute } as unknown as PostgresCommandCoordinator
  const qualify = vi.fn(async () => ({}))
  const native = { qualifyConfiguration: qualify } as unknown as Pick<HarnessCatalogService, 'qualifyConfiguration'>
  return { write, qualify, execute, settings, commands, native }
}
describe('role-default qualification', () => {
  it('qualifies all role templates before persisting them', async () => {
    const f = fixture()
    const service = new FoundationSettingsManagementService(f.settings, f.commands, f.native)
    await service.updateAgentDefaults(principal, 'http', { commandId: 'test-command', expectedRevision: 1, value: DEFAULT_AGENT_DEFAULTS })
    expect(f.qualify).toHaveBeenCalledTimes(3)
    expect(f.write).toHaveBeenCalledTimes(1)
    expect(f.qualify.mock.invocationCallOrder.at(-1)!).toBeLessThan(f.write.mock.invocationCallOrder[0]!)
  })
  it('does not write when a native model/variant/Agent check fails', async () => {
    const f = fixture()
    f.qualify.mockRejectedValueOnce(new Error('model unavailable'))
    const service = new FoundationSettingsManagementService(f.settings, f.commands, f.native)
    await expect(service.updateAgentDefaults(principal, 'mcp', { commandId: 'test-command', expectedRevision: 1, value: DEFAULT_AGENT_DEFAULTS })).rejects.toMatchObject({ code: 'AGENT_DEFAULTS_UNQUALIFIED' })
    expect(f.write).not.toHaveBeenCalled()
  })
  it('fails closed when native validation is not composed', async () => {
    const f = fixture()
    const service = new FoundationSettingsManagementService(f.settings, f.commands)
    await expect(service.updateAgentDefaults(principal, 'http', { commandId: 'test-command', expectedRevision: 1, value: DEFAULT_AGENT_DEFAULTS })).rejects.toMatchObject({ code: 'HARNESS_QUALIFICATION_UNAVAILABLE' })
    expect(f.write).not.toHaveBeenCalled()
  })
  it('keeps receipt replay outside provider requalification', async () => {
    const f = fixture()
    f.execute.mockImplementationOnce(async () => ({ value: { revision: 2 }, replayed: true }))
    const service = new FoundationSettingsManagementService(f.settings, f.commands, f.native)
    await service.updateAgentDefaults(principal, 'mcp', { commandId: 'replay-command', expectedRevision: 1, value: DEFAULT_AGENT_DEFAULTS })
    expect(f.qualify).not.toHaveBeenCalled()
    expect(f.write).not.toHaveBeenCalled()
  })
  it('normalizes persisted legacy provider defaults into complete Advanced objects', () => {
    const legacy = structuredClone(DEFAULT_HARNESS_DEFAULTS)
    delete legacy.codex.advanced
    const normalized = normalizeHarnessDefaults(legacy)
    expect(normalized.codex.advanced?.shellEnvironment.inherit).toBe('all')
    expect(legacy.codex.advanced).toBeUndefined()
  })

})
