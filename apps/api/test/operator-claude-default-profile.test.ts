import { expect, it, vi } from 'vitest'
import { HostHarnessOverrideSaveSchema, HostHarnessInstanceCheckInputSchema, type HostHarnessOverride, type HostHarnessProfileEvidence } from '@foreman-code/contracts/harness-registry'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { HostHarnessOverrideService } from '../src/modules/harnesses/instanceSettings/service.js'
import type { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import type { HostHarnessInstanceProfileChecks } from '../src/modules/harnesses/instanceSettings/profileChecks.js'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'

const mainId = '00000000-0000-4000-8000-000000000001'
const target = { hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
  harnessInstallationId: 'unit-native-installation', installationFingerprint: 'unit-fingerprint' }
const configuration = { harness: 'claude' as const, model: 'unit-native-model', effort: 'medium' as const, authMode: 'subscription' as const,
  configDirectory: '/unit/profile', permissionMode: 'default' as const, sandbox: 'danger-full-access' as const,
  tools: ['Write'], permissionRules: [], instructions: '', mcpServers: {} }
const principal: ManagementPrincipal = { id: 'unit-owner', name: 'Unit owner', audience: 'operator', revokedAt: null,
  expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }] }
function fixture() {
  const list = vi.fn(async () => [])
  const service = new HostHarnessOverrideService({ list } as unknown as HarnessInstanceSettingsRepository,
    {} as PostgresCommandCoordinator, { authorize: async () => {} }, async () => null, {} as HostHarnessInstanceProfileChecks, () => target)
  const save = vi.spyOn(service, 'save').mockImplementation(async (_principal, _source, raw) => {
    const input = HostHarnessOverrideSaveSchema.parse(raw)
    const value: HostHarnessOverride = { instanceId: input.instanceId, instanceRevision: '1', revision: 1, target: input.target,
      presetId: input.presetId, enabled: true, driverId: 'claude', configuration: input.configuration, configurationFingerprint: 'unit-config', qualification: 'unqualified' }
    return { value, replayed: false }
  })
  const check = vi.spyOn(service, 'check').mockImplementation(async (_principal, _source, raw) => {
    const input = HostHarnessInstanceCheckInputSchema.parse(raw), profile = save.mock.results.at(-1)!
    const saved = await profile.value as Awaited<ReturnType<HostHarnessOverrideService['save']>>
    return { value: { ...saved.value, qualification: 'qualified' }, proof: { qualified: true, target: input.target } as HostHarnessProfileEvidence, replayed: false }
  })
  return { service, list, save, check }
}

it('uses distinct deterministic UUID command identities for native default profile save/check and preserves the submitted policy', async () => {
  const f = fixture(), commandId = 'operator-default-command'
  const selected = await f.service.prepareOperatorConfiguration(principal, 'mcp', configuration, commandId)
  expect(selected).toMatchObject({ target, instanceRevision: '1' })
  expect(f.save.mock.calls[0]![2].configuration).toEqual(configuration)
  expect(f.save.mock.calls[0]![2].commandId).not.toBe(f.check.mock.calls[0]![2].commandId)
  await f.service.prepareOperatorConfiguration(principal, 'mcp', configuration, commandId)
  expect(f.save.mock.calls[1]![2].commandId).toBe(f.save.mock.calls[0]![2].commandId)
  expect(f.check.mock.calls[1]![2].commandId).toBe(f.check.mock.calls[0]![2].commandId)
})

it('requires update authority before any profile read/write or native check', async () => {
  const f = fixture()
  await expect(f.service.prepareOperatorConfiguration({ ...principal, grants: [{ actions: ['harnesses:read'], scope: {} }] }, 'mcp', configuration, 'operator-default-command')).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  expect(f.list).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled(); expect(f.check).not.toHaveBeenCalled()
})
