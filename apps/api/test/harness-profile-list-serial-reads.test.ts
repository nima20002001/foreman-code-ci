import { expect, it } from 'vitest'
import type pg from 'pg'
import type { HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { HostHarnessOverrideService } from '../src/modules/harnesses/instanceSettings/service.js'
import type { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'

const mainId = '00000000-0000-4000-8000-000000000001'
const target = { hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
  harnessInstallationId: 'unit-native-installation', installationFingerprint: 'unit-fingerprint' }
const configuration = { harness: 'claude' as const, model: 'unit-native-model', effort: 'medium' as const, authMode: 'subscription' as const,
  configDirectory: '/unit/profile', permissionMode: 'default' as const, sandbox: 'danger-full-access' as const,
  tools: ['Write'], permissionRules: [], instructions: '', mcpServers: {} }
const principal: ManagementPrincipal = { id: 'unit-reader', name: 'Unit reader', audience: 'operator', revokedAt: null,
  expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['harnesses:read'], scope: {} }] }

it('reads listed profile evidence one query at a time on the shared transaction client', async () => {
  const client = {} as pg.PoolClient
  const profiles: HostHarnessOverride[] = [1, 2, 3, 4].map(index => ({
    instanceId: `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`, instanceRevision: '1', revision: 1,
    target, presetId: 'unit-preset', enabled: true, driverId: 'claude',
    configuration: configuration as HostHarnessOverride['configuration'],
    configurationFingerprint: 'unit-config', qualification: 'unqualified',
  }))
  const clients: unknown[] = []
  const reads: string[] = []
  let active = 0
  let overlapping = 0
  // pg settles a query on a later turn; a second caller on the same client overlaps it.
  const evidence = async (value: HostHarnessOverride, used?: pg.PoolClient) => {
    clients.push(used)
    if (active) overlapping++
    active++
    await new Promise(resolve => setImmediate(resolve))
    active--
    reads.push(value.instanceId)
    return { target, configurationFingerprint: 'unit-config', qualified: true }
  }
  const repository = {
    readAuthorized: async <T>(work: (used: pg.PoolClient) => Promise<T>) => work(client),
    list: async () => profiles,
  }
  const service = new HostHarnessOverrideService(repository as unknown as HarnessInstanceSettingsRepository,
    {} as PostgresCommandCoordinator, { authorize: async () => {} }, evidence)

  const listed = await service.list(principal, { hostRef: target.hostRef, applicationInstallationId: mainId })

  expect(overlapping).toBe(0)
  expect(clients).toEqual(profiles.map(() => client))
  expect(reads).toEqual(profiles.map(profile => profile.instanceId))
  expect(listed.overrides.map(profile => [profile.instanceId, profile.qualification]))
    .toEqual(profiles.map(profile => [profile.instanceId, 'qualified']))
})
