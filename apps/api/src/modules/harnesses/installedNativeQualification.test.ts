import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { withAdvancedDefaults } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import { parseCodexModelCatalog, readNativeCodexModelCatalog } from './codexModelCatalog.js'
import { qualifyNativeCodexModel } from './codexQualification.js'
import type { QualifiedCodex } from './codexProtocol.js'
import type { CurrentInstalledHarnessTarget } from './installedCodexInspection.js'
import { completedNativeQualificationChecks, createInstalledNativeQualifier } from './installedNativeQualification.js'
import { nativeQualification } from './nativeQualification.js'
import type { NativeProcessRecovery } from './recovery/processRegistry.js'

vi.mock('./codexModelCatalog.js', async importOriginal => ({
  ...await importOriginal<typeof import('./codexModelCatalog.js')>(),
  readNativeCodexModelCatalog: vi.fn(),
}))

const catalog = vi.mocked(readNativeCodexModelCatalog)
const model = { slug: 'test-model', supported_reasoning_levels: [{ effort: 'high' }] }
const available = () => parseCodexModelCatalog({ exitCode: 0, stdout: JSON.stringify({ models: [model] }), stderr: '' })
const unavailable = () => parseCodexModelCatalog({ exitCode: 1, stdout: '', stderr: '' })
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  catalog.mockReset()
})

async function fixture() {
  const root = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(join(root, 'profile-catalog-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const binary = join(directory, 'codex')
  const bytes = 'qualification fixture'
  await writeFile(binary, bytes)
  const binarySha256 = createHash('sha256').update(bytes).digest('hex')
  const binding: DeviceSessionBinding = {
    mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(), bootId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, connectionEpoch: randomUUID(), connectionGeneration: 1,
  }
  const configuration = { harness: 'codex' as const, model: model.slug, reasoningEffort: 'high' as const,
    sandbox: 'read-only' as const, serviceTier: 'standard' as const }
  const value: HostHarnessOverride = {
    instanceId: randomUUID(), revision: 1, instanceRevision: '1',
    target: { hostRef: { kind: 'device', mainId: binding.mainId, deviceId: binding.deviceId },
      applicationInstallationId: binding.workerInstallationId,
      harnessInstallationId: 'installation', installationFingerprint: 'fingerprint' },
    presetId: 'test-preset', enabled: true, driverId: 'codex', configuration,
    configurationFingerprint: commandInputHash(withAdvancedDefaults(configuration)), qualification: 'unqualified',
  }
  const target: CurrentInstalledHarnessTarget = {
    binding, target: value.target, binarySha256, expectedVersion: '0.161.0',
    installation: { hostRef: value.target.hostRef, harnessInstallationId: value.target.harnessInstallationId,
      installationFingerprint: value.target.installationFingerprint, driverId: 'codex',
      driverRevision: '1', protocolRevision: 'codex-native-adapter-v1',
      environmentGeneration: 'environment', connectionGeneration: 'connection',
      launcher: { requested: binary, resolvedLauncher: binary, fingerprint: binarySha256,
        payloadFingerprints: [], status: 'installed', interpreter: null, diagnostics: [],
        environment: { generation: 'environment', provenance: 'worker', cwd: directory, path: directory },
        checkedAt: new Date().toISOString() },
      observedVersion: '0.161.0', installed: true, authenticated: null, compatible: null, qualified: false },
  }
  const checkConfiguration = vi.fn(async (profile: HostHarnessOverride, cwd: string, signal: AbortSignal) => {
    if (profile.configuration.harness !== 'codex') throw new Error('Expected Codex profile')
    const facts = await qualifyNativeCodexModel(profile.configuration, binary, cwd, {}, signal, undefined,
      { qualified: { binary, providerVersion: target.expectedVersion } as QualifiedCodex })
    return { ...nativeQualification(profile.configuration, target.expectedVersion),
      ...(typeof facts === 'object' && 'modelCatalogSource' in facts
        ? { modelCatalogSource: facts.modelCatalogSource as 'cached' } : {}) }
  })
  const qualifier = createInstalledNativeQualifier({
    harness: 'codex', binding, trustedCurrentBinding: () => binding,
    inspect: async () => ({ inventory: {} as never, currentTarget: target }),
    registry: {
      reserveLaunch: async owner => ({ owner } as NativeProcessRecovery),
      abandonReservedLaunch: async () => true, closeOwner: async () => true,
    },
    workingRoot: directory, environment: {}, checkConfiguration,
    probe: () => ({
      inspect: async () => ({ executable: binary, identity: binarySha256, version: target.expectedVersion }),
      probe: async () => 'schema', assertUnchanged: async () => {},
    }),
    suite: { harness: 'codex', revision: 'profile-catalog-test', run: async () => ({
      checks: completedNativeQualificationChecks()
        .filter(id => !['static-compatibility', 'selected-profile', 'owned-resource-closure'].includes(id))
        .map(id => ({ id, passed: true, detail: null })), evidence: {},
    }) },
  })
  cleanups.unshift(() => qualifier.close())
  const controller = new AbortController()
  const check = () => qualifier.qualify(value, { checkId: randomUUID(), signal: controller.signal })
  return { check, controller, checkConfiguration }
}

it('qualifies a selected profile when its native catalog is unavailable once then recovers', async () => {
  const f = await fixture()
  catalog.mockImplementationOnce(async () => unavailable()).mockImplementation(async () => available())
  const result = await f.check()
  expect(result.qualified).toBe(true)
  expect(result.completedNativeQualification?.record.checks)
    .toContainEqual({ id: 'selected-profile', passed: true, detail: null })
  expect(catalog).toHaveBeenCalledTimes(2)
})

it('bounds unavailable native catalog retries and retains the selected-profile failure code', async () => {
  const f = await fixture()
  catalog.mockImplementation(async () => unavailable())
  const result = await f.check()
  expect(result.qualified).toBe(false)
  expect(result.completedNativeQualification?.record.checks)
    .toContainEqual({ id: 'selected-profile', passed: false, detail: 'CODEX_MODEL_CATALOG_UNAVAILABLE' })
  expect(catalog).toHaveBeenCalledTimes(3)
})

it('keeps a permanently missing model unqualified with its real reason without retrying', async () => {
  const f = await fixture()
  catalog.mockResolvedValue({ models: [] })
  const result = await f.check()
  expect(result.qualified).toBe(false)
  expect(result.completedNativeQualification?.record.checks)
    .toContainEqual({ id: 'selected-profile', passed: false, detail: 'CODEX_MODEL_UNAVAILABLE' })
  expect(catalog).toHaveBeenCalledTimes(1)
})

it('stops catalog retries when the check budget is aborted', async () => {
  const f = await fixture()
  const reason = new Error('Check budget expired')
  catalog.mockImplementation(async () => {
    f.controller.abort(reason)
    return unavailable()
  })
  await expect(f.check()).rejects.toThrow(reason)
  expect(f.checkConfiguration).toHaveBeenCalledTimes(1)
})

it('qualifies a selected profile from a valid cached catalog after remote refresh fails', async () => {
  const f = await fixture()
  catalog.mockImplementation(async () => parseCodexModelCatalog({
    exitCode: 0, stdout: JSON.stringify({ models: [model] }),
    stderr: 'failed to refresh available models: remote discovery unavailable',
  }))
  const result = await f.check()
  expect(result).toMatchObject({ qualified: true, modelCatalogSource: 'cached' })
  expect(catalog).toHaveBeenCalledTimes(1)
})

it('reports a missing selected model from a cached catalog without retrying refresh', async () => {
  const f = await fixture()
  catalog.mockImplementation(async () => parseCodexModelCatalog({
    exitCode: 0, stdout: JSON.stringify({ models: [] }),
    stderr: 'failed to refresh available models: remote discovery unavailable',
  }))
  const result = await f.check()
  expect(result).toMatchObject({ qualified: false, failure: { code: 'CODEX_MODEL_UNAVAILABLE' } })
  expect(result.completedNativeQualification?.record.checks)
    .toContainEqual({ id: 'selected-profile', passed: false, detail: 'CODEX_MODEL_UNAVAILABLE' })
  expect(catalog).toHaveBeenCalledTimes(1)
})
