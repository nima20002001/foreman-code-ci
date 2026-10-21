import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkerUpdater, downloadWorkerArtifact } from '../../../../worker/src/update.mjs'
import { ComputerMaintenance } from './maintenance.js'
import { fakeComputer, fakeFleet } from '../../../test/helpers/fleetSync.js'
import { COMPUTER_MAINTENANCE_NAMESPACE, WORKER_UPDATE_NAMESPACE } from '@foreman-code/contracts/computer-maintenance'
import * as artifacts from './workerArtifacts.js'
import { DeviceConnectionError } from '../devices/deviceWire.js'

const diagnosticsPath = new URL('../../../../worker/src/diagnostics.mjs', import.meta.url).href
const { WorkerError } = await import(diagnosticsPath) as { WorkerError: new (code: string) => Error & { code: string } }

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const target = { os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.23.2' }
const facts = { ...target, rootPersistent: true, homePersistent: true, storagePersistent: true }
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const storage = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(storage, { recursive: true })
  const root = await mkdtemp(join(storage, 'worker-content-'))
  roots.push(root)
  const stateDirectory = join(root, 'state')
  const releaseDirectory = join(root, 'installed')
  await mkdir(stateDirectory, { mode: 0o700 })
  await mkdir(join(releaseDirectory, 'src'), { recursive: true, mode: 0o700 })
  const bytes = Buffer.from('export const worker = true\n')
  const installed = { format: 1, version: '1.0.0', commit: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64),
    packageManager: 'pnpm@11.27.0', protocolVersion: 1, identityFormat: 1, target,
    sourceSnapshot: { commit: 'a'.repeat(40), files: [] },
    files: [{ path: 'src/cli.mjs', size: bytes.length, sha256: hash(bytes) }] }
  const installedBytes = Buffer.from(`${JSON.stringify(installed, null, 2)}\n`)
  await writeFile(join(releaseDirectory, 'manifest.json'), installedBytes)
  await writeFile(join(releaseDirectory, 'src/cli.mjs'), bytes)
  const manifest = { ...installed, commit: 'c'.repeat(40), sourceSnapshot: { commit: 'c'.repeat(40), files: [] } }
  const manifestBytes = () => Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  const github = { repository: 'example/worker', tag: `worker-${manifest.commit}` }
  const release = () => ({ version: manifest.version, manifest, manifestSha256: hash(manifestBytes()), github })
  const request = vi.fn(async (input: { operation: string; path?: string; offset?: number }) => {
    if (input.operation === 'release') return { payload: { operation: 'release', release: release() } }
    if (input.operation === 'ci-smoke') {
      return { payload: { operation: 'ci-smoke', ciSmoke: { repository: 'example/worker', commit: manifest.commit } } }
    }
    throw new Error(`Unexpected Main request: ${input.operation}`)
  })
  const fetchAsset = async ({ destination }: { destination: string }) => {
    const source = join(root, 'github-asset')
    await mkdir(join(source, 'src'), { recursive: true })
    await writeFile(join(source, 'manifest.json'), manifestBytes())
    for (const file of manifest.files) await writeFile(join(source, file.path), bytes)
    execFileSync('tar', ['-czf', destination, '-C', source, '.'])
  }
  const drain = vi.fn(async () => {})
  const stage = vi.fn(async () => ({ directory: join(root, 'staged') }))
  const launchSupervisor = vi.fn(async () => {})
  const options = { stateDirectory, releaseDirectory, version: installed.version, manifestSha256: hash(installedBytes),
    fetchAsset, facts, workerInstallationId: randomUUID(), assertStateOwnership: () => {},
    connection: () => ({ captureRequest: () => ({ request }) }), drain, resume: vi.fn(), stage, launchSupervisor,
    locateLaunch: async () => ({ root, previousDirectory: releaseDirectory }) }
  const updater = await new WorkerUpdater(options).initialize()
  return { root, updater, options, manifest, release, request, drain, stage, launchSupervisor, releaseDirectory }
}

it('reports two builds differing only by commit as current without download, drain, install or restart', async () => {
  const f = await fixture()
  const computer = fakeComputer()
  const maintenance = new ComputerMaintenance({ ...computer.ports,
    workerUpdate: { status: () => f.updater.status(), start: () => f.updater.start() } })
  await maintenance.start({ kind: 'update-worker' })
  await maintenance.drain()
  const status = await maintenance.status(AbortSignal.timeout(2000))
  expect(status.tasks[0]).toMatchObject({ state: 'succeeded', summary: 'Worker 1.0.0 is current.' })
  expect(status.worker).toMatchObject({ state: 'current', currentVersion: '1.0.0',
    manifestSha256: f.options.manifestSha256 })
  expect(f.request.mock.calls.map(([input]) => input.operation)).toEqual(['release'])
  expect(f.drain).not.toHaveBeenCalled()
  expect(f.stage).not.toHaveBeenCalled()
  expect(f.launchSupervisor).not.toHaveBeenCalled()
  const restarted = await new WorkerUpdater(f.options).initialize()
  expect(await restarted.start()).toBe('Worker 1.0.0 is current.')
})

it.each([false, true])('fleet respects permanent failure protection and retries transient failures (%s)', async transient => {
  const f = await fixture()
  f.manifest.files.push({ ...f.manifest.files[0]!, path: 'src/extra.mjs' })
  let drains = 0
  const updater = await new WorkerUpdater({ ...f.options, drain: async () => {
    drains++
    throw new WorkerError(transient ? 'worker_update_drain_deadline_exceeded' : 'worker_update_failed')
  } }).initialize()
  try {
    await expect(updater.start()).rejects.toMatchObject({
      code: transient ? 'worker_update_drain_deadline_exceeded' : 'worker_update_failed',
    })
    const computer = fakeComputer()
    computer.ports.workerUpdate = {
      status: () => updater.status(),
      start: (options = { retry: true }) => updater.start(options),
    }
    const finishMaintenance = async () => {
      await computer.maintenance.drain()
      const status = await computer.maintenance.status(AbortSignal.timeout(2000))
      expect(status.tasks.some(task => task.state === 'running')).toBe(false)
    }
    let now = Date.now()
    const fleet = fakeFleet(computer, () => now)
    Object.assign(fleet.sources, { workerManifestSha256s: async () => [f.release().manifestSha256] })
    fleet.endpoint.capabilities = () => [
      { namespace: COMPUTER_MAINTENANCE_NAMESPACE, mainCanRequest: true },
      { namespace: WORKER_UPDATE_NAMESPACE, mainCanRequest: false },
    ]
    await fleet.fleet.syncChangedSources()
    await finishMaintenance()
    expect(drains).toBe(transient ? 2 : 1)
    // Retrying fleet convergence after Main restarts preserves the updater's persisted classification.
    now += 5 * 60_000
    await fleet.createFleet().syncChangedSources()
    await finishMaintenance()
    expect(drains).toBe(transient ? 3 : 1)
    if (transient) return
    f.manifest.commit = 'd'.repeat(40)
    await fleet.createFleet().syncChangedSources()
    await finishMaintenance()
    expect(drains).toBe(1)
    f.manifest.files.push({ ...f.manifest.files[0]!, path: 'src/changed.mjs' })
    await fleet.createFleet().syncChangedSources()
    await finishMaintenance()
    expect(drains).toBe(2)
    await computer.maintenance.start({ kind: 'update-worker' })
    await finishMaintenance()
    expect(drains).toBe(3)
  } finally { await updater.close() }
})

it('updates changed Worker bytes at the same product version and retains CI smoke configuration', async () => {
  const f = await fixture()
  f.manifest.files[0]!.sha256 = 'd'.repeat(64)
  await expect(f.updater.start()).rejects.toMatchObject({ code: 'artifact_checksum_mismatch' })
  expect(f.drain).not.toHaveBeenCalled()
  const bytes = Buffer.from('export const worker = true\n')
  f.manifest.files.push({ path: 'src/extra.mjs', size: bytes.length, sha256: hash(bytes) })
  f.manifest.files[0]!.sha256 = hash(bytes)
  expect(await f.updater.start()).toBe('Worker 1.0.0 restart is scheduled.')
  expect(f.drain).toHaveBeenCalledOnce()
  expect(f.stage).toHaveBeenCalledOnce()
  expect(f.launchSupervisor).toHaveBeenCalledOnce()
  const record = JSON.parse(await readFile(join(f.options.stateDirectory, 'worker-update.json'), 'utf8'))
  expect(record.restart.ciSmoke).toEqual({ repository: 'example/worker', commit: f.manifest.commit })
})

it('recaptures the update channel for smoke configuration after downloading across a transport reconnect', async () => {
  const f = await fixture()
  f.manifest.files.push({ ...f.manifest.files[0]!, path: 'src/extra.mjs' })
  let connected = true
  const oldRequest = async (input: { operation: string }) => {
    if (!connected) throw new DeviceConnectionError('transport')
    return f.request(input)
  }
  const captureRequest = vi.fn(() => ({ request: connected ? oldRequest : f.request }))
  const updater = await new WorkerUpdater({ ...f.options, connection: () => ({ captureRequest }),
    fetchAsset: async (input: { destination: string }) => {
      await f.options.fetchAsset(input)
      connected = false
    } }).initialize()
  try {
    expect(await updater.start()).toBe('Worker 1.0.0 restart is scheduled.')
    expect(f.request.mock.calls.map(([input]) => input.operation)).toEqual(['release', 'ci-smoke'])
    expect(f.launchSupervisor).toHaveBeenCalledOnce()
  } finally { await updater.close() }
})

it('still rejects a download whose manifest checksum differs from the announced hash', async () => {
  const f = await fixture()
  const directory = join(f.root, 'download')
  await mkdir(directory)
  await expect(downloadWorkerArtifact({ release: { ...f.release(), manifestSha256: 'e'.repeat(64) },
    directory, fetchAsset: f.options.fetchAsset, facts })).rejects.toMatchObject({ code: 'manifest_checksum_mismatch' })
})

it('keeps the running product version when an equivalent bundle advertises a later version', async () => {
  const f = await fixture()
  f.manifest.version = '1.1.0'
  expect(await f.updater.start()).toBe('Worker 1.0.0 is current.')
  expect(await f.updater.status()).toMatchObject({ currentVersion: '1.0.0', state: 'current', targetVersion: '1.0.0' })
  expect(f.drain).not.toHaveBeenCalled()
})

it.each([
  { target: { ...target, node: 'v22.23.3' } },
  { protocolVersion: 2 },
  { identityFormat: 2 },
])('does not treat changed target or protocol facts as current: %s', async change => {
  const f = await fixture()
  Object.assign(f.manifest, change)
  await expect(f.updater.start()).rejects.toBeDefined()
  expect(await f.updater.status()).toMatchObject({ state: 'failed' })
  expect(f.drain).not.toHaveBeenCalled()
})

it('does not accept a checksum mismatch on an otherwise equivalent offered manifest', async () => {
  const f = await fixture()
  const original = f.request.getMockImplementation()!
  f.request.mockImplementation(async input => {
    const reply = await original(input)
    if (input.operation !== 'release') return reply
    return { payload: { operation: 'release', release: { ...f.release(), manifestSha256: 'e'.repeat(64) } } }
  })
  await expect(f.updater.start()).rejects.toMatchObject({ code: 'manifest_checksum_mismatch' })
  expect(f.drain).not.toHaveBeenCalled()
})

it('reads content identities from verified manifests and keeps CI smoke pinned to the build commit', async () => {
  const f = await fixture()
  const release = f.release()
  const directory = join(f.root, 'published')
  const artifact = join(directory, release.manifestSha256)
  await mkdir(artifact, { recursive: true, mode: 0o700 })
  await writeFile(join(artifact, 'manifest.json'), `${JSON.stringify(f.manifest, null, 2)}\n`)
  await writeFile(join(directory, 'index.json'), JSON.stringify({ format: 1, version: '1.0.0',
    artifacts: [{ target, manifestSha256: release.manifestSha256 }], github: release.github,
    publication: { state: 'published', lastError: null } }))
  const options = { directory, version: '1.0.0' }
  const identities = await artifacts.readWorkerContentSha256s(options)
  expect(identities).toHaveLength(1)
  expect(identities[0]).toMatch(/^[a-f0-9]{64}$/)
  expect(identities[0]).toBe((await f.updater.status()).contentSha256)
  const context = { binding: { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID(),
    connectionGeneration: 1 }, signal: AbortSignal.timeout(2000) }
  const extension = artifacts.createWorkerArtifactExtension({ ...options, buildEnabled: async () => true,
    ciSmoke: async () => ({ repository: 'example/worker', commit: f.manifest.commit }) })
  expect(await extension.handle!({ operation: 'ci-smoke', manifestSha256: release.manifestSha256 }, context))
    .toEqual({ payload: { operation: 'ci-smoke', ciSmoke: { repository: 'example/worker', commit: f.manifest.commit } } })
  const stale = artifacts.createWorkerArtifactExtension({ ...options, buildEnabled: async () => true,
    ciSmoke: async () => ({ repository: 'example/worker', commit: 'a'.repeat(40) }) })
  await expect(stale.handle!({ operation: 'ci-smoke', manifestSha256: release.manifestSha256 }, context))
    .rejects.toMatchObject({ code: 'WORKER_UPDATE_SMOKE_UNAVAILABLE' })
  await writeFile(join(artifact, 'manifest.json'), '{}')
  await expect(artifacts.readWorkerContentSha256s(options)).rejects.toBeDefined()
})
