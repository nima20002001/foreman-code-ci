import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import type { ProviderAccount, ProviderAccountAuthenticationOperation } from '@foreman-code/contracts/provider-accounts'
import { ownedTestPath } from '../../../test/helpers/testResources.js'
import type { NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
import { privateDirectory, writeRecord } from '../harnesses/recovery/storage.js'
import * as inspection from '../harnesses/installedCodexInspection.js'
import { createInstalledWorkerAccounts } from './installedWorkerAccounts.js'
import { NativeAccountJournal } from './nativeJournal.js'
import type { AccountIsolationQualification } from './productionSelection.js'

it('keeps persisted account observations usable when a Worker restarts with a lower connection counter', async () => {
  const root = privateDirectory(ownedTestPath(join(process.env.FOREMAN_CODE_TEST_ROOT!, `worker-accounts-${randomUUID()}`)))
  let connection = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    bootId: randomUUID(), connectionEpoch: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 7 }
  const target = { hostRef: { kind: 'device' as const, mainId: connection.mainId, deviceId: connection.deviceId },
    applicationInstallationId: connection.workerInstallationId, keyRevision: 1, authorizationRevision: 1 }
  const record: AccountIsolationQualification = { qualificationId: 'native-profile', provider: 'codex', generation: 1,
    target, expiresAt: '2099-01-01T00:00:00.000Z', isolation: true, storage: 'provider-keyring',
    scope: { kind: 'existing-profile', homePath: root, userHome: root, choice: {
      provider: 'codex', authMode: 'subscription', profileRef: 'native-profile', qualificationId: 'native-profile',
      label: 'Native profile' } }, actions: ['status', 'sign-in', 'cancel'],
    override: { instanceId: randomUUID(), instanceRevision: 'profile-revision', revision: 1, presetId: 'preset',
      enabled: true, driverId: 'codex', configuration: DEFAULT_HARNESS_DEFAULTS.codex,
      configurationFingerprint: 'configuration-fingerprint', qualification: 'qualified',
      target: { hostRef: target.hostRef, applicationInstallationId: target.applicationInstallationId,
        harnessInstallationId: 'installed-codex', installationFingerprint: 'installed-payload' } } }
  writeRecord(join(root, 'provider-account-qualifications.json'), { version: 1, records: [record] })
  const inspect = vi.spyOn(inspection, 'inspectInstalledCodex').mockImplementation(async () => ({
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
  }))
  const account: ProviderAccount = { id: randomUUID(), provider: 'codex', name: 'Native account',
    authMode: 'subscription', isDefault: false, status: 'unavailable', identity: null, revision: 1 }
  account.binding = { kind: 'slot', provider: 'codex', accountId: account.id, profileRef: 'native-profile',
    bindingRevision: 1, subject: null, target }
  const input = { account, homePath: root, userHome: root }
  const create = () => createInstalledWorkerAccounts({ stateDirectory: root, configuration: null,
    current: () => connection, target, registry: {} as NativeProcessRegistry,
    request: async () => ({ payload: { allowed: true } }) })!
  const installed = create()
  let restarted: ReturnType<typeof create> | undefined
  try {
    const generation = await installed.native.authenticationGeneration!(input)
    const operation: ProviderAccountAuthenticationOperation = { id: randomUUID(), commandId: randomUUID(),
      inputHash: `sha256:${'a'.repeat(64)}`, binding: account.binding, intent: 'sign-in', state: 'reserved',
      revision: 1, generation, nativeSequence: 0, cancelRequested: false, nativeClosed: false,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z', humanActionRequired: true }
    new NativeAccountJournal(join(root, 'provider-account-slots/operations')).reserve(operation)
    const before = await installed.native.observeAccount!(input)
    expect(before.status).toBe('login-pending')
    await installed.native.close()
    connection = { ...connection, connectionEpoch: randomUUID(), connectionGeneration: 1 }
    restarted = create()
    const after = await restarted.native.observeAccount!(input)
    expect(after.status).toBe('login-pending')
    expect(after.generation).toBeGreaterThan(before.generation)
    expect(after.sequence).toBeGreaterThan(before.sequence)
    expect(await restarted.native.authenticationGeneration!(input)).toBe(after.generation)
    expect((await restarted.native.discover!(target)).generation).toBe(after.generation)
  } finally {
    inspect.mockRestore()
    await restarted?.native.close()
    await installed.native.close()
    await rm(root, { recursive: true, force: true })
  }
})
