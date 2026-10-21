import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import type { ProviderAccount } from '@foreman-code/contracts/provider-accounts'
import * as inspection from '../harnesses/installedCodexInspection.js'
import type { NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
import { privateDirectory, writeRecord } from '../harnesses/recovery/storage.js'
import { ownedTestPath } from '../../../test/helpers/testResources.js'
import { createInstalledWorkerAccounts } from './installedWorkerAccounts.js'
import type { AccountIsolationQualification } from './productionSelection.js'
import { workerProviderAccountResolver } from './workerOperations.js'

it.each(['paths', 'runtime', 'reprovision'] as const)(
  'resolves a persisted registered account on a fresh Worker through %s', async operation => {
    const root = privateDirectory(ownedTestPath(join(process.env.FOREMAN_CODE_TEST_ROOT!,
      `worker-account-paths-${randomUUID()}`)))
    const connection = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
      bootId: randomUUID(), connectionEpoch: randomUUID(), keyRevision: 1, authorizationRevision: 1,
      connectionGeneration: 1 }
    const target = { hostRef: { kind: 'device' as const, mainId: connection.mainId, deviceId: connection.deviceId },
      applicationInstallationId: connection.workerInstallationId, keyRevision: 1, authorizationRevision: 1 }
    const record: AccountIsolationQualification = {
      qualificationId: 'registered-profile', provider: 'codex', generation: 1, target,
      expiresAt: '2099-01-01T00:00:00.000Z', isolation: true, storage: 'provider-file',
      scope: { kind: 'existing-profile', homePath: root, userHome: root,
        choice: { provider: 'codex', authMode: 'subscription', profileRef: 'registered-profile',
          qualificationId: 'registered-profile', label: 'Registered profile' } }, actions: ['status', 'sign-in'],
      override: { instanceId: randomUUID(), instanceRevision: 'qualified', revision: 1, presetId: 'codex',
        enabled: true, driverId: 'codex', configuration: DEFAULT_HARNESS_DEFAULTS.codex,
        configurationFingerprint: 'configuration', qualification: 'qualified', target: {
          hostRef: target.hostRef, applicationInstallationId: target.applicationInstallationId,
          harnessInstallationId: 'installed-codex', installationFingerprint: 'installed-payload' } },
    }
    const account: ProviderAccount = { id: randomUUID(), provider: 'codex', name: 'Registered account',
      authMode: 'subscription', isDefault: false, status: 'signed-in', identity: null, revision: 1 }
    const binding = { kind: 'slot' as const, provider: 'codex' as const, accountId: account.id,
      profileRef: 'registered-profile', bindingRevision: 1, subject: null, target }
    account.binding = binding
    writeRecord(join(root, 'provider-account-qualifications.json'), { version: 1, records: [record] })
    writeRecord(join(privateDirectory(join(root, 'provider-account-slots')), `${account.id}.json`), account)
    // The filesystem inspection is the native boundary; the Worker selection map and pins are real.
    const inspect = vi.spyOn(inspection, 'inspectInstalledCodex').mockResolvedValue({
      inventory: { instances: [], installations: [] },
      currentTarget: { binding: connection, target: record.override.target, binarySha256: 'a'.repeat(64),
        expectedVersion: '0.154.0', installation: {
          hostRef: target.hostRef, harnessInstallationId: 'installed-codex', installationFingerprint: 'installed-payload',
          driverId: 'codex', driverRevision: '1', protocolRevision: 'codex-native-adapter-v1',
          environmentGeneration: 'environment', connectionGeneration: connection.connectionEpoch,
          launcher: { requested: process.execPath, resolvedLauncher: process.execPath, fingerprint: 'installed-payload',
            status: 'installed', interpreter: null, diagnostics: [], checkedAt: new Date().toISOString(),
            environment: { path: '', cwd: root, generation: 'environment', provenance: 'worker' } },
          observedVersion: null, installed: true, authenticated: null, compatible: null, qualified: false,
        } },
    })
    const installed = createInstalledWorkerAccounts({ stateDirectory: root, configuration: null,
      current: () => connection, target, registry: {} as NativeProcessRegistry,
      request: async () => ({ payload: { available: true } }) })!
    try {
      expect(inspect).not.toHaveBeenCalled()
      if (operation === 'reprovision') expect(await installed.provision!(account)).toEqual(account)
      if (operation === 'runtime') {
        const resolver = workerProviderAccountResolver({ ...installed, current: () => connection })
        expect(await resolver.resolve('codex', account.id, { acceptedBinding: binding })).toMatchObject({
          accountId: account.id, homePath: root, binding })
      } else {
        expect(await installed.resolve(binding)).toMatchObject({ account, homePath: root, userHome: root })
      }
      expect(inspect).toHaveBeenCalled()
      inspect.mockResolvedValueOnce({ inventory: { instances: [], installations: [] }, currentTarget: null })
      await expect(installed.resolve(binding)).rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_UNQUALIFIED' })
      inspect.mockRejectedValueOnce(new Error('Installation inspection failed'))
      await expect(installed.resolve(binding)).rejects.toThrow('Installation inspection failed')
    } finally {
      inspect.mockRestore()
      await installed.native.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)
