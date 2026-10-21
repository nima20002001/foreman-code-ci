import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { WORKER_UPDATE_NAMESPACE, WORKER_UPDATE_MAX_JSON_BYTES } from '@foreman-code/contracts/computer-maintenance'
import { mainIdentityProofMessage } from '@foreman-code/contracts/device-identity-node'
import { WorkerUpdater } from '../../../../worker/src/update.mjs'
import { previousWorkerInventory } from '../../../test/support/previousWorkerHarness.js'
import { createWorkerArtifactExtension } from '../computers/workerArtifacts.js'
import { ProductionHarnessRegistry } from '../harnesses/productionRegistry.js'
import { HostHarnessProfileEvidenceRepository } from '../harnesses/instanceSettings/profileRepository.js'
import { DeviceConnectionSupervisor } from './connectionSupervisor.js'
import { DeviceEndpoint } from './deviceEndpoint.js'
import { adaptDeviceSocket } from './deviceWire.js'

class Socket extends EventEmitter {
  bufferedAmount = 0
  peer?: Socket
  closed = false
  send(text: string) {
    if (this.closed) throw new Error('Socket closed')
    queueMicrotask(() => { if (!this.peer?.closed) this.peer?.emit('message', text, false) })
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
    this.peer?.close()
  }
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const target = { os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.23.2' }

async function fixture() {
  const storage = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(storage, { recursive: true })
  const root = await mkdtemp(join(storage, 'previous-worker-update-'))
  const identity = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1 }
  const keys = generateKeyPairSync('ed25519')
  const mainPublicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const mainPublicKeyFingerprint = sha256(keys.publicKey.export({ type: 'spki', format: 'der' }))
  const bundle = join(root, 'bundle')
  const artifacts = join(root, 'artifacts')
  const stateDirectory = join(root, 'state')
  const releaseDirectory = join(root, 'installed')
  await Promise.all([mkdir(join(bundle, 'src'), { recursive: true }), mkdir(artifacts, { mode: 0o700 }),
    mkdir(stateDirectory, { mode: 0o700 }), mkdir(join(releaseDirectory, 'src'), { recursive: true, mode: 0o700 })])
  const previousBytes = Buffer.from('export const worker = "previous"\n')
  const bytes = Buffer.from('export const worker = "updated"\n')
  const manifest = { format: 1, version: '1.1.0', commit: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64),
    packageManager: 'pnpm@11.27.0', protocolVersion: 1, identityFormat: 1, target,
    sourceSnapshot: { commit: 'a'.repeat(40), files: [] },
    files: [{ path: 'src/cli.mjs', size: bytes.length, sha256: sha256(bytes) }] }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  const manifestSha256 = sha256(manifestBytes)
  const previousManifestBytes = Buffer.from(`${JSON.stringify({ ...manifest, version: '1.0.0',
    files: [{ path: 'src/cli.mjs', size: previousBytes.length, sha256: sha256(previousBytes) }] }, null, 2)}\n`)
  await mkdir(join(artifacts, manifestSha256))
  await Promise.all([writeFile(join(bundle, 'manifest.json'), manifestBytes), writeFile(join(bundle, 'src/cli.mjs'), bytes),
    writeFile(join(artifacts, manifestSha256, 'manifest.json'), manifestBytes),
    writeFile(join(releaseDirectory, 'manifest.json'), previousManifestBytes),
    writeFile(join(releaseDirectory, 'src/cli.mjs'), previousBytes),
    writeFile(join(artifacts, 'index.json'), JSON.stringify({ format: 1, version: manifest.version,
      artifacts: [{ target, manifestSha256 }], github: { repository: 'example/worker', tag: `worker-${manifest.commit}` },
      publication: { state: 'published', lastError: null } }))])
  const smoke = { repository: 'example/worker', commit: manifest.commit }
  const artifactExtension = createWorkerArtifactExtension({ directory: artifacts, version: manifest.version,
    buildEnabled: async () => true, ciSmoke: async () => smoke })
  const artifactRequests: string[] = []
  const pool = new pg.Pool({ connectionString: 'postgresql://unused@127.0.0.1:1/unused' })
  const tasks: Promise<void>[] = []
  const sockets: Socket[] = []
  const reconciled = vi.fn()
  const endpoint: DeviceEndpoint = new DeviceEndpoint({ mainId: identity.mainId, appVersion: '1.1.0',
    auth: { authenticateDevice: async () => ({ ...identity, audience: 'graphql-worker', expiresAt: '2099-01-01T00:00:00Z' }),
      revalidateDevice: async () => {} },
    signMainIdentityProof: async request => ({ request, mainApplicationVersion: '1.1.0', mainPublicKey,
      mainPublicKeyFingerprint, signature: sign(null, Buffer.from(mainIdentityProofMessage(request, '1.1.0')),
        keys.privateKey).toString('base64url') }),
    presence: () => {}, heartbeatMs: 100, handshakeMs: 2000,
    extensions: [{ namespace: 'harness-discovery-v1', version: 1, role: 'client', maxJsonBytes: 1_048_576,
      maxBinaryBytes: 0 }, { ...artifactExtension, async handle(payload, context) {
      artifactRequests.push((payload as { operation: string }).operation)
      return artifactExtension.handle!(payload, context)
    } }],
    reconcile: async (binding, signal) => {
      const result = await endpoint.request(binding.deviceId, 'harness-discovery-v1',
        { operation: 'discover', refreshId: randomUUID() }, { signal })
      registry.acceptRemoteSnapshot(binding, result.payload)
      reconciled()
    },
  })
  const registry = new ProductionHarnessRegistry(pool, { codexBinary: 'codex' },
    async () => ({ revision: 1, defaults: DEFAULT_HARNESS_DEFAULTS }), new HostHarnessProfileEvidenceRepository(pool),
    () => endpoint.currentBinding(identity.deviceId) ?? null)
  // Hello, signed welcome, chunk framing and updater requests are unchanged in protocol 1.
  const worker = new DeviceConnectionSupervisor({ identity, appVersion: '1.0.0', mainPublicKeyFingerprint,
    extensions: [{ namespace: 'harness-discovery-v1', version: 1, role: 'server', maxJsonBytes: 1_048_576,
      maxBinaryBytes: 0, handle: async (_payload, context) => ({ payload: previousWorkerInventory(context.binding) }) },
    { namespace: WORKER_UPDATE_NAMESPACE, version: 1, role: 'client', maxJsonBytes: WORKER_UPDATE_MAX_JSON_BYTES,
      maxBinaryBytes: 0 }],
    heartbeatMs: 50, handshakeMs: 2000, random: () => 0,
    reconcile: async () => {}, connect: async () => {
      const mainSocket = new Socket()
      const workerSocket = new Socket()
      mainSocket.peer = workerSocket
      workerSocket.peer = mainSocket
      sockets.push(mainSocket)
      tasks.push(endpoint.accept({ authorization: 'Bearer fixture-device-token' }, adaptDeviceSocket(mainSocket)))
      return adaptDeviceSocket(workerSocket)
    },
  })
  const waitReady = async () => {
    await vi.waitFor(() => {
      expect(endpoint.currentBinding(identity.deviceId)).toBeDefined()
      expect(reconciled).toHaveBeenCalled()
      expect(worker.status().phase).toBe('ready')
    }, { timeout: 1500, interval: 10 })
  }
  const launchSupervisor = vi.fn(async () => {})
  let duringDownload = async () => {}
  const updater = await new WorkerUpdater({ stateDirectory, releaseDirectory, version: '1.0.0',
    manifestSha256: sha256(previousManifestBytes), facts: { ...target, rootPersistent: true,
      homePersistent: true, storagePersistent: true }, workerInstallationId: identity.workerInstallationId,
    connection: () => worker, assertStateOwnership: () => {}, drain: async () => {}, resume: () => {},
    fetchAsset: async ({ destination }: { destination: string }) => {
      await duringDownload()
      execFileSync('tar', ['-czf', destination, '-C', bundle, '.'])
    }, stage: async () => ({ directory: bundle }), launchSupervisor,
    locateLaunch: async () => ({ root, previousDirectory: releaseDirectory }),
  }).initialize()
  const close = async () => {
    await updater.close()
    await worker.stop()
    endpoint.close()
    await Promise.all(tasks)
    await endpoint.join()
    registry.stop()
    await pool.end()
    await rm(root, { recursive: true, force: true })
  }
  return { worker, updater, waitReady, close, sockets, reconciled, artifactRequests, launchSupervisor, smoke,
    stateDirectory, duringDownload: (callback: () => Promise<void>) => { duringDownload = callback } }
}

it('keeps a previous protocol-1 Worker connected through heartbeat, inventory and update smoke configuration', async () => {
  const f = await fixture()
  try {
    expect(await f.updater.status()).toMatchObject({ target, currentVersion: '1.0.0' })
    f.worker.start()
    await f.waitReady()
    await new Promise(resolve => setTimeout(resolve, 800))
    expect(f.worker.status()).toMatchObject({ phase: 'ready', generation: 1 })
    expect(await f.updater.start()).toBe('Worker 1.1.0 restart is scheduled.')
    expect(f.artifactRequests).toEqual(['release', 'ci-smoke'])
    expect(f.launchSupervisor).toHaveBeenCalledOnce()
    const record = JSON.parse(await readFile(join(f.stateDirectory, 'worker-update.json'), 'utf8'))
    expect(record).toMatchObject({ status: { state: 'restarting', lastError: null }, restart: { ciSmoke: f.smoke } })
  } finally { await f.close() }
})

it('reads smoke configuration on the live protocol-1 channel after a reconnect during the update download', async () => {
  const f = await fixture()
  try {
    f.worker.start()
    await f.waitReady()
    f.duringDownload(async () => {
      f.reconciled.mockClear()
      f.sockets[0]!.close()
      await vi.waitFor(() => expect(f.worker.status().generation).toBe(2), { timeout: 1500, interval: 10 })
      await f.waitReady()
    })
    expect(await f.updater.start()).toBe('Worker 1.1.0 restart is scheduled.')
    expect(f.artifactRequests).toEqual(['release', 'ci-smoke'])
    expect(f.launchSupervisor).toHaveBeenCalledOnce()
  } finally { await f.close() }
})
