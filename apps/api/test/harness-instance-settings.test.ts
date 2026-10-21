import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { HostHarnessOverride, HostHarnessOverrideSave } from '@foreman-code/contracts/harness-registry'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import type { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import { HostHarnessOverrideService, requireQualifiedHostOverride } from '../src/modules/harnesses/instanceSettings/service.js'

const mainId = '00000000-0000-4000-8000-000000000001'
const principal: ManagementPrincipal = { id: 'operator', name: 'Operator', audience: 'operator', revokedAt: null, expiresAt: '9999-12-31T00:00:00.000Z', grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }] }
const configuration = { harness: 'codex' as const, model: 'test', reasoningEffort: 'high' as const, sandbox: 'read-only' as const, serviceTier: 'standard' as const }
const input = (): HostHarnessOverrideSave => ({ commandId: randomUUID(), instanceId: randomUUID(), expectedRevision: 0,
  target: { hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId, harnessInstallationId: 'codex-install', installationFingerprint: 'sha' }, presetId: 'local-default:codex', enabled: true, configuration })
function fixture() {
  const rows: HostHarnessOverride[] = []
  const client = {} as pg.PoolClient
  const authorize = vi.fn(async () => undefined)
  const repository = { readAuthorized: async (operation: (client: pg.PoolClient) => Promise<unknown>) => operation(client), list: async () => rows,
    lockRevision: async () => undefined,
    latest: async (_client: pg.PoolClient, instanceId: string) => rows.findLast(row => row.instanceId === instanceId) ?? null,
    append: vi.fn(async (_client: pg.PoolClient, _principal: string, _revision: number | undefined, value: HostHarnessOverride) => { rows.push(structuredClone(value)); return value }) } as unknown as HarnessInstanceSettingsRepository
  const execute = vi.fn(async (command: { authorize: (client: pg.PoolClient) => Promise<void>; perform: (client: pg.PoolClient) => Promise<unknown> }) => {
    await command.authorize(client); return { value: await command.perform(client), replayed: false }
  })
  const commands = { execute, recordDenied: vi.fn(async () => undefined) } as unknown as PostgresCommandCoordinator
  return { repository, commands, authorize, rows, client, execute }
}
describe('host override settings authority and exact-profile availability', () => {
  it('saves immutable unqualified snapshots and reads persisted settings independently of global defaults', async () => {
    const f = fixture(); const service = new HostHarnessOverrideService(f.repository, f.commands, { authorize: f.authorize }, async () => null)
    const args = input(); const saved = await service.save(principal, 'mcp', args)
    expect(saved.value).toMatchObject({ instanceId: args.instanceId, revision: 1, instanceRevision: '1', qualification: 'unqualified' })
    expect(() => requireQualifiedHostOverride(saved.value, { instanceRevision: '1', target: args.target })).toThrow('qualification')
    expect(f.authorize).toHaveBeenCalledWith(principal, 'harnesses:update', args.target.hostRef, mainId, f.client)
    expect((await service.list(principal, { hostRef: args.target.hostRef, applicationInstallationId: mainId })).overrides[0]).toEqual(saved.value)
    expect(f.authorize).toHaveBeenLastCalledWith(principal, 'harnesses:read', args.target.hostRef, mainId, f.client)
  })
  it('rejects denied, revoked host and credential-bearing config before persistence', async () => {
    const f = fixture(); const service = new HostHarnessOverrideService(f.repository, f.commands, { authorize: f.authorize }, async () => null)
    await expect(service.save({ ...principal, grants: [{ actions: ['harnesses:read'], scope: {} }] }, 'mcp', input())).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(f.commands.recordDenied).toHaveBeenCalledWith(principal.id, 'mcp', 'harness_instance_save', expect.stringContaining('harness-instance:'))
    f.authorize.mockRejectedValueOnce(new Error('revoked'))
    await expect(service.save(principal, 'http', input())).rejects.toThrow('revoked')
    await expect(service.save(principal, 'http', { ...input(), configuration: { ...configuration, apiKey: 'secret' } } as HostHarnessOverrideSave)).rejects.toThrow()
    expect(f.rows).toHaveLength(0)
  })
  it('qualifies only exact target profile evidence and fails closed on missing remote evidence', async () => {
    const f = fixture(); const args = input()
    const evidence = vi.fn(async (value: HostHarnessOverride) => ({ target: value.target, configurationFingerprint: value.configurationFingerprint, qualified: true }))
    const service = new HostHarnessOverrideService(f.repository, f.commands, { authorize: f.authorize }, evidence)
    const qualified = (await service.save(principal, 'http', args)).value
    expect(qualified.qualification).toBe('qualified')
    expect(requireQualifiedHostOverride(qualified, { instanceRevision: '1', target: args.target })).toEqual(qualified)
    expect(() => requireQualifiedHostOverride(qualified, { instanceRevision: '2', target: args.target })).toThrow('qualification')
    expect(() => requireQualifiedHostOverride(qualified, { instanceRevision: '1', target: { ...args.target, applicationInstallationId: randomUUID() } })).toThrow('qualification')
    const persisted = f.rows[0]!
    expect(persisted.qualification).toBe('unqualified')
    evidence.mockResolvedValueOnce({ target: { ...args.target, installationFingerprint: 'changed' }, configurationFingerprint: persisted.configurationFingerprint, qualified: true })
    expect((await service.list(principal, { hostRef: args.target.hostRef, applicationInstallationId: mainId })).overrides[0]?.qualification).toBe('installation-changed')
    evidence.mockResolvedValueOnce({ target: args.target, configurationFingerprint: 'other-profile', qualified: true })
    expect((await service.list(principal, { hostRef: args.target.hostRef, applicationInstallationId: mainId })).overrides[0]?.qualification).toBe('unqualified')
    evidence.mockRejectedValueOnce(new Error('remote unavailable'))
    expect((await service.list(principal, { hostRef: args.target.hostRef, applicationInstallationId: mainId })).overrides[0]?.qualification).toBe('unqualified')
  })
})
