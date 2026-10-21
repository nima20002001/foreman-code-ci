import * as fs from 'node:fs'
import { PayloadFingerprintCache } from '../payloadFingerprintCache.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClaudeCurrentPinResolver, discoverInstalledClaudeSdk, installedClaudeSdkEntrypoint,
  type ClaudeCurrentPinContext } from './currentPin.js'
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, createReadStream: vi.fn(original.createReadStream) }
})

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'claude-current-pin-')); directories.push(directory)
  const launcher = join(directory, 'claude'); const entrypoint = join(directory, 'sdk.mjs'); const lock = join(directory, 'lock.yaml')
  await writeFile(launcher, 'native CLI fixture'); await chmod(launcher, 0o700)
  await writeFile(entrypoint, 'SDK fixture'); await writeFile(join(directory, 'core.mjs'), 'SDK dependency')
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.284' }))
  await writeFile(lock, "packages:\n  '@anthropic-ai/claude-agent-sdk@0.3.284':\n    resolution: {integrity: sha512-aGVsbG8=}\n")
  const sdk = { entrypoint, installedLockPath: lock, selectedExecutable: launcher }
  const context: ClaudeCurrentPinContext = { hostGeneration: 'host-1', harnessInstallationId: 'installation-1',
    environment: { generation: 'environment-1', provenance: 'systemd', cwd: directory, path: '/usr/bin' },
    instanceRevision: 'accepted-revision-7', profilePath: join(directory, 'profile') }
  return { directory, launcher, sdk, context }
}
describe('current installed Claude qualification pin', () => {
  it('caches passive SDK inventory and leaves current pin verification uncached', async () => {
    const value = await fixture()
    const cache = new PayloadFingerprintCache()
    const signal = new AbortController().signal
    vi.mocked(fs.createReadStream).mockClear()
    const first = await discoverInstalledClaudeSdk(value.sdk, value.context, signal, cache)
    const second = await discoverInstalledClaudeSdk(value.sdk, value.context, signal, cache)
    expect(second.launcher.fingerprint).toBe(first.launcher.fingerprint)
    expect(fs.createReadStream).toHaveBeenCalledTimes(4)
    const verified = await discoverInstalledClaudeSdk(value.sdk, value.context)
    expect(verified.launcher.fingerprint).toBe(first.launcher.fingerprint)
    expect(fs.createReadStream).toHaveBeenCalledTimes(8)
    await writeFile(join(value.directory, 'core.mjs'), 'changed SDK dependency')
    const changed = await discoverInstalledClaudeSdk(value.sdk, value.context, signal, cache)
    expect(changed.launcher.fingerprint).not.toBe(first.launcher.fingerprint)
    expect(fs.createReadStream).toHaveBeenCalledTimes(9)
  })
  it('discovers the installer-selected SDK and lock without resolving relative to the caller bundle', async () => {
    const value = await fixture()
    const selected = installedClaudeSdkEntrypoint(value.sdk.installedLockPath, value.launcher, value.sdk.entrypoint)
    const metadata = await discoverInstalledClaudeSdk(selected, value.context)
    expect(metadata.sdkVersion).toBe('0.3.284')
    expect(metadata.sdkIntegrity).toBe('sha512-aGVsbG8=')
    expect(metadata.launcher.status).toBe('installed')
  })
  it('passively declares actual SDK modules and selected launcher without executing either', async () => {
    const value = await fixture(); const metadata = await discoverInstalledClaudeSdk(value.sdk, value.context)
    expect(metadata.sdkVersion).toBe('0.3.284'); expect(metadata.sdkIntegrity).toBe('sha512-aGVsbG8=')
    expect(metadata.declaration.payloadPaths).toContain(join(value.directory, 'core.mjs'))
    expect(metadata.launcher.status).toBe('installed')
  })
  it('requires owned version evidence, never infers CLI version from SDK', async () => {
    const value = await fixture(); expect(await createClaudeCurrentPinResolver({ sdk: value.sdk })(value.context)).toMatchObject({ status: 'unavailable' })
  })
  it('binds observed version and caches only same host/environment/payload identity', async () => {
    const value = await fixture(); let calls = 0
    const resolve = createClaudeCurrentPinResolver({ sdk: value.sdk, ownedVersionProbe: async input => {
      calls++; return { ...input, version: calls === 1 ? '2.1.284' : '2.1.286', positiveProcessClosure: true }
    } })
    const first = await resolve(value.context); expect(first).toMatchObject({ status: 'available', pin: { cliVersion: '2.1.284', configRevision: 'accepted-revision-7' } })
    await resolve(value.context); expect(calls).toBe(1)
    await resolve({ ...value.context, environment: { ...value.context.environment, generation: 'environment-2' } }); expect(calls).toBe(2)
    await writeFile(join(value.directory, 'core.mjs'), 'changed SDK dependency')
    await resolve(value.context); expect(calls).toBe(3)
    if (first.status === 'available') expect(first.pin.executableSha256).toBe(first.launcher.payloadFingerprints?.find(row => row.path === value.launcher)?.fingerprint)
  })
  it('rejects installation change during owned probe', async () => {
    const value = await fixture()
    const resolve = createClaudeCurrentPinResolver({ sdk: value.sdk, ownedVersionProbe: async input => {
      await writeFile(value.launcher, 'changed CLI payload'); return { ...input, version: '2.1.284', positiveProcessClosure: true }
    } })
    expect(await resolve(value.context)).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('changed') })
  })
  it('requires exact probe identity and positive process closure', async () => {
    const value = await fixture()
    for (const override of [{ launcher: '/different' }, { environmentGeneration: 'stale' }, { installationFingerprint: 'stale' }, { positiveProcessClosure: false }, { version: 'SDK 0.3.284' }]) {
      const resolve = createClaudeCurrentPinResolver({ sdk: value.sdk, ownedVersionProbe: async input => ({ ...input, version: '2.1.284', positiveProcessClosure: true, ...override }) })
      expect(await resolve(value.context)).toMatchObject({ status: 'unavailable' })
    }
  })
  it('does not fallback from missing explicit launcher to SDK resolver', async () => {
    const value = await fixture(); let calls = 0
    const result = await createClaudeCurrentPinResolver({ sdk: { ...value.sdk, selectedExecutable: '/missing-selected-claude', nativeResolver: async () => { calls++; return value.launcher } } })(value.context)
    expect(result.status).toBe('unavailable'); expect(calls).toBe(0)
  })
  it('uses only supplied installed native resolver when no explicit selection exists', async () => {
    const value = await fixture(); const sdk = { entrypoint: value.sdk.entrypoint, installedLockPath: value.sdk.installedLockPath, nativeResolver: async (entry: string) => { expect(entry).toBe(value.sdk.entrypoint); return value.launcher } }
    expect((await discoverInstalledClaudeSdk(sdk, value.context)).launcher.resolvedLauncher).toBe(value.launcher)
  })
  it('fingerprints the actual interpreter and invalidates its changed payload', async () => {
    const value = await fixture(); const interpreter = join(value.directory, 'interpreter')
    await writeFile(interpreter, 'interpreter fixture'); await chmod(interpreter, 0o700)
    await writeFile(value.launcher, `#!${interpreter}\nlauncher fixture`)
    let calls = 0
    const resolve = createClaudeCurrentPinResolver({ sdk: value.sdk, ownedVersionProbe: async input => {
      calls++; return { ...input, version: '2.1.284', positiveProcessClosure: true }
    } })
    const first = await resolve(value.context)
    expect(first.status).toBe('available')
    if (first.status === 'available') expect(first.declaration.payloadPaths).toContain(interpreter)
    await writeFile(interpreter, 'changed interpreter')
    expect((await resolve(value.context)).status).toBe('available'); expect(calls).toBe(2)
    await rm(interpreter)
    expect((await resolve(value.context)).status).toBe('unavailable')
  })
  it('fails unavailable for missing integrity and rejected accepted profile source', async () => {
    const value = await fixture(); await writeFile(value.sdk.installedLockPath, 'unrelated lock')
    expect(await createClaudeCurrentPinResolver({ sdk: value.sdk })(value.context)).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('integrity') })
    expect(await createClaudeCurrentPinResolver({ sdk: value.sdk })({ ...value.context, instanceRevision: '' })).toMatchObject({ status: 'unavailable' })
  })
})
