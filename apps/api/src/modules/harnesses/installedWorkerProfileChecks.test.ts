import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { HostHarnessOverrideSchema } from '@foreman-code/contracts/harness-registry'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { WorkerPairingConfiguration } from '@foreman-code/contracts/device-identity'
import type { NativeProcessRegistry } from './recovery/processRegistry.js'
import type { createInstalledNativeQualifier } from './installedNativeQualification.js'
import { createInstalledWorkerProfileChecks } from './installedWorkerProfileChecks.js'

const observed = vi.hoisted(() => ({ managers: [] as { binary: string; expectedVersion: string }[],
  assertInstallation: vi.fn(async () => {}) }))
vi.mock('./installedClaudeQualification.js', () => ({
  createInstalledClaudeQualifier: () => ({ close: async () => {} }),
}))
vi.mock('./installedNativeQualification.js', () => ({
  createInstalledNativeQualifier: (ports: Parameters<typeof createInstalledNativeQualifier>[0]) => ({
    qualify: (profile: Parameters<typeof ports.checkConfiguration>[0], request: { signal: AbortSignal }) =>
      ports.checkConfiguration(profile, '/unused', request.signal,
        {} as Parameters<typeof ports.checkConfiguration>[3], observed.assertInstallation),
    close: async () => {},
  }),
}))
vi.mock('./codexAppServer.js', () => ({
  CodexAppServerSessionManager: class {
    constructor(binary: string, expectedVersion: string) { observed.managers.push({ binary, expectedVersion }) }
    async qualifyConfiguration() { throw new Error('Native manager boundary reached') }
    async dispose() {}
  },
}))
beforeEach(() => {
  observed.managers.length = 0
  observed.assertInstallation.mockClear()
})

it.each([false, true])('reads the guarded installer selection after Codex is reselected (private config lost: %s)', async invalid => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-profile-selection-'))
  const path = join(directory, 'selection.json')
  const binding: DeviceSessionBinding = {
    mainId: '11111111-1111-4111-8111-111111111111', deviceId: '22222222-2222-4222-8222-222222222222',
    workerInstallationId: '33333333-3333-4333-8333-333333333333',
    bootId: '44444444-4444-4444-8444-444444444444', keyRevision: 1, authorizationRevision: 1,
    connectionEpoch: 'epoch', connectionGeneration: 1,
  }
  const selection = { schemaVersion: 1, codexBinary: '/installed/old/codex', expectedVersion: 'codex-cli 0.154.0',
    payloadPaths: [], appMcpLauncher: '/installed/app-mcp' }
  await writeFile(path, JSON.stringify(selection), { mode: 0o600 })
  const checker = await createInstalledWorkerProfileChecks({ stateDirectory: directory,
    configuration: { path, ownerUid: process.getuid!() }, pairing: binding as unknown as WorkerPairingConfiguration,
    current: () => binding, registry: {} as NativeProcessRegistry })
  try {
    await writeFile(path, JSON.stringify({ ...selection, codexBinary: '/installed/new/codex',
      expectedVersion: 'codex-cli 0.161.0' }))
    if (invalid) await chmod(path, 0o644)
    const override = HostHarnessOverrideSchema.parse({
      instanceId: '55555555-5555-4555-8555-555555555555', revision: 2, instanceRevision: '2',
      target: { hostRef: { kind: 'device', mainId: binding.mainId, deviceId: binding.deviceId },
        applicationInstallationId: binding.workerInstallationId,
        harnessInstallationId: 'new-installation', installationFingerprint: 'new-fingerprint' },
      presetId: 'local-default:codex', enabled: true, driverId: 'codex',
      configuration: { harness: 'codex', model: 'model', reasoningEffort: 'high', sandbox: 'read-only',
        serviceTier: 'standard' }, configurationFingerprint: 'profile', qualification: 'unqualified',
    })
    const checking = checker!.extension.handle!({ checkId: '66666666-6666-4666-8666-666666666666', override },
      { binding, signal: new AbortController().signal })
    if (invalid) {
      await expect(checking).rejects.toMatchObject({ code: 'WORKER_WORKFLOW_UNAVAILABLE' })
      expect(observed.managers).toEqual([])
    } else {
      await expect(checking).rejects.toThrow('Native manager boundary reached')
      expect(observed.managers).toEqual([{ binary: '/installed/new/codex', expectedVersion: 'codex-cli 0.161.0' }])
      expect(observed.assertInstallation).toHaveBeenCalled()
    }
  } finally {
    await checker?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
