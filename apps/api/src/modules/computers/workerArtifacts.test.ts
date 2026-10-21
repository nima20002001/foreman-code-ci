import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WORKER_UPDATE_MAX_BINARY_BYTES, WORKER_UPDATE_NAMESPACE } from '@foreman-code/contracts/computer-maintenance'
import { negotiateDeviceExtensions } from '@foreman-code/contracts/device-application'
import { DeviceApplicationChannel, extensionDescriptors,
  type DeviceExtensionRegistration } from '../devices/deviceApplicationChannel.js'
import { adaptDeviceSocket } from '../devices/deviceWire.js'
import { createWorkerArtifactExtension, readWorkerContentSha256s, readWorkerManifestSha256s,
  readWorkerReleasePublication } from './workerArtifacts.js'

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const target = { os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.23.3' }
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture({ published = true } = {}) {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'worker-artifacts-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  await chmod(directory, 0o700)
  const content = Buffer.alloc(WORKER_UPDATE_MAX_BINARY_BYTES + 11, 7)
  for (let index = 0; index < content.length; index++) content[index] = index % 251
  const manifest = { format: 1, version: '0.0.57', commit: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64),
    packageManager: 'pnpm@11.27.0', protocolVersion: 1, identityFormat: 1, target,
    sourceSnapshot: { commit: 'a'.repeat(40), files: [] },
    files: [{ path: 'src/cli.mjs', sha256: sha256(content), size: content.length }] }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  const manifestSha256 = sha256(manifestBytes)
  const release = join(directory, manifestSha256)
  await mkdir(join(release, 'src'), { recursive: true, mode: 0o700 })
  await writeFile(join(release, 'src/cli.mjs'), content)
  await writeFile(join(release, 'manifest.json'), manifestBytes)
  await writeFile(join(directory, 'index.json'), JSON.stringify({ format: 1, version: manifest.version,
    artifacts: [{ target, manifestSha256 }],
    ...(published ? { github: { repository: 'example/worker', tag: `worker-${manifest.commit}` } } : {}),
    publication: { state: published ? 'published' : 'pending', lastError: null } }))
  const extension = createWorkerArtifactExtension({ directory, version: manifest.version })
  const context = { binding: { mainId: '11111111-1111-4111-8111-111111111111',
    deviceId: '22222222-2222-4222-8222-222222222222', workerInstallationId: '33333333-3333-4333-8333-333333333333',
    bootId: '44444444-4444-4444-8444-444444444444', connectionEpoch: '55555555-5555-4555-8555-555555555555',
    keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 }, signal: new AbortController().signal }
  const request = (raw: unknown) => extension.handle!(raw, context)
  return { directory, content, manifest, manifestBytes, manifestSha256, release, extension, context, request }
}

class Socket extends EventEmitter {
  bufferedAmount = 0
  peer?: Socket
  closed = false
  send(text: string) {
    queueMicrotask(() => { if (!this.closed && !this.peer?.closed) this.peer?.emit('message', text, false) })
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
    this.peer?.close()
  }
}

function channelPair(f: Awaited<ReturnType<typeof fixture>>, revalidate: () => Promise<void>) {
  const rawMain = new Socket()
  const rawWorker = new Socket()
  rawMain.peer = rawWorker
  rawWorker.peer = rawMain
  const mainSocket = adaptDeviceSocket(rawMain)
  const workerSocket = adaptDeviceSocket(rawWorker)
  const client: DeviceExtensionRegistration = { ...f.extension, role: 'client' }
  const extensions = negotiateDeviceExtensions(extensionDescriptors([f.extension]), extensionDescriptors([client]))
  const abort = new AbortController()
  const main = new DeviceApplicationChannel({ side: 'main', binding: f.context.binding, socket: mainSocket,
    signal: abort.signal, extensions, registrations: [f.extension], revalidate })
  const worker = new DeviceApplicationChannel({ side: 'worker', binding: f.context.binding, socket: workerSocket,
    signal: abort.signal, extensions, registrations: [client] })
  const tasks = [main.run(mainSocket.messages[Symbol.asyncIterator](), 60_000),
    worker.run(workerSocket.messages[Symbol.asyncIterator](), 60_000)]
  cleanup.push(async () => {
    abort.abort()
    main.close()
    worker.close()
    await Promise.allSettled(tasks)
  })
  void Promise.allSettled(tasks)
  return worker
}

describe('Worker release metadata', () => {
  it('does not announce or target an unpublished Worker artifact', async () => {
    const f = await fixture({ published: false })
    const options = { directory: f.directory, version: f.manifest.version }
    await expect(readWorkerManifestSha256s(options)).rejects.toMatchObject({ code: 'WORKER_BUNDLE_UNPUBLISHED' })
    await expect(readWorkerContentSha256s(options)).rejects.toMatchObject({ code: 'WORKER_BUNDLE_UNPUBLISHED' })
    await expect(f.request({ operation: 'release', target }))
      .rejects.toMatchObject({ code: 'WORKER_RELEASE_ASSET_UNAVAILABLE' })
  })

  it('rejects bundle-byte requests even on an authenticated device channel', async () => {
    const f = await fixture()
    const worker = channelPair(f, async () => {})
    const rejected = await worker.request(WORKER_UPDATE_NAMESPACE, { operation: 'chunk', manifestSha256: f.manifestSha256,
      path: 'src/cli.mjs', offset: 0 }).then(() => false, () => true)
    expect(rejected).toBe(true)
  })

  it('serves matching published GitHub release metadata over the authenticated device channel', async () => {
    const f = await fixture()
    const worker = channelPair(f, async () => {})
    const release = await worker.request(WORKER_UPDATE_NAMESPACE, { operation: 'release', target })
    expect(release.payload).toEqual({ operation: 'release', release: {
      version: '0.0.57', manifestSha256: f.manifestSha256, manifest: f.manifest,
      github: { repository: 'example/worker', tag: `worker-${f.manifest.commit}` },
    } })
    expect(release.bytes).toBeUndefined()
  })

  it('denies a device whose authenticated grant no longer validates before serving bytes', async () => {
    const f = await fixture()
    const handle = vi.fn(f.extension.handle!)
    f.extension.handle = handle
    const worker = channelPair(f, async () => { throw Object.assign(new Error('Device revoked'), { code: 'revoked' }) })
    await expect(worker.request(WORKER_UPDATE_NAMESPACE, { operation: 'release', target })).rejects.toThrow()
    expect(handle).not.toHaveBeenCalled()
  })

  it('returns no release for an unsupported runtime and refuses a different Main version', async () => {
    const f = await fixture()
    expect(await f.request({ operation: 'release', target: { ...target, node: 'v22.1.0' } }))
      .toEqual({ payload: { operation: 'release', release: null } })
    const wrong = createWorkerArtifactExtension({ directory: f.directory, version: '0.0.58' })
    await expect(wrong.handle!({ operation: 'release', target }, f.context)).rejects.toThrow()
  })

  it('rejects every removed chunk operation, including bounded and unsafe requests', async () => {
    const f = await fixture()
    const request = { operation: 'chunk', manifestSha256: f.manifestSha256, path: 'src/cli.mjs', offset: 0 }
    for (const change of [{}, { path: 'manifest.json' }, { offset: f.content.length },
      { offset: f.content.length + 1 }, { path: 'identity.json' }, { path: '../identity.json' },
      { manifestSha256: 'c'.repeat(64) }]) {
      await expect(f.request({ ...request, ...change })).rejects.toThrow()
    }
  })

  it('rejects manifest symlink escapes and changed manifest bytes', async () => {
    const f = await fixture()
    const options = { directory: f.directory, version: f.manifest.version }
    await f.request({ operation: 'release', target })
    await writeFile(join(f.release, 'manifest.json'), Buffer.concat([f.manifestBytes, Buffer.from(' ')]))
    await expect(f.request({ operation: 'release', target })).rejects.toThrow()
    await expect(readWorkerContentSha256s(options)).rejects.toThrow()
    const outside = join(f.directory, 'outside.json')
    await writeFile(outside, f.manifestBytes)
    await rm(join(f.release, 'manifest.json'))
    await symlink(outside, join(f.release, 'manifest.json'))
    await expect(f.request({ operation: 'release', target })).rejects.toThrow()
  })

  it('exposes publication failures independently of available update targets', async () => {
    const f = await fixture({ published: false })
    const options = { directory: f.directory, version: f.manifest.version }
    const publication = { state: 'failed', lastError: 'WORKER_RELEASE_ASSET_UNAVAILABLE: GitHub unavailable' }
    await writeFile(join(f.directory, 'index.json'), JSON.stringify({ format: 1, version: f.manifest.version,
      artifacts: [{ target, manifestSha256: f.manifestSha256 }], publication }))
    expect(await readWorkerReleasePublication(options)).toEqual({ version: f.manifest.version, ...publication })
    await expect(readWorkerManifestSha256s(options)).rejects.toMatchObject({
      code: 'WORKER_BUNDLE_UNPUBLISHED', details: { publicationError: publication.lastError },
    })
  })
})
