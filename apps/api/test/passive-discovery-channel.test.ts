import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as fs from 'node:fs'
import * as childProcess from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { harnessConnectionGeneration } from '../src/modules/harnesses/hostConnectionGeneration.js'
import { createPassiveHarnessDiscoveryExtension } from '../src/modules/harnesses/passiveDiscoveryChannel.js'

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, createReadStream: vi.fn(original.createReadStream) }
})
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, spawn: vi.fn(original.spawn) }
})
const directories: string[] = []
afterEach(async () => {
  vi.clearAllMocks()
  vi.useRealTimers()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
const mainId = '00000000-0000-4000-8000-000000000001'
const deviceId = '00000000-0000-4000-8000-000000000002'
const workerInstallationId = '00000000-0000-4000-8000-000000000003'
const binding = { mainId, deviceId, workerInstallationId, bootId: '00000000-0000-4000-8000-000000000004', keyRevision: 1, authorizationRevision: 1, connectionEpoch: 'current-epoch', connectionGeneration: 2 }
const payload = { operation: 'discover', refreshId: '00000000-0000-4000-8000-000000000005' }
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'hrt-channel-'))
  directories.push(directory)
  const launcher = join(directory, 'fixed launcher')
  const nativePayload = join(directory, 'native-payload')
  await writeFile(launcher, '#!/bin/sh\nexit 0\n')
  await chmod(launcher, 0o755)
  await writeFile(nativePayload, 'original payload')
  return createPassiveHarnessDiscoveryExtension({
    hostRef: { kind: 'device', mainId, deviceId },
    applicationInstallationId: workerInstallationId,
    platform: { platform: 'linux', architecture: 'x64' },
    environment: { generation: 'worker-env', provenance: 'worker', cwd: directory, path: '/usr/bin:/bin' },
    installations: [
      {
        driverId: 'fixed', driverRevision: '1', protocolRevision: '1', harnessInstallationId: 'fixed-install',
        requestedLauncher: launcher, payloadPaths: [nativePayload],
      },
      {
        driverId: 'missing', driverRevision: '1', protocolRevision: '1', harnessInstallationId: 'missing-install',
        requestedLauncher: join(directory, 'absent'),
      },
    ],
  })
}
describe('negotiated passive discovery worker handler', () => {
  it('collects only trusted declarations and reports unavailable inventory without native probes', async () => {
    const extension = await fixture()
    expect(extension).toMatchObject({ namespace: 'harness-discovery-v1', role: 'server', maxBinaryBytes: 0 })
    const result = (await extension.handle(payload, { binding, signal: new AbortController().signal })).payload
    expect(result.installations).toHaveLength(2)
    expect(result.installations[0]).toMatchObject({ installed: true, authenticated: null, compatible: null, qualified: null, observedVersion: null, connectionGeneration: harnessConnectionGeneration(binding) })
    expect(result.installations[1]).toMatchObject({ installed: false, installationFingerprint: null, launcher: { status: 'missing' } })
    expect(result.hostMetadata).toMatchObject({ hostRef: { kind: 'device', mainId, deviceId }, applicationInstallationId: workerInstallationId, connection: null, workspaceRoots: null })
    expect(childProcess.spawn).not.toHaveBeenCalled()
  })
  it('rejects caller commands/paths and wrong canonical identities, with no local fallback', async () => {
    const extension = await fixture(), signal = new AbortController().signal
    await expect(extension.handle({ ...payload, requestedLauncher: '/untrusted' }, { binding, signal })).rejects.toThrow()
    for (const field of ['mainId', 'deviceId', 'workerInstallationId'] as const) await expect(extension.handle(payload, { binding: { ...binding, [field]: 'other' }, signal })).rejects.toThrow('binding mismatch')
    expect(childProcess.spawn).not.toHaveBeenCalled()
  })
  it('fences every installation and boot component but keeps the generation across a transport reconnect', () => {
    const current = harnessConnectionGeneration(binding)
    for (const key of Object.keys(binding) as (keyof typeof binding)[]) {
      const changed = { ...binding, [key]: typeof binding[key] === 'number' ? 9 : 'different' }
      if (key === 'connectionEpoch' || key === 'connectionGeneration') expect(harnessConnectionGeneration(changed)).toBe(current)
      else expect(harnessConnectionGeneration(changed)).not.toBe(current)
    }
  })
  it('reuses payload hashes while returning fresh inspection and connection facts', async () => {
    const extension = await fixture()
    const signal = new AbortController().signal
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const first = (await extension.handle(payload, { binding, signal })).payload.installations[0]!
    first.launcher.environment.generation = 'caller mutation'
    vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'))
    const reconnected = { ...binding, connectionEpoch: 'replacement-epoch', bootId: 'restarted-boot' }
    const second = (await extension.handle(payload, { binding: reconnected, signal })).payload.installations[0]!
    expect(second.installationFingerprint).toBe(first.installationFingerprint)
    expect(second.launcher.checkedAt).toBe('2026-01-01T00:00:01.000Z')
    expect(second.launcher.checkedAt).not.toBe(first.launcher.checkedAt)
    expect(second.launcher.environment.generation).toBe('worker-env')
    expect(second.connectionGeneration).toBe(harnessConnectionGeneration(reconnected))
    expect(second.connectionGeneration).not.toBe(first.connectionGeneration)
    expect(fs.createReadStream).toHaveBeenCalledTimes(2)
    expect(childProcess.spawn).not.toHaveBeenCalled()
  })
  it('invalidates cached inventory when an explicit native payload changes', async () => {
    const extension = await fixture()
    const signal = new AbortController().signal
    const first = (await extension.handle(payload, { binding, signal })).payload.installations[0]!
    const nativePayload = first.launcher.payloadFingerprints!.find(value => value.path !== first.launcher.resolvedLauncher)!
    await writeFile(nativePayload.path, 'modified payload')
    const second = (await extension.handle(payload, { binding, signal })).payload.installations[0]!
    expect(second.installationFingerprint).not.toBe(first.installationFingerprint)
    expect(second.launcher.status).toBe('installed')
    expect(fs.createReadStream).toHaveBeenCalledTimes(3)
    expect(childProcess.spawn).not.toHaveBeenCalled()
  })
  it('rejects a mismatched caller even after the trusted inventory is cached', async () => {
    const extension = await fixture()
    const signal = new AbortController().signal
    await extension.handle(payload, { binding, signal })
    await expect(extension.handle(payload, { binding: { ...binding, deviceId: 'other' }, signal }))
      .rejects.toThrow('binding mismatch')
    expect(fs.createReadStream).toHaveBeenCalledTimes(2)
    expect(childProcess.spawn).not.toHaveBeenCalled()
  })
  it('honors an aborted admitted connection before reading files', async () => {
    const extension = await fixture(), controller = new AbortController()
    controller.abort(new Error('connection replaced'))
    await expect(extension.handle(payload, { binding, signal: controller.signal })).rejects.toThrow('connection replaced')
    expect(fs.createReadStream).not.toHaveBeenCalled()
    expect(childProcess.spawn).not.toHaveBeenCalled()
  })
  it('honors cancellation after the admitted inventory is cached', async () => {
    const extension = await fixture()
    const controller = new AbortController()
    await extension.handle(payload, { binding, signal: controller.signal })
    controller.abort(new Error('connection replaced'))
    await expect(extension.handle(payload, { binding, signal: controller.signal })).rejects.toThrow('connection replaced')
    expect(fs.createReadStream).toHaveBeenCalledTimes(2)
    expect(childProcess.spawn).not.toHaveBeenCalled()
  })
})
