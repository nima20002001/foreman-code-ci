import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { publicKeyFingerprint } from '@foreman-code/contracts/device-identity-node'
import { DeviceConnectionSupervisor } from './connectionSupervisor.js'
import { DeviceEndpoint } from './deviceEndpoint.js'
import { adaptDeviceSocket } from './deviceWire.js'
import { signMainIdentityProof } from './mainIdentity.js'
import { ciDatabasePriority, withCiDatabasePriority } from '../../infrastructure/ciDatabasePriority.js'

class Socket extends EventEmitter {
  bufferedAmount = 0
  closed = false
  peer?: Socket
  frames: { type: string; mainReady?: true }[] = []

  send(text: string) {
    if (this.closed) throw new Error('Socket closed')
    this.frames.push(JSON.parse(text) as { type: string; mainReady?: true })
    queueMicrotask(() => {
      if (!this.peer?.closed) this.peer?.emit('message', Buffer.from(text), false)
    })
  }

  close() {
    if (this.closed) return
    this.closed = true
    queueMicrotask(() => {
      this.emit('close', 1005)
      this.peer?.close()
    })
  }
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

async function fixture(namespace = 'test-echo') {
  vi.useFakeTimers()
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const mainIdentity = { mainId: randomUUID(), publicKey,
    privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyFingerprint: publicKeyFingerprint(publicKey) }
  const identity = { mainId: mainIdentity.mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID() }
  const principal = { ...identity, audience: 'graphql-worker' as const,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString() }
  let validate = async () => {}
  const revalidate = vi.fn(() => validate())
  const handle = vi.fn(async (payload: unknown) => ({ payload }))
  const workerHandle = vi.fn(async (payload: unknown) => ({ payload }))
  const extension = { namespace, version: namespace === 'computer-maintenance-v2' ? 2 : 1, role: 'duplex' as const,
    maxJsonBytes: 65_536, maxBinaryBytes: 0 }
  const endpoint = new DeviceEndpoint({ mainId: identity.mainId, appVersion: 'test-main',
    auth: { authenticateDevice: async () => principal, revalidateDevice: revalidate },
    signMainIdentityProof: async request => signMainIdentityProof(mainIdentity, request, 'test-main'),
    reconcile: async () => {}, presence: () => {}, extensions: [{ ...extension, handle }] })
  const connections: { main: Socket; worker: Socket }[] = []
  const tasks: Promise<void>[] = []
  const worker = new DeviceConnectionSupervisor({ identity, appVersion: 'test-worker',
    mainPublicKeyFingerprint: mainIdentity.publicKeyFingerprint,
    reconcile: async () => {}, extensions: [{ ...extension, handle: workerHandle }],
    connect: async () => {
      const main = new Socket()
      const remote = new Socket()
      main.peer = remote
      remote.peer = main
      connections.push({ main, worker: remote })
      tasks.push(endpoint.accept({ authorization: 'Bearer test-credential' }, adaptDeviceSocket(main)))
      return adaptDeviceSocket(remote)
    } })
  worker.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(worker.status()).toMatchObject({ phase: 'ready', generation: 1 })
  revalidate.mockClear()
  const binding = endpoint.currentBinding(identity.deviceId)
  return { worker, endpoint, identity, connections, handle, workerHandle, revalidate, binding,
    setValidation(callback: () => Promise<void>) { validate = callback },
    async close() {
      await worker.stop()
      endpoint.close()
      await Promise.all(tasks)
      await endpoint.join()
    } }
}

afterEach(() => vi.useRealTimers())

it('preserves maintenance observation support through the signed connection handshake', async () => {
  const f = await fixture('computer-maintenance-v2')
  try {
    expect(f.worker.capabilities()).toContainEqual(expect.objectContaining({
      namespace: 'computer-maintenance-v2', observationAdmission: true,
    }))
    await expect(f.endpoint.request(f.identity.deviceId, 'computer-maintenance-v2',
      { operation: 'status', scope: 'worker' })).resolves.toEqual({ payload: { operation: 'status', scope: 'worker' } })
    expect(f.connections[0]!.main.frames).toContainEqual(expect.objectContaining({
      type: 'application-open', namespace: 'computer-maintenance-v2', admission: 'observation',
    }))
    expect(f.worker.status()).toMatchObject({ phase: 'ready', generation: 1 })
  } finally { await f.close() }
})

it('answers heartbeats and keeps serving a recently authorized link while its authorization read stalls', async () => {
  const f = await fixture()
  const read = deferred()
  f.setValidation(() => read.promise)
  try {
    // Synchronous draining answers the queued ping before reconciliation announces Main readiness.
    expect(f.connections[0]!.main.frames.filter(frame => frame.type === 'pong')).toEqual([
      expect.objectContaining({ type: 'pong' }),
      expect.objectContaining({ type: 'pong', mainReady: true }),
    ])
    const requests = Array.from({ length: 8 }, (_, index) =>
      f.worker.request('test-echo', { index }).catch((error: unknown) => error))
    await vi.advanceTimersByTimeAsync(35_000)
    expect(f.worker.status()).toMatchObject({ phase: 'ready', generation: 1 })
    expect(f.endpoint.currentBinding(f.identity.deviceId)).toEqual(f.binding)
    expect(f.connections[0]!.main.frames.filter(frame => frame.type === 'pong').map(frame => frame.mainReady))
      .toEqual([undefined, true, undefined, undefined])
    expect(f.revalidate).toHaveBeenCalledTimes(1)
    expect(await Promise.all(requests)).toEqual(Array.from({ length: 8 }, (_, index) => ({ payload: { index } })))
    await vi.advanceTimersByTimeAsync(120_000)
    const stale = f.worker.request('test-echo', { stale: true }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(stale).resolves.toMatchObject({ retryable: true })
    expect(f.handle).toHaveBeenCalledTimes(8)
    read.resolve()
    await vi.advanceTimersByTimeAsync(0)
    await expect(f.worker.request('test-echo', { recovered: true })).resolves.toEqual({ payload: { recovered: true } })
    expect(f.handle).toHaveBeenCalledTimes(9)
  } finally {
    read.resolve()
    await f.close()
  }
})

it('serves a recently authorized link through an authorization database failure and refuses work only once that authorization is stale', async () => {
  const f = await fixture()
  f.setValidation(async () => { throw new Error('Query read timeout') })
  try {
    await expect(f.worker.request('test-echo', { during: true })).resolves.toEqual({ payload: { during: true } })
    await expect(f.endpoint.request(f.identity.deviceId, 'test-echo', { main: true }))
      .resolves.toEqual({ payload: { main: true } })
    await vi.advanceTimersByTimeAsync(125_000)
    expect(f.worker.status()).toMatchObject({ phase: 'ready', generation: 1 })
    await expect(f.worker.request('test-echo', { stale: true })).rejects.toMatchObject({ code: 'unavailable', retryable: true })
    expect(f.handle).toHaveBeenCalledOnce()
    expect(f.endpoint.currentBinding(f.identity.deviceId)).toEqual(f.binding)
    f.setValidation(async () => {})
    await expect(f.worker.request('test-echo', { recovered: true })).resolves.toEqual({ payload: { recovered: true } })
    expect(f.worker.status()).toMatchObject({ phase: 'ready', generation: 1 })
  } finally { await f.close() }
})

it('delivers a Worker response on a recently authorized link while the authorization read fails', async () => {
  const f = await fixture()
  f.workerHandle.mockImplementation(async payload => {
    f.setValidation(async () => { throw new Error('Query read timeout') })
    return { payload }
  })
  try {
    await expect(f.endpoint.request(f.identity.deviceId, 'test-echo', { value: true }))
      .resolves.toEqual({ payload: { value: true } })
    expect(f.endpoint.currentBinding(f.identity.deviceId)).toEqual(f.binding)
    expect(f.worker.status()).toMatchObject({ phase: 'ready', generation: 1 })
  } finally { await f.close() }
})

it('authorizes a request made by CI dispatch without the CI dispatch database connections', async () => {
  const f = await fixture()
  try {
    f.setValidation(async () => { throw new Error('Query read timeout') })
    await vi.advanceTimersByTimeAsync(125_000)
    // The CI dispatch connections are exhausted: a read that borrows them times out.
    f.setValidation(async () => {
      if (ciDatabasePriority()) throw new Error('timeout exceeded when trying to connect')
    })
    await expect(withCiDatabasePriority(() => f.endpoint.request(f.identity.deviceId, 'test-echo', { ci: true })))
      .resolves.toEqual({ payload: { ci: true } })
    await expect(withCiDatabasePriority(() => f.worker.request('test-echo', { status: true })))
      .resolves.toEqual({ payload: { status: true } })
  } finally { await f.close() }
})

it('closes a recently authorized link at once when the device is revoked', async () => {
  const f = await fixture()
  try {
    f.endpoint.revoke(f.identity.deviceId, f.identity.authorizationRevision)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.endpoint.currentBinding(f.identity.deviceId)).toBeUndefined()
    await expect(f.endpoint.request(f.identity.deviceId, 'test-echo', { revoked: true })).rejects.toBeDefined()
    expect(f.worker.status()).toMatchObject({ phase: 'blocked', failure: 'revoked', generation: 1 })
    expect(f.workerHandle).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it('survives transient heartbeat authorization failures but closes on explicit revocation', async () => {
  const f = await fixture()
  try {
    f.setValidation(async () => { throw new Error('Query read timeout') })
    await vi.advanceTimersByTimeAsync(35_000)
    expect(f.worker.status()).toMatchObject({ phase: 'ready', generation: 1 })
    f.setValidation(async () => { throw Object.assign(new Error('Device revoked'), { code: 'revoked' }) })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.worker.status()).toMatchObject({ phase: 'blocked', failure: 'revoked', generation: 1 })
    expect(f.endpoint.currentBinding(f.identity.deviceId)).toBeUndefined()
    expect(f.handle).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it.each(['revoked', 'unauthorized'])('closes the link when %s arrives after the heartbeat authorization timeout', async code => {
  const f = await fixture()
  const read = deferred()
  f.setValidation(() => read.promise)
  try {
    await vi.advanceTimersByTimeAsync(25_000)
    expect(f.revalidate).toHaveBeenCalledOnce()
    expect(f.worker.status()).toMatchObject({ phase: 'ready', generation: 1 })
    await expect(f.endpoint.request(f.identity.deviceId, 'test-echo', { cached: true }))
      .resolves.toEqual({ payload: { cached: true } })

    read.reject(Object.assign(new Error('Device authorization denied'), { code }))
    await vi.advanceTimersByTimeAsync(0)

    expect(f.connections[0]!.main.closed).toBe(true)
    expect(f.endpoint.currentBinding(f.identity.deviceId)).toBeUndefined()
    await expect(f.endpoint.request(f.identity.deviceId, 'test-echo', { denied: true })).rejects.toBeDefined()
    expect(f.workerHandle).toHaveBeenCalledOnce()
  } finally {
    read.resolve()
    await f.close()
  }
})

it('keeps the link open when a transient failure arrives after the heartbeat authorization timeout', async () => {
  const f = await fixture()
  const read = deferred()
  f.setValidation(() => read.promise)
  try {
    await vi.advanceTimersByTimeAsync(25_000)
    expect(f.revalidate).toHaveBeenCalledOnce()
    read.reject(new Error('Query read timeout'))
    await vi.advanceTimersByTimeAsync(0)

    expect(f.connections[0]!.main.closed).toBe(false)
    expect(f.endpoint.currentBinding(f.identity.deviceId)).toEqual(f.binding)
    expect(f.worker.status()).toMatchObject({ phase: 'ready', generation: 1 })
    await expect(f.endpoint.request(f.identity.deviceId, 'test-echo', { cached: true }))
      .resolves.toEqual({ payload: { cached: true } })
  } finally {
    read.resolve()
    await f.close()
  }
})
