import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import { RETIRED_OPENCODE_MESSAGE } from '@foreman-code/contracts'
import type { HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { HostHarnessOverrideService, requireQualifiedHostOverride } from './service.js'

const principal: ManagementPrincipal = { id: 'owner', name: 'Owner', audience: 'operator', revokedAt: null,
  expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }] }

it.each([true, false])('reads a saved OpenCode host override as retired when enabled is %s', async enabled => {
  const mainId = randomUUID()
  const saved: HostHarnessOverride = {
    instanceId: randomUUID(), revision: 3, instanceRevision: '3',
    target: { hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId,
      harnessInstallationId: 'saved-installation', installationFingerprint: 'saved-fingerprint' },
    presetId: 'saved-preset', driverId: 'opencode', enabled, qualification: 'qualified',
    configuration: { harness: 'opencode', model: 'saved-model', variant: 'high', nativeAgent: 'plan',
      thinking: true, autoApprove: false }, configurationFingerprint: 'saved-configuration',
  }
  const original = structuredClone(saved)
  const evidence = vi.fn()
  const client = {} as pg.PoolClient
  const service = new HostHarnessOverrideService({
    list: async () => [saved],
    readAuthorized: async <T>(read: (client: pg.PoolClient) => Promise<T>) => read(client),
  } as never, {} as never, { authorize: vi.fn() }, evidence)
  const result = await service.list(principal, { hostRef: saved.target.hostRef, applicationInstallationId: mainId })
  expect(result.overrides).toEqual([{ ...original, qualification: 'retired', retirementMessage: RETIRED_OPENCODE_MESSAGE }])
  expect(saved).toEqual(original)
  expect(evidence).not.toHaveBeenCalled()
  expect(() => requireQualifiedHostOverride(saved, { instanceRevision: saved.instanceRevision, target: saved.target }))
    .toThrowError(RETIRED_OPENCODE_MESSAGE)
})
