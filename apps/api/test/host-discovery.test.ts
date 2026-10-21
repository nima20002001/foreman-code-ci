import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as childProcess from 'node:child_process'
import { discoverLauncher, discoveryCacheKey, probeTrustedVersion, type TargetEnvironment } from '../src/modules/harnesses/hostDiscovery.js'

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, spawn: vi.fn(original.spawn) }
})
const directories: string[] = []
afterEach(async () => { vi.clearAllMocks(); await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })
async function fixture() { const directory = await mkdtemp(join(tmpdir(), 'hrt-discovery-')); directories.push(directory); return directory }
function environment(directory: string, provenance: TargetEnvironment['provenance'] = 'systemd'): TargetEnvironment { return { generation: '1', provenance, cwd: directory, path: `:relative:${directory}:/usr/bin:/bin` } }

describe('passive target-local discovery', () => {
  it.each(['terminal', 'gui', 'systemd', 'ssh', 'worker'] as const)('resolves target %s PATH without child spawns', async (provenance) => {
    const spawn = vi.mocked(childProcess.spawn)
    const directory = await fixture(); const launcher = join(directory, 'tool with spaces')
    await writeFile(launcher, '#!/bin/sh\nexit 0\n'); await chmod(launcher, 0o755)
    const found = await discoverLauncher('tool with spaces', environment(directory, provenance))
    expect(found.status).toBe('installed'); expect(found.resolvedLauncher).toBe(launcher)
    expect(found.fingerprint).toMatch(/^[a-f0-9]{64}$/); expect(found.diagnostics).toHaveLength(2)
    expect(spawn).not.toHaveBeenCalled()
  })
  it('fingerprints both the launcher and explicit native payload', async () => {
    const directory = await fixture(); const launcher = join(directory, 'launcher'); const payload = join(directory, 'payload')
    await writeFile(launcher, '#!/bin/sh\n'); await writeFile(payload, 'native-one'); await chmod(launcher, 0o755); await chmod(payload, 0o755)
    const first = await discoverLauncher(launcher, environment(directory), [payload])
    expect(first.payloadFingerprints?.map((value) => value.path)).toEqual([launcher, payload])
    await writeFile(payload, 'native-two')
    expect((await discoverLauncher(launcher, environment(directory), [payload])).fingerprint).not.toBe(first.fingerprint)
  })
  it('distinguishes missing, permissions, symlink and interpreter evidence', async () => {
    const directory = await fixture(); const env = environment(directory)
    expect((await discoverLauncher('missing', env)).status).toBe('missing')
    await writeFile(join(directory, 'noexec'), 'payload')
    expect((await discoverLauncher('noexec', env)).status).toBe('not-executable')
    await symlink(join(directory, 'absent'), join(directory, 'broken'))
    expect((await discoverLauncher('broken', env)).status).toBe('broken-symlink')
    await writeFile(join(directory, 'script'), '#!/missing/interpreter\n'); await chmod(join(directory, 'script'), 0o755)
    expect((await discoverLauncher(join(directory, 'script'), env)).status).toBe('missing-interpreter')
  })
  it('does not replace an explicit missing path with a PATH candidate', async () => {
    const directory = await fixture(); await writeFile(join(directory, 'tool'), '#!/bin/sh\n'); await chmod(join(directory, 'tool'), 0o755)
    expect((await discoverLauncher('/missing/tool', environment(directory))).status).toBe('missing')
  })
  it('keys metadata by host, installation and all pinned generations', () => {
    const input = { deviceId: 'device', harnessInstallationId: 'harness', installationFingerprint: 'sha', instanceId: 'a', instanceRevision: '1', driverRevision: '1', suiteRevision: '1', environmentGeneration: '1', connectionGeneration: '1' }
    for (const key of Object.keys(input) as (keyof typeof input)[]) expect(discoveryCacheKey({ ...input, [key]: 'other' })).not.toBe(discoveryCacheKey(input))
  })
})

describe('explicit trusted version operation', () => {
  it('requires an allowlist and bounds output and timeout with owned cleanup', async () => {
    const directory = await fixture(); const launcher = join(directory, 'version')
    await writeFile(launcher, '#!/bin/sh\nprintf "v1\\n"\n'); await chmod(launcher, 0o755)
    expect(() => probeTrustedVersion({ launcher, allowlistedLaunchers: [], environment: {}, neutralCwd: directory })).toThrow('allowlisted')
    const input = { launcher, allowlistedLaunchers: [launcher], environment: { PATH: '/usr/bin:/bin', SECRET_TOKEN: 'must-not-pass' }, neutralCwd: directory }
    expect(await probeTrustedVersion(input)).toMatchObject({ status: 'observed', stdout: 'v1\n', exitCode: 0 })
    expect(vi.mocked(childProcess.spawn).mock.calls.at(-1)?.slice(0, 2)).toEqual([launcher, ['--version']])
    expect(vi.mocked(childProcess.spawn).mock.calls.at(-1)?.[2]).toMatchObject({ env: { PATH: '/usr/bin:/bin' }, shell: false })
    expect(vi.mocked(childProcess.spawn).mock.calls.at(-1)?.[2]?.env).not.toHaveProperty('SECRET_TOKEN')
    await writeFile(launcher, '#!/bin/sh\nwhile :; do printf "xxxxxxxx"; done\n')
    const bounded = await probeTrustedVersion({ ...input, maximumBytes: 16 }); expect(bounded.status).toBe('output-limit'); expect(bounded.stdout.length).toBeLessThanOrEqual(16)
    await writeFile(launcher, '#!/bin/sh\nsleep 30\n')
    expect((await probeTrustedVersion({ ...input, timeoutMs: 30 })).status).toBe('timeout')
  })
})
