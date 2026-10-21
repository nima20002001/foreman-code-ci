import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { mainIdentityProofMessage } from '@foreman-code/contracts/device-identity-node'
import { workerArtifactContentSha256 } from '@foreman-code/contracts/worker-artifact-content-node'
import { COMPUTER_MAINTENANCE_NAMESPACE } from '@foreman-code/contracts/computer-maintenance'
import type { DeviceApplicationResult } from '@foreman-code/contracts/device-application'
import { DeviceEndpoint } from '../../src/modules/devices/deviceEndpoint.js'
import { DeviceConnectionSupervisor } from '../../src/modules/devices/connectionSupervisor.js'
import { adaptDeviceSocket } from '../../src/modules/devices/deviceWire.js'

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

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export async function workerBundleFixture() {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'worker-bundle-'))
  const identity = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1 }
  const target = { os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.23.3' }
  const manifest = { format: 1 as const, version: '1.1.0', commit: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64),
    packageManager: 'pnpm@11.27.0' as const, protocolVersion: 1 as const, identityFormat: 1 as const, target,
    files: [{ path: 'src/cli.mjs', size: 1, sha256: 'c'.repeat(64) }] }
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  const expected = { version: manifest.version, target, manifestSha256: sha256(bytes),
    contentSha256: workerArtifactContentSha256(manifest) }
  await mkdir(join(directory, expected.manifestSha256), { mode: 0o700 })
  await writeFile(join(directory, expected.manifestSha256, 'manifest.json'), bytes)
  const index = { format: 1, version: manifest.version,
    artifacts: [{ target, manifestSha256: expected.manifestSha256, contentSha256: expected.contentSha256 }],
    github: { repository: 'example/worker', tag: `worker-${manifest.commit}` },
    publication: { state: 'published', lastError: null as string | null } }
  const publish = () => writeFile(join(directory, 'index.json'), JSON.stringify(index))
  await publish()
  const status = { observedAt: new Date().toISOString(), harnesses: [], tasks: [],
    system: { packageUpdates: null, rebootRequired: false, sudo: false, disk: null },
    worker: { currentVersion: manifest.version, target, manifestSha256: 'd'.repeat(64), contentSha256: 'e'.repeat(64),
      targetVersion: null, state: 'current', lastError: null } }
  const handled = vi.fn(async (payload: unknown) => ({ payload }))
  // A real Worker's full status runs slow version, registry and package inspections; only its bundle facts are fast.
  let fullStatus: Promise<void> | undefined
  let statusFailure: Error | undefined
  const bundleStatus = vi.fn(async (): Promise<DeviceApplicationResult> => ({ payload: { operation: 'worker', worker: status.worker } }))
  const maintenance = async (payload: { operation?: string; scope?: string }) => {
    if (payload.operation !== 'status') return handled(payload)
    if (statusFailure) throw statusFailure
    if (payload.scope === 'worker') return bundleStatus()
    await fullStatus
    return { payload: { operation: 'status', status } }
  }
  const keys = generateKeyPairSync('ed25519')
  const mainPublicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const mainPublicKeyFingerprint = sha256(keys.publicKey.export({ type: 'spki', format: 'der' }))
  const namespaces = ['execution-v1', 'execution-prepare', 'ci-host-v1', COMPUTER_MAINTENANCE_NAMESPACE]
  const descriptors = namespaces.map(namespace => ({ namespace, version: ['execution-prepare', COMPUTER_MAINTENANCE_NAMESPACE].includes(namespace) ? 2 : 1,
    maxJsonBytes: 1_048_576, maxBinaryBytes: 0 }))
  const endpoint = new DeviceEndpoint({ mainId: identity.mainId, appVersion: manifest.version,
    ...{ workerArtifacts: { directory, version: manifest.version } },
    auth: { authenticateDevice: async () => ({ ...identity, audience: 'graphql-worker', expiresAt: '2099-01-01T00:00:00Z' }),
      revalidateDevice: async () => {} },
    signMainIdentityProof: async request => ({ request, mainApplicationVersion: manifest.version, mainPublicKey,
      mainPublicKeyFingerprint, signature: sign(null, Buffer.from(mainIdentityProofMessage(request, manifest.version)),
        keys.privateKey).toString('base64url') }),
    presence: () => {}, reconcile: async () => {},
    extensions: descriptors.map(descriptor => ({ ...descriptor, role: 'client' })),
  })
  const tasks: Promise<void>[] = []
  const sockets: Socket[] = []
  const worker = new DeviceConnectionSupervisor({ identity, appVersion: manifest.version, mainPublicKeyFingerprint,
    extensions: descriptors.map(descriptor => ({ ...descriptor, role: 'server',
      handle: async (payload: unknown) => descriptor.namespace === COMPUTER_MAINTENANCE_NAMESPACE
        ? maintenance(payload as { operation?: string; scope?: string }) : handled(payload) })),
    reconcile: async () => {}, random: () => 0,
    connect: async () => {
      const main = new Socket()
      const peer = new Socket()
      main.peer = peer
      peer.peer = main
      sockets.push(main)
      tasks.push(endpoint.accept({ authorization: 'Bearer fixture-token' }, adaptDeviceSocket(main)))
      return adaptDeviceSocket(peer)
    },
  })
  worker.start()
  await vi.waitFor(() => expectReady(), { timeout: 2000, interval: 10 })
  function expectReady() {
    if (worker.status().phase !== 'ready') throw new Error('Worker connection is not ready')
  }
  const request = (namespace: string, payload: unknown) => endpoint.request(identity.deviceId, namespace, payload)
  return { endpoint, identity, expected, status, index, publish, handled, bundleStatus, request,
    /** Holds full maintenance status until the returned release runs. */
    holdFullStatus() {
      let release!: () => void
      fullStatus = new Promise<void>(resolve => { release = resolve })
      return release
    },
    /** Every maintenance status read fails with this Worker-side error. */
    failStatus(error: Error) { statusFailure = error },
    match() { Object.assign(status.worker, { manifestSha256: expected.manifestSha256, contentSha256: expected.contentSha256 }) },
    async reconnect() {
      const generation = worker.status().generation
      sockets.at(-1)!.close()
      await vi.waitFor(() => {
        if (worker.status().generation <= generation) throw new Error('Waiting for replacement connection')
        expectReady()
      }, { timeout: 2000, interval: 10 })
    },
    async close() {
      await worker.stop()
      endpoint.close()
      await Promise.all(tasks)
      await endpoint.join()
      await rm(directory, { recursive: true, force: true })
    } }
}
