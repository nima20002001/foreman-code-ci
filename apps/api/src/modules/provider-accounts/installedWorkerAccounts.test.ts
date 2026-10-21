import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import type { NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
import { privateDirectory, writeRecord } from '../harnesses/recovery/storage.js'
import { ownedTestPath } from '../../../test/helpers/testResources.js'
import { createInstalledWorkerAccounts } from './installedWorkerAccounts.js'
import type { AccountIsolationQualification } from './productionSelection.js'

it('advertises no account capability without current owning-installation isolation evidence and rejects a missing actual executable', async () => {
  const root = privateDirectory(ownedTestPath(join(process.env.FOREMAN_CODE_TEST_ROOT!, `worker-account-composition-${randomUUID()}`)))
  try {
    const connection = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
      bootId: randomUUID(), connectionEpoch: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 }
    const target = { hostRef: { kind: 'device' as const, mainId: connection.mainId, deviceId: connection.deviceId },
      applicationInstallationId: connection.workerInstallationId, keyRevision: 1, authorizationRevision: 1 }
    const reserveLaunch = vi.fn(() => { throw new Error('Native effects are not qualified') })
    const request = vi.fn(async () => { throw new Error('No native operation was accepted') })
    const input = { stateDirectory: root, configuration: null, current: () => connection, target,
      registry: { reserveLaunch } as unknown as NativeProcessRegistry, request }
    expect(createInstalledWorkerAccounts(input)).toBeUndefined()
    const record: AccountIsolationQualification = { qualificationId: 'worker-storage-proof', provider: 'codex',
      generation: 1,
      target: { ...target, applicationInstallationId: randomUUID() }, expiresAt: '2099-01-01T00:00:00.000Z',
      isolation: true, storage: 'provider-keyring', scope: { kind: 'managed-slots' }, actions: ['status', 'sign-in'],
      override: { instanceId: randomUUID(), instanceRevision: 'profile-revision', revision: 1, presetId: 'preset',
        enabled: true, driverId: 'codex', configuration: DEFAULT_HARNESS_DEFAULTS.codex,
        configurationFingerprint: 'configuration-fingerprint', qualification: 'qualified',
        target: { hostRef: target.hostRef, applicationInstallationId: target.applicationInstallationId,
          harnessInstallationId: 'actual-installation', installationFingerprint: 'actual-fingerprint' } } }
    const path = join(root, 'provider-account-qualifications.json')
    writeRecord(path, { version: 1, records: [record] })
    expect(createInstalledWorkerAccounts(input)).toBeUndefined()
    record.target = target
    writeRecord(path, { version: 1, records: [record] })
    const installed = createInstalledWorkerAccounts(input)!
    expect((await installed.native.discover!(target)).providers).toEqual([
      { provider: 'codex', qualified: false, actions: [], reason: 'Provider storage isolation is not qualified for this installation.' },
      { provider: 'claude', qualified: false, actions: [], reason: 'Provider storage isolation is not qualified for this installation.' },
    ])
    const id = randomUUID()
    await expect(installed.provision!({ id, provider: 'codex', name: 'Unavailable Worker slot', authMode: 'subscription',
      status: 'unavailable', identity: null, revision: 1, isDefault: false,
      binding: { kind: 'slot', provider: 'codex', accountId: id, profileRef: id, bindingRevision: 1, subject: null, target } }))
      .rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_UNQUALIFIED' })
    expect(request).not.toHaveBeenCalled()
    expect(reserveLaunch).not.toHaveBeenCalled()
    await installed.native.close()
  } finally { await rm(root, { recursive: true, force: true }) }
})
