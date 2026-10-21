import { EventEmitter } from 'node:events'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { mainIdentityProofMessage } from '@foreman-code/contracts/device-identity-node'
import { DeviceEndpoint } from '../src/modules/devices/deviceEndpoint.js'
import { DeviceConnectionSupervisor } from '../src/modules/devices/connectionSupervisor.js'
import { waitForDeviceReconnect } from '../src/modules/devices/deviceReconnect.js'
import { adaptDeviceSocket } from '../src/modules/devices/deviceWire.js'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceExtensionRegistration } from '../src/modules/devices/deviceApplicationChannel.js'

class Socket extends EventEmitter {
  bufferedAmount = 0
  peer?: Socket
  closed = false
  send(text: string) {
    queueMicrotask(() => {
      if (!this.closed && !this.peer?.closed) this.peer?.emit('message', text, false)
    })
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
    this.peer?.close()
  }
}

const identity = {
  mainId: '11111111-1111-4111-8111-111111111111', deviceId: '22222222-2222-4222-8222-222222222222',
  workerInstallationId: '33333333-3333-4333-8333-333333333333', keyRevision: 1, authorizationRevision: 1,
  bootId: '44444444-4444-4444-8444-444444444444',
}
const keys = generateKeyPairSync('ed25519')
const mainPublicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const fingerprint = createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
const flush = async () => { for (let index = 0; index < 160; index++) await Promise.resolve() }

function fixture(reconcile: (binding: DeviceSessionBinding, signal: AbortSignal) => Promise<void>,
  workerReconcile: (binding: DeviceSessionBinding, signal: AbortSignal) => Promise<void> = async () => {},
  extensions: DeviceExtensionRegistration[] = []) {
  const presence = vi.fn()
  const sockets: Socket[] = []
  const connectedAt: number[] = []
  const endpoint = new DeviceEndpoint({
    mainId: identity.mainId, appVersion: 'build', heartbeatMs: 3000,
    auth: { authenticateDevice: async () => ({ ...identity, audience: 'graphql-worker', expiresAt: '2099-01-01T00:00:00Z' }),
      revalidateDevice: async () => {} },
    signMainIdentityProof: async request => ({ request, mainApplicationVersion: 'build', mainPublicKey,
      mainPublicKeyFingerprint: fingerprint,
      signature: sign(null, Buffer.from(mainIdentityProofMessage(request, 'build')), keys.privateKey).toString('base64url') }),
    reconcile, presence, extensions,
  })
  const worker = new DeviceConnectionSupervisor({
    identity, appVersion: 'build', mainPublicKeyFingerprint: fingerprint, heartbeatMs: 1000,
    random: () => 0.5, reconcile: workerReconcile, extensions,
    connect: async () => {
      connectedAt.push(Date.now())
      const main = new Socket()
      const remote = new Socket()
      main.peer = remote
      remote.peer = main
      sockets.push(remote)
      const transport = adaptDeviceSocket(remote)
      void endpoint.accept({ authorization: 'Bearer device' }, adaptDeviceSocket(main))
      return transport
    },
  })
  return { endpoint, worker, presence, sockets, connectedAt,
    close: async () => {
      endpoint.close()
      await worker.stop()
      await endpoint.join()
    } }
}

afterEach(() => vi.useRealTimers())

it('keeps copy authorization capacity through the signed Endpoint–Supervisor handshake', async () => {
  const extensions: DeviceExtensionRegistration[] = [{ namespace: 'execution-v1', version: 1,
    role: 'duplex', maxJsonBytes: 2048, maxBinaryBytes: 0, handle: async payload => ({ payload }) }]
  const f = fixture(async () => {}, async () => {}, extensions)
  try {
    f.worker.start()
    await vi.waitFor(() => expect(f.worker.status().phase).toBe('ready'))
    await vi.waitFor(() => expect(f.endpoint.currentBinding(identity.deviceId, 'execution-v1')).toBeDefined())
    const negotiated = f.worker.capabilities()
    expect(negotiated).toContainEqual(expect.objectContaining({ namespace: 'execution-v1',
      callbackAdmission: true, observationAdmission: true, mainCanRequest: true, workerCanRequest: true }))
    expect(f.endpoint.capabilities(identity.deviceId)).toEqual(negotiated)
    await expect(f.endpoint.request(identity.deviceId, 'execution-v1', { direction: 'to-worker' }))
      .resolves.toEqual({ payload: { direction: 'to-worker' } })
    await expect(f.worker.request('execution-v1', { direction: 'to-main' }))
      .resolves.toEqual({ payload: { direction: 'to-main' } })
    expect(f.connectedAt).toHaveLength(1)
  } finally { await f.close() }
})

it('negotiates signed execution callback admission advertised by both peers', async () => {
  const f = fixture(async () => {}, async () => {}, [{ namespace: 'execution-v1', version: 1,
    role: 'duplex', maxJsonBytes: 4096, maxBinaryBytes: 0,
    handle: async payload => ({ payload: { received: payload } }),
  }])
  try {
    f.worker.start()
    await vi.waitFor(() => expect(f.worker.status().phase).toBe('ready'), { timeout: 2000, interval: 10 })
    expect(f.endpoint.capabilities(identity.deviceId)).toEqual([expect.objectContaining({
      namespace: 'execution-v1', mainCanRequest: true, workerCanRequest: true, callbackAdmission: true,
    })])
    const reply = await f.endpoint.request(identity.deviceId, 'execution-v1', { operation: 'probe' })
    expect(reply.payload).toEqual({ received: { operation: 'probe' } })
  } finally { await f.close() }
})

it.each(['main', 'worker'] as const)('allows application reconciliation on %s to outlast the handshake deadline', async side => {
  vi.useFakeTimers()
  let release!: () => void
  const reconciliation = new Promise<void>(resolve => { release = resolve })
  const slow = vi.fn(() => reconciliation)
  const f = fixture(side === 'main' ? slow : async () => {}, side === 'worker' ? slow : async () => {})
  try {
    f.worker.start()
    await flush()
    expect(slow).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(11_000)
    expect(f.sockets[0]!.closed).toBe(false)
    release()
    await flush()
    expect(f.worker.status().phase).toBe('ready')
    expect(f.presence.mock.calls.at(-1)?.[0].phase).toBe('ready')
    expect(f.connectedAt).toHaveLength(1)
  } finally { release(); await f.close() }
})

it('keeps same-boot reconnect waiting through both application reconciliation phases', async () => {
  vi.useFakeTimers()
  let releaseMain!: () => void
  let releaseWorker!: () => void
  const mainReconciliation = new Promise<void>(resolve => { releaseMain = resolve })
  const workerReconciliation = new Promise<void>(resolve => { releaseWorker = resolve })
  const f = fixture(() => mainReconciliation, () => workerReconciliation)
  let restored: DeviceSessionBinding | undefined
  try {
    const waiting = waitForDeviceReconnect({ original: identity, failure: new Error('link lost'),
      live: () => restored }).catch((error: unknown) => error)
    f.worker.start()
    await flush()
    await vi.advanceTimersByTimeAsync(90_000)
    releaseWorker()
    await flush()
    await vi.advanceTimersByTimeAsync(90_000)
    releaseMain()
    await flush()
    expect(f.sockets[0]!.closed).toBe(false)
    expect(f.presence.mock.calls.at(-1)?.[0].phase).toBe('ready')
    restored = f.endpoint.currentBinding(identity.deviceId)
    await vi.advanceTimersByTimeAsync(250)
    expect(await waiting).toEqual(restored)
  } finally { releaseMain(); releaseWorker(); await f.close() }
})

it('retains a bounded application reconciliation deadline and aborts unfinished work', async () => {
  vi.useFakeTimers()
  let release!: () => void
  let signal: AbortSignal | undefined
  const reconciliation = new Promise<void>(resolve => { release = resolve })
  const f = fixture(async (_binding, active) => { signal = active; await reconciliation })
  try {
    f.worker.start()
    await flush()
    await vi.advanceTimersByTimeAsync(119_999)
    expect(f.sockets[0]!.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.sockets[0]!.closed).toBe(true)
    expect(signal?.aborted).toBe(true)
  } finally { release(); await f.close() }
})

it('increases backoff across ready attempts rejected by Main and resets after sustained health', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const reconcile = vi.fn(async () => {
    if (reconcile.mock.calls.length <= 2) throw new Error('Inventory read unavailable')
  })
  const f = fixture(reconcile)
  try {
    f.worker.start()
    await flush()
    expect(f.worker.status().phase).toBe('backoff')
    expect(f.connectedAt).toEqual([0])
    await vi.advanceTimersByTimeAsync(500)
    expect(f.worker.status().phase).toBe('backoff')
    expect(f.connectedAt).toEqual([0, 500])
    await vi.advanceTimersByTimeAsync(999)
    expect(f.connectedAt).toEqual([0, 500])
    await vi.advanceTimersByTimeAsync(1)
    expect(f.connectedAt).toEqual([0, 500, 1500])
    expect(f.worker.status().phase).toBe('ready')
    await vi.advanceTimersByTimeAsync(60_000)
    f.sockets.at(-1)!.close()
    await flush()
    await vi.advanceTimersByTimeAsync(499)
    expect(f.connectedAt).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.connectedAt).toEqual([0, 500, 1500, 62_000])
  } finally { await f.close() }
})

it('increases backoff when Main repeatedly rejects reconciliation after ninety seconds', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const refusals: Array<() => void> = []
  const f = fixture(() => new Promise<void>((_resolve, reject) => {
    refusals.push(() => reject(new Error('Inventory read unavailable')))
  }))
  try {
    f.worker.start()
    await flush()
    await vi.advanceTimersByTimeAsync(90_000)
    refusals[0]!()
    await flush()
    expect(f.worker.status().phase).toBe('backoff')
    await vi.advanceTimersByTimeAsync(500)
    expect(f.connectedAt).toEqual([0, 90_500])
    await vi.advanceTimersByTimeAsync(90_000)
    refusals[1]!()
    await flush()
    expect(f.presence.mock.calls.some(([view]) => view.phase === 'ready')).toBe(false)
    expect(f.worker.status().phase).toBe('backoff')
    await vi.advanceTimersByTimeAsync(999)
    expect(f.connectedAt).toEqual([0, 90_500])
    await vi.advanceTimersByTimeAsync(1)
    expect(f.connectedAt).toEqual([0, 90_500, 181_500])
  } finally {
    for (const refuse of refusals) refuse()
    await f.close()
  }
})

it('counts healthy time from Main finishing delayed reconciliation', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  let release!: () => void
  const reconciliation = new Promise<void>(resolve => { release = resolve })
  let attempts = 0
  const f = fixture(async () => {
    attempts++
    if (attempts <= 2) throw new Error('Inventory read unavailable')
    await reconciliation
  })
  try {
    f.worker.start()
    await flush()
    await vi.advanceTimersByTimeAsync(1500)
    expect(f.connectedAt).toEqual([0, 500, 1500])
    await vi.advanceTimersByTimeAsync(90_000)
    release()
    await flush()
    expect(f.presence.mock.calls.at(-1)?.[0].phase).toBe('ready')
    await vi.advanceTimersByTimeAsync(59_999)
    f.sockets.at(-1)!.close()
    await flush()
    await vi.advanceTimersByTimeAsync(1999)
    expect(f.connectedAt).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.connectedAt).toEqual([0, 500, 1500, 153_499])
    await vi.advanceTimersByTimeAsync(60_000)
    f.sockets.at(-1)!.close()
    await flush()
    await vi.advanceTimersByTimeAsync(499)
    expect(f.connectedAt).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.connectedAt).toEqual([0, 500, 1500, 153_499, 213_999])
  } finally { release(); await f.close() }
})
