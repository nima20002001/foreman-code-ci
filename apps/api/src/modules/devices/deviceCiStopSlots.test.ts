import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { CI_HOST_NAMESPACE } from '@foreman-code/contracts'
import { negotiateDeviceExtensions, parseExtensionDescriptors, type DeviceApplicationResult }
  from '@foreman-code/contracts/device-application'
import { mainIdentityProofMessage } from '@foreman-code/contracts/device-identity-node'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { deferred } from '../../../test/helpers/deferred.js'
import { DeviceApplicationChannel, extensionDescriptors } from './deviceApplicationChannel.js'
import { DeviceConnectionSupervisor } from './connectionSupervisor.js'
import { DeviceEndpoint } from './deviceEndpoint.js'
import { adaptDeviceSocket } from './deviceWire.js'

class Socket extends EventEmitter {
  bufferedAmount = 0
  peer?: Socket
  closed = false
  rejectsCiStop = false
  readonly frames: Record<string, unknown>[] = []
  send(text: string) {
    const frame = JSON.parse(text) as Record<string, unknown>
    this.frames.push(frame)
    queueMicrotask(() => {
      if (this.peer?.rejectsCiStop && frame.type === 'application-open'
        && frame.namespace === CI_HOST_NAMESPACE && frame.admission === 'stop') {
        this.peer.close()
        return
      }
      if (!this.closed && !this.peer?.closed) this.peer?.emit('message', Buffer.from(text), false)
    })
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
    this.peer?.close()
  }
}

function pair(handle: (payload: unknown) => Promise<DeviceApplicationResult>,
  options: { workerAdvertisesCiStop?: boolean } = {}) {
  const binding: DeviceSessionBinding = { mainId: randomUUID(), deviceId: randomUUID(),
    workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1,
    bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1 }
  const registration = { namespace: CI_HOST_NAMESPACE, version: 1, maxJsonBytes: 1_048_576, maxBinaryBytes: 0 }
  const server = { ...registration, role: 'server' as const, handle }
  const mainDescriptors = extensionDescriptors([{ ...registration, role: 'client' }])
  const workerDescriptors = options.workerAdvertisesCiStop === false
    ? parseExtensionDescriptors([server]) : extensionDescriptors([server])
  const extensions = negotiateDeviceExtensions(mainDescriptors, workerDescriptors)
  const mainRaw = new Socket()
  const workerRaw = new Socket()
  workerRaw.rejectsCiStop = options.workerAdvertisesCiStop === false
  mainRaw.peer = workerRaw
  workerRaw.peer = mainRaw
  const mainSocket = adaptDeviceSocket(mainRaw)
  const workerSocket = adaptDeviceSocket(workerRaw)
  const main = new DeviceApplicationChannel({ side: 'main', binding, socket: mainSocket,
    signal: new AbortController().signal, extensions, registrations: [] })
  const worker = new DeviceApplicationChannel({ side: 'worker', binding, socket: workerSocket,
    signal: new AbortController().signal, extensions,
    registrations: [server] })
  const carriers = [main.run(mainSocket.messages[Symbol.asyncIterator](), 15_000),
    worker.run(workerSocket.messages[Symbol.asyncIterator](), 15_000)]
  const carrierResults = Promise.allSettled(carriers)
  return { main, worker, mainRaw, workerRaw, mainSocket, workerSocket, carrierResults }
}

it('advertises CI Stop admission and negotiates it only with support from both peers', () => {
  const registration = { namespace: CI_HOST_NAMESPACE, version: 1, maxJsonBytes: 1_048_576, maxBinaryBytes: 0 }
  const client = { ...registration, role: 'client' as const }
  const server = { ...registration, role: 'server' as const, handle: async () => ({ payload: 'ok' }) }
  const main = extensionDescriptors([client])
  const worker = extensionDescriptors([server])
  expect(worker[0]).toMatchObject({ ciStopAdmission: true })
  expect(negotiateDeviceExtensions(main, worker)[0]).toMatchObject({ ciStopAdmission: true })
  expect(negotiateDeviceExtensions(main, parseExtensionDescriptors([server]))[0])
    .not.toHaveProperty('ciStopAdmission')
  expect(negotiateDeviceExtensions([client], worker)[0]).not.toHaveProperty('ciStopAdmission')
  expect(() => parseExtensionDescriptors([{ ...server, ciStopAdmission: false }])).toThrow('Invalid device extension')
})

it('delivers validated CI cancellation while ordinary requests occupy both peers', async () => {
  const released = deferred()
  const handled = vi.fn(async (payload: unknown) => {
    if ((payload as { operation: string }).operation !== 'cancel') await released.promise
    return { payload }
  })
  const { main, worker, mainSocket, workerSocket, carrierResults } = pair(handled)
  const requests: Promise<unknown>[] = []
  try {
    requests.push(...Array.from({ length: 8 }, () => main.request(CI_HOST_NAMESPACE, { operation: 'status' }, { priority: 'foreground' })))
    await vi.waitFor(() => expect(handled).toHaveBeenCalledTimes(8))
    const invalid = { operation: 'cancel', runId: 'invalid' }
    requests.push(main.request(CI_HOST_NAMESPACE, invalid))
    const request = { operation: 'cancel', runId: randomUUID() }
    const canceling = main.request(CI_HOST_NAMESPACE, request)
    requests.push(canceling)
    await vi.waitFor(() => expect(handled.mock.calls.map(([payload]) => payload)).toContainEqual(request))
    expect(handled.mock.calls.map(([payload]) => payload)).not.toContainEqual(invalid)
    await expect(canceling).resolves.toEqual({ payload: request })
    released.resolve()
    await Promise.all(requests)
    expect(handled.mock.calls.map(([payload]) => payload)).toContainEqual(invalid)
  } finally {
    released.resolve()
    main.close()
    worker.close()
    await Promise.all([carrierResults, Promise.allSettled(requests), main.join(), worker.join()])
    mainSocket.close()
    workerSocket.close()
  }
})

it('keeps ordinary CI cancellation framing and the shared channel for a Worker without Stop admission', async () => {
  const released = deferred()
  const handled = vi.fn(async (payload: unknown) => {
    if ((payload as { operation: string }).operation === 'status') await released.promise
    return { payload }
  })
  const f = pair(handled, { workerAdvertisesCiStop: false })
  const occupied = f.main.request(CI_HOST_NAMESPACE, { operation: 'status' })
  let canceling: Promise<unknown> | undefined
  try {
    await vi.waitFor(() => expect(handled).toHaveBeenCalledOnce())
    const request = { operation: 'cancel', runId: randomUUID() }
    canceling = f.main.request(CI_HOST_NAMESPACE, request)
    await expect(canceling).resolves.toEqual({ payload: request })
    expect(f.mainRaw.frames.filter(frame => frame.type === 'application-open')).toHaveLength(2)
    expect(f.mainRaw.frames.filter(frame => frame.type === 'application-open'))
      .not.toContainEqual(expect.objectContaining({ admission: 'stop' }))
    expect(f.mainRaw.closed).toBe(false)
    expect(f.workerRaw.closed).toBe(false)
    released.resolve()
    await expect(occupied).resolves.toEqual({ payload: { operation: 'status' } })
  } finally {
    released.resolve()
    f.main.close()
    f.worker.close()
    await Promise.all([f.carrierResults, Promise.allSettled([occupied, ...(canceling ? [canceling] : [])]),
      f.main.join(), f.worker.join()])
    f.mainSocket.close()
    f.workerSocket.close()
  }
})


it.each([
  [CI_HOST_NAMESPACE, 'ciStopAdmission'],
  ['execution-v1', 'callbackAdmission'],
] as const)('preserves %s support through the authenticated Worker handshake', async (namespace, capability) => {
  const identity = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID() }
  const keys = generateKeyPairSync('ed25519')
  const mainPublicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const mainPublicKeyFingerprint = createHash('sha256')
    .update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
  const registration = { namespace, version: 1, maxJsonBytes: 1_048_576, maxBinaryBytes: 0 }
  const main = new DeviceEndpoint({ mainId: identity.mainId, appVersion: 'main-build',
    auth: { authenticateDevice: async () => ({ ...identity, audience: 'graphql-worker',
      expiresAt: '2099-01-01T00:00:00Z' }), revalidateDevice: async () => {} },
    signMainIdentityProof: async request => ({ request, mainApplicationVersion: 'main-build',
      mainPublicKey, mainPublicKeyFingerprint,
      signature: sign(null, Buffer.from(mainIdentityProofMessage(request, 'main-build')), keys.privateKey)
        .toString('base64url') }),
    reconcile: async () => {}, presence: () => {}, extensions: [{ ...registration, role: 'client' }],
  })
  const connections: Promise<void>[] = []
  const sockets: Socket[] = []
  const worker = new DeviceConnectionSupervisor({ identity, appVersion: 'worker-build', mainPublicKeyFingerprint,
    connect: async () => {
      const mainRaw = new Socket()
      const workerRaw = new Socket()
      mainRaw.peer = workerRaw
      workerRaw.peer = mainRaw
      sockets.push(mainRaw)
      const mainSocket = adaptDeviceSocket(mainRaw)
      const workerSocket = adaptDeviceSocket(workerRaw)
      connections.push(main.accept({ authorization: 'Bearer fixture-device' }, mainSocket))
      return workerSocket
    }, reconcile: async () => {},
    extensions: [{ ...registration, role: 'server', handle: async payload => ({ payload }) }],
  })
  try {
    worker.start()
    await vi.waitFor(() => expect(worker.status().phase).toBe('ready'))
    expect(main.capabilities(identity.deviceId)).toContainEqual(expect.objectContaining({ [capability]: true }))
    const request = { operation: 'cancel', runId: randomUUID() }
    await expect(main.request(identity.deviceId, namespace, request)).resolves.toEqual({ payload: request })
    const admission = namespace === CI_HOST_NAMESPACE ? { admission: 'stop' } : {}
    expect(sockets[0]!.frames).toContainEqual(expect.objectContaining({ type: 'application-open', namespace,
      ...admission }))
  } finally {
    await worker.stop()
    main.close()
    await Promise.all([...connections, main.join()])
  }
})
