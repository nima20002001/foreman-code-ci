import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import { RETIRED_OPENCODE_MESSAGE } from '@foreman-code/contracts'
import type { HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { HostHarnessInstanceProfileChecks } from './profileChecks.js'

const principal: ManagementPrincipal = { id: 'owner', name: 'Owner', audience: 'operator', revokedAt: null,
  expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }] }

function fixture() {
  const binding = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 2, connectionEpoch: randomUUID() }
  const saved: HostHarnessOverride = {
    instanceId: randomUUID(), revision: 3, instanceRevision: '3',
    target: { hostRef: { kind: 'device', mainId: binding.mainId, deviceId: binding.deviceId },
      applicationInstallationId: binding.workerInstallationId,
      harnessInstallationId: 'saved-installation', installationFingerprint: 'saved-fingerprint' },
    presetId: 'saved-preset', driverId: 'opencode', enabled: true, qualification: 'qualified',
    configuration: { harness: 'opencode', model: 'saved-model', variant: 'high', nativeAgent: 'plan',
      thinking: true, autoApprove: false }, configurationFingerprint: 'saved-configuration',
  }
  const client = {} as pg.PoolClient
  const latest = vi.fn(async () => saved)
  const proofs = { latest: vi.fn(), append: vi.fn() }
  const commands = { execute: vi.fn() }
  const qualify = vi.fn()
  const checks = new HostHarnessInstanceProfileChecks({ latest, list: async () => [saved],
    readAuthorized: async <T>(read: (client: pg.PoolClient) => Promise<T>) => read(client),
  } as never, proofs as never, commands as never, { authorize: vi.fn() }, { qualify })
  const input = { commandId: randomUUID(), instanceId: saved.instanceId, expectedRevision: saved.revision, target: saved.target }
  return { binding, saved, checks, input, latest, proofs, commands, qualify }
}

it('rejects an explicit retired host check before recording a command or scheduling qualification', async () => {
  const { checks, input, commands, proofs, qualify } = fixture()
  await expect(checks.check(principal, 'mcp', input))
    .rejects.toMatchObject({ code: 'HARNESS_RETIRED', message: RETIRED_OPENCODE_MESSAGE })
  expect(commands.execute).not.toHaveBeenCalled()
  expect(proofs.append).not.toHaveBeenCalled()
  expect(qualify).not.toHaveBeenCalled()
  await checks.close()
})

it('skips retired host overrides before reading qualification evidence during worker reconnect', async () => {
  const { binding, saved, checks, commands, proofs, qualify } = fixture()
  await checks.recheckWorker(binding, new AbortController().signal, () => binding)
  expect(proofs.latest).not.toHaveBeenCalled()
  expect(commands.execute).not.toHaveBeenCalled()
  expect(qualify).not.toHaveBeenCalled()
  expect(saved.qualification).toBe('qualified')
  checks.assertReady(saved)
  await checks.close()
})

it('continues to deny a caller without grants before looking up a retired host override', async () => {
  const { checks, input, latest } = fixture()
  await expect(checks.check({ ...principal, grants: [] }, 'mcp', input)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  expect(latest).not.toHaveBeenCalled()
  await checks.close()
})
