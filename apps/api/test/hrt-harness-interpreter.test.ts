import { persistentFixtureRoot } from './helpers/fixtureStorage.js'
import { mkdtemp, mkdir, writeFile, symlink, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { NativeHarnessFactories } from '../src/modules/harnesses/runtimeFactory.js'
import { HarnessInstanceRegistry, localHarnessDrivers } from '../src/modules/harnesses/instanceRegistry.js'
import { HarnessInstallationRegistry, type HarnessInstallationRecord } from '../src/modules/harnesses/installationRegistry.js'
import { discoverLauncher } from '../src/modules/harnesses/hostDiscovery.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
describe('exact installed shebang interpreter revalidation', () => {
  it.each(['env', 'direct'] as const)('rejects an atomic %s interpreter retarget even when old payload fingerprints are unchanged', async kind => {
    const root = await mkdtemp(join(persistentFixtureRoot, 'hrt-interpreter-')); roots.push(root)
    const bin = join(root, 'bin'); await mkdir(bin, { mode: 0o700 })
    const launcher = join(root, 'launcher'), first = join(root, 'node-A'), second = join(root, 'node-B')
    const interpreter = kind === 'env' ? join(bin, 'node') : join(root, 'interpreter')
    await writeFile(launcher, `#!${kind === 'env' ? '/usr/bin/env node' : interpreter}\n// passive inventory fixture\n`, { mode: 0o700 })
    await writeFile(first, 'original interpreter bytes', { mode: 0o700 })
    await writeFile(second, 'different interpreter bytes', { mode: 0o700 })
    await symlink(first, interpreter)
    const environment = { generation: 'original-environment', provenance: 'terminal' as const, cwd: root, path: bin }
    // Discovery reads real files only; no native launcher or qualification is executed.
    const original = await discoverLauncher(launcher, environment, [first])
    expect(original.status).toBe('installed'); expect(original.interpreter).toBe(first)
    const instances = new HarnessInstanceRegistry(localHarnessDrivers)
    instances.reload([{ instanceId: 'original-codex', instanceRevision: '1', driverId: 'codex', enabled: true,
      configuration: DEFAULT_HARNESS_DEFAULTS.codex }])
    const installations = new HarnessInstallationRegistry(instances)
    const installation: HarnessInstallationRecord = { hostRef: { kind: 'main', mainId: randomUUID() }, harnessInstallationId: randomUUID(),
      installationFingerprint: original.fingerprint!, driverId: 'codex', driverRevision: '1', protocolRevision: 'original-protocol',
      environmentGeneration: environment.generation, connectionGeneration: 'original-connection', launcher: original, installed: true,
      observedVersion: null, authenticated: null, compatible: null, qualified: null }
    installations.refresh([installation])
    const binding = installations.pin({ instanceId: 'original-codex', hostRef: installation.hostRef, harnessInstallationId: installation.harnessInstallationId,
      connectionGeneration: installation.connectionGeneration, environmentGeneration: installation.environmentGeneration })
    const factory = new NativeHarnessFactories({ codexBinary: '/unused', instances, installations })
    await expect(factory.assertInstallationUnchanged(binding)).resolves.toBeUndefined()
    await symlink(second, `${interpreter}.next`); await rename(`${interpreter}.next`, interpreter)
    const current = await discoverLauncher(launcher, environment, [first])
    expect(current.fingerprint).toBe(original.fingerprint)
    expect(current.interpreter).toBe(second)
    await expect(factory.assertInstallationUnchanged(binding)).rejects.toMatchObject({ code: 'HARNESS_INSTALLATION_CHANGED' })
    expect(binding.installation.launcher).toEqual(original)
  })
})
