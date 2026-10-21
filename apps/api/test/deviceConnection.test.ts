import type pg from 'pg'
import { DomainError } from '../src/modules/errors.js'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { ComputerGitHubService } from '../src/modules/computers/github.js'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { COMPUTER_GITHUB_NAMESPACE } from '@foreman-code/contracts/computer-accounts'
import { DevicePresenceSchema, type DevicePresence, type DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { deviceNegotiationHash, type DeviceExtensionRegistration } from '../src/modules/devices/deviceApplicationChannel.js'
import { generateKeyPairSync, createHash, sign } from 'node:crypto'
import { mainIdentityProofMessage } from '@foreman-code/contracts/device-identity-node'
import type { MainIdentityProofRequest, MainEnrollmentProofRequest } from '@foreman-code/contracts/device-identity'
import WebSocket, { WebSocketServer } from 'ws'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { EventEmitter } from 'node:events'
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { signMainEnrollmentProof } from '../src/modules/devices/mainIdentity.js'
import { deviceHttpHandler } from '../src/modules/devices/deviceHttp.js'
import { DeviceEndpoint, type AuthenticatedDevice } from '../src/modules/devices/deviceEndpoint.js'
import { DeviceConnectionSupervisor } from '../src/modules/devices/connectionSupervisor.js'
import { deviceConnector, deviceUpgradeHandler } from '../src/modules/devices/deviceCarrier.js'
import { adaptDeviceSocket, DeviceConnectionError, readFrame, sendFrame } from '../src/modules/devices/deviceWire.js'

class Socket extends EventEmitter {
  bufferedAmount = 0
  sent: Record<string, unknown>[] = []
  closed = false
  send(text: string) { this.sent.push(JSON.parse(text)) }
  close() { if (this.closed) return; this.closed = true; this.emit('close') }
  frame(value: unknown) { this.emit('message', JSON.stringify(value), false) }
}
class LinkedSocket extends Socket {
  peer?: LinkedSocket
  override send(text: string) {
    super.send(text)
    this.peer?.emit('message', text, false)
  }
  override close() {
    if (this.closed) return
    super.close()
    this.peer?.close()
  }
}
const identity = { mainId: '11111111-1111-4111-8111-111111111111', deviceId: '22222222-2222-4222-8222-222222222222', workerInstallationId: '33333333-3333-4333-8333-333333333333', keyRevision: 1, authorizationRevision: 1, bootId: '44444444-4444-4444-8444-444444444444' }
const mainKeys = generateKeyPairSync('ed25519')
const mainPublicKey = mainKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const fingerprint = createHash('sha256').update(mainKeys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
const proof = async (request: MainIdentityProofRequest) => ({ request, mainApplicationVersion: 'build', mainPublicKey, mainPublicKeyFingerprint: fingerprint, signature: sign(null, Buffer.from(mainIdentityProofMessage(request, 'build')), mainKeys.privateKey).toString('base64url') })
const principal: AuthenticatedDevice = { ...identity, audience: 'graphql-worker', expiresAt: '2099-01-01T00:00:00Z' }
const hello = { ...identity, connectionEpoch: '55555555-5555-4555-8555-555555555555', type: 'hello', protocolVersion: 1, appVersion: 'build', nonce: Buffer.alloc(32).toString('base64url'), connectionGeneration: 1 }
const welcome = { ...hello, type: 'welcome', connectionEpoch: '66666666-6666-4666-8666-666666666666', capabilities: { heartbeat: true, dispatch: false, transfer: false } }
const signedWelcome = async (sent: Record<string, unknown>, epoch = welcome.connectionEpoch) => ({ ...welcome, connectionEpoch: epoch, connectionGeneration: sent.connectionGeneration, mainIdentityProof: await proof({ audience: 'graphql-worker-main-v1', ...identity, nonce: sent.nonce as string, connectionGeneration: sent.connectionGeneration as number, connectionEpoch: sent.connectionEpoch as string, mainConnectionEpoch: epoch, protocolVersion: 1, workerApplicationVersion: 'build', negotiationHash: deviceNegotiationHash([]) }) })
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve() }
const makeEndpoint = (extensions?: DeviceExtensionRegistration[], handshakeMs = 100, reconcile: (binding: DeviceSessionBinding, signal: AbortSignal) => Promise<void> = async () => {}) => {
  const presence = vi.fn()
  const auth = { authenticateDevice: vi.fn(async () => principal), revalidateDevice: vi.fn(async () => {}) }
  const endpoint = new DeviceEndpoint({ mainId: identity.mainId, appVersion: 'build', signMainIdentityProof: proof, auth, reconcile, presence, handshakeMs, heartbeatMs: 100, ...(extensions ? { extensions } : {}) })
  return { endpoint, auth, presence }
}
afterEach(() => { vi.useRealTimers() })
describe('device-only carrier and lifecycle', () => {
  it.each([{ cookie: 'owner=session' }, { origin: 'https://browser' }, {}])('rejects cookie/browser/missing device authentication %j', async (headers) => {
    const { endpoint, auth } = makeEndpoint(); const socket = new Socket()
    await endpoint.accept(headers, adaptDeviceSocket(socket)); expect(auth.authenticateDevice).not.toHaveBeenCalled(); expect(socket.closed).toBe(true)
  })
  it('negotiates authenticated heartbeat only, then live revocation fences session', async () => {
    const { endpoint, auth, presence } = makeEndpoint(); const socket = new Socket()
    const task = endpoint.accept({ authorization: 'Bearer device-secret' }, adaptDeviceSocket(socket))
    socket.frame(hello); await flush()
    expect(socket.sent[0]).toMatchObject({ type: 'welcome', capabilities: { dispatch: false, transfer: false } })
    socket.frame({ type: 'ready', connectionEpoch: socket.sent[0]!.connectionEpoch }); await flush()
    socket.frame({ type: 'ping', connectionEpoch: socket.sent[0]!.connectionEpoch }); await flush()
    expect(socket.sent[1]!.type).toBe('pong'); expect(auth.revalidateDevice).toHaveBeenCalledTimes(3)
    endpoint.revoke(identity.deviceId, 2); await task
    expect(presence.mock.calls.map(([view]) => view.phase).filter((phase, index, phases) => index === 0 || phase !== phases[index - 1])).toEqual(['ready', 'offline'])
  })
  it.each([undefined, 0, 2])('blocks absent/old/new wire protocol %s', async (version) => {
    const { endpoint, presence } = makeEndpoint(); const socket = new Socket()
    const task = endpoint.accept({ authorization: 'Bearer secret' }, adaptDeviceSocket(socket)); socket.frame({ ...hello, protocolVersion: version }); await task
    expect(socket.sent[0]).toEqual({ type: 'blocked', code: 'incompatible-protocol' }); expect(presence).not.toHaveBeenCalled()
  })
  it('blocks the wrong main and expired or revoked credentials', async () => {
    for (const code of ['wrong_main', 'expired', 'revoked'] as const) {
      const { endpoint, auth } = makeEndpoint(); auth.authenticateDevice.mockRejectedValueOnce({ code }); const socket = new Socket()
      await endpoint.accept({ authorization: 'Bearer secret' }, adaptDeviceSocket(socket))
      const expected = { wrong_main: 'wrong-main', expired: 'authentication', revoked: 'revoked' }[code]
      expect(socket.sent[0]!.code).toBe(expected)
    }
  })
  it('replacement fences old presence and handlers', async () => {
    const { endpoint, presence } = makeEndpoint(); const a = new Socket(); const b = new Socket()
    const old = endpoint.accept({ authorization: 'Bearer secret' }, adaptDeviceSocket(a)); a.frame(hello); await flush(); a.frame({ type: 'ready', connectionEpoch: a.sent[0]!.connectionEpoch }); await flush()
    const fresh = endpoint.accept({ authorization: 'Bearer secret' }, adaptDeviceSocket(b)); b.frame({ ...hello, bootId: '77777777-7777-4777-8777-777777777777' }); await flush(); b.frame({ type: 'ready', connectionEpoch: b.sent[0]!.connectionEpoch }); await flush(); await old
    expect(presence.mock.calls.map(([view]) => view.phase)).toEqual(['ready', 'offline', 'ready'])
    expect(b.sent[0]!.connectionEpoch).not.toBe(a.sent[0]!.connectionEpoch)
    endpoint.close(); await fresh; expect(presence.mock.calls.at(-1)![0].phase).toBe('offline')
  })
  it('main shutdown cancels pending authentication without late presence', async () => {
    const { endpoint, auth, presence } = makeEndpoint(); let resolve!: (value: AuthenticatedDevice) => void
    auth.authenticateDevice.mockReturnValueOnce(new Promise((done) => { resolve = done }))
    const socket = new Socket(); const task = endpoint.accept({ authorization: 'Bearer secret' }, adaptDeviceSocket(socket)); endpoint.close(); await task
    let joined = false; const drain = endpoint.join().then(() => { joined = true }); await flush(); expect(joined).toBe(false)
    resolve(principal); await drain; expect(joined).toBe(true); await flush()
    expect(presence).not.toHaveBeenCalled(); expect(socket.closed).toBe(true)
  })
  it('revocation fences an authentication result that completes after revoke committed', async () => {
    const { endpoint, auth, presence } = makeEndpoint(); let resolve!: (value: AuthenticatedDevice) => void
    auth.authenticateDevice.mockReturnValueOnce(new Promise((done) => { resolve = done }))
    const socket = new Socket(); const task = endpoint.accept({ authorization: 'Bearer secret' }, adaptDeviceSocket(socket))
    endpoint.revoke(identity.deviceId, 2); resolve(principal); await task
    expect(presence).not.toHaveBeenCalled(); expect(socket.sent[0]).toEqual({ type: 'blocked', code: 'revoked' })
  })
  it('retains a classified blocked failure when peer closes immediately after its frame', async () => {
    const raw = new Socket(), adapted = adaptDeviceSocket(raw)
    raw.frame({ type: 'blocked', code: 'incompatible-protocol' }); raw.close()
    await expect(adapted.messages[Symbol.asyncIterator]().next()).rejects.toThrow('incompatible-protocol')
  })
  it('retains the handshake admission bound until cancelled physical auth queries settle', async () => {
    vi.useFakeTimers(); const { endpoint, auth } = makeEndpoint(), releases: Array<(value: AuthenticatedDevice) => void> = []
    auth.authenticateDevice.mockImplementation(() => new Promise((resolve) => { releases.push(resolve) }))
    const pending = Array.from({ length: 32 }, () => endpoint.authenticate({ authorization: 'Bearer device' })); for (const task of pending) void task.catch(() => { /* ignore: each rejection is asserted below through allSettled */ })
    await vi.advanceTimersByTimeAsync(101); await Promise.allSettled(pending)
    await expect(endpoint.authenticate({ authorization: 'Bearer device' })).rejects.toThrow('backpressure'); expect(auth.authenticateDevice).toHaveBeenCalledTimes(32)
    endpoint.close(); let joined = false; const drain = endpoint.join().then(() => { joined = true }); await flush(); expect(joined).toBe(false)
    for (const release of releases) release(principal); await drain; expect(joined).toBe(true); expect(vi.getTimerCount()).toBe(0)
  })
  it('joins a physical reconciliation callback even after its handshake wrapper is cancelled', async () => {
    let finish!: () => void; let entered = false
    const { endpoint, presence } = makeEndpoint(undefined, 100, async () => { entered = true; await new Promise<void>((resolve) => { finish = resolve }) })
    const raw = new Socket(), task = endpoint.accept({ authorization: 'Bearer device' }, adaptDeviceSocket(raw))
    raw.frame(hello); await flush(); raw.frame({ type: 'ready', connectionEpoch: raw.sent[0]!.connectionEpoch }); await flush(); expect(entered).toBe(true)
    expect(endpoint.currentBinding(identity.deviceId)).toMatchObject(identity); expect(endpoint.currentBinding(identity.deviceId, 'execution-v1')).toBeUndefined()
    endpoint.close(); await task
    let joined = false; const drain = endpoint.join().then(() => { joined = true }); await flush(); expect(joined).toBe(false)
    finish(); await drain; expect(joined).toBe(true); expect(endpoint.currentBinding(identity.deviceId)).toBeUndefined()
    expect(presence.mock.calls.some(([view]) => view.phase === 'ready')).toBe(false)
  })
  it('publishes actual worker versions and frame times without advancing lastSeenAt on database auth reads', async () => {
    vi.useFakeTimers()
    const firstTime = new Date('2026-10-01T06:00:00.000Z')
    vi.setSystemTime(firstTime)
    const registration: DeviceExtensionRegistration = { namespace: 'probe-v1', version: 1, role: 'client', maxJsonBytes: 1024, maxBinaryBytes: 0 }
    const { endpoint, presence, auth } = makeEndpoint([registration])
    const raw = new Socket()
    const task = endpoint.accept({ authorization: 'Bearer device' }, adaptDeviceSocket(raw))
    try {
      raw.frame({ ...hello, appVersion: 'worker-observed-42', extensions: [{ ...registration, role: 'server' }] })
      await flush()
      const epoch = raw.sent[0]!.connectionEpoch
      raw.frame({ type: 'ready', connectionEpoch: epoch })
      await flush()
      const original = DevicePresenceSchema.parse(presence.mock.calls.at(-1)![0])
      expect(original).toMatchObject({ appVersion: 'worker-observed-42', protocolVersion: 1,
        lastSeenAt: firstTime.toISOString() })
      expect(auth.revalidateDevice).toHaveBeenCalledTimes(2)

      vi.setSystemTime(firstTime.getTime() + 50)
      const recent = new AbortController()
      const recentRequest = endpoint.request(identity.deviceId, 'probe-v1', {}, { signal: recent.signal })
      const cancelledRecent = expect(recentRequest).rejects.toMatchObject({ code: 'cancelled' })
      await flush()
      expect(auth.revalidateDevice).toHaveBeenCalledTimes(2)
      expect(raw.sent.filter(frame => frame.type === 'application-open')).toHaveLength(1)
      expect(presence.mock.calls.at(-1)![0].lastSeenAt).toBe(original.lastSeenAt)
      recent.abort()
      await cancelledRecent

      // Move the clock without delivering heartbeats, so request authorization has to refresh.
      const secondTime = new Date(firstTime.getTime() + 120_001)
      vi.setSystemTime(secondTime)
      const stale = new AbortController()
      const staleRequest = endpoint.request(identity.deviceId, 'probe-v1', {}, { signal: stale.signal })
      const cancelledStale = expect(staleRequest).rejects.toMatchObject({ code: 'cancelled' })
      await flush()
      expect(auth.revalidateDevice).toHaveBeenCalledTimes(3)
      expect(raw.sent.filter(frame => frame.type === 'application-open')).toHaveLength(2)
      expect(presence.mock.calls.at(-1)![0].lastSeenAt).toBe(original.lastSeenAt)
      stale.abort()
      await cancelledStale

      raw.frame({ type: 'ping', connectionEpoch: epoch })
      await flush()
      expect(DevicePresenceSchema.parse(presence.mock.calls.at(-1)![0]).lastSeenAt).toBe(secondTime.toISOString())
      endpoint.close()
      await task
      await endpoint.join()
      expect(presence.mock.calls.at(-1)![0]).toMatchObject({ phase: 'offline', lastSeenAt: secondTime.toISOString() })
    } finally {
      endpoint.close()
      await task
      await endpoint.join()
    }
  })
  it('half-open heartbeat expires within declared deadline', async () => {
    vi.useFakeTimers(); const { endpoint, presence } = makeEndpoint(); const socket = new Socket()
    const task = endpoint.accept({ authorization: 'Bearer secret' }, adaptDeviceSocket(socket)); socket.frame(hello); await flush(); socket.frame({ type: 'ready', connectionEpoch: socket.sent[0]!.connectionEpoch }); await flush(); await vi.advanceTimersByTimeAsync(101); await task
    expect(socket.closed).toBe(true); expect(presence.mock.calls.at(-1)![0].phase).toBe('offline')
  })
  it.each([-120001, 120001])('reads authenticated Worker clock skew %s and clears it after synchronization', async offset => {
    vi.useFakeTimers()
    const mainTime = new Date('2026-10-09T12:00:00.000Z')
    vi.setSystemTime(mainTime)
    const { endpoint, presence } = makeEndpoint()
    const socket = new Socket()
    const task = endpoint.accept({ authorization: 'Bearer device' }, adaptDeviceSocket(socket))
    socket.frame({ ...hello, observedAt: new Date(mainTime.getTime() + offset).toISOString() })
    await flush()
    const epoch = socket.sent[0]!.connectionEpoch
    expect(socket.sent[0]!.observedAt).toBe(mainTime.toISOString())
    socket.frame({ type: 'ready', connectionEpoch: epoch })
    await flush()
    expect(endpoint.clockReason(identity.deviceId)).toContain('more than 2 minutes')
    expect(DevicePresenceSchema.parse(presence.mock.calls.at(-1)![0]).clockSkewMs).toBe(offset)
    socket.frame({ type: 'ping', connectionEpoch: epoch, observedAt: mainTime.toISOString() })
    await flush()
    expect(endpoint.clockReason(identity.deviceId)).toBeNull()
    expect(DevicePresenceSchema.parse(presence.mock.calls.at(-1)![0])).toMatchObject({
      clockSkewMs: 0, clockReason: null,
    })
    endpoint.close()
    await task
  })
  it('rejects malformed/oversize messages and bounded slow-reader queue', async () => {
    expect(() => readFrame('{')).toThrow('malformed-frame'); expect(() => readFrame(' '.repeat(16_385))).toThrow('malformed-frame')
    const raw = new Socket(); const adapted = adaptDeviceSocket(raw)
    for (let i = 0; i < 33; i++) raw.frame(hello)
    await expect(adapted.messages[Symbol.asyncIterator]().next()).rejects.toThrow('backpressure'); expect(raw.closed).toBe(true)
    const slow = new Socket(); slow.bufferedAmount = 65_536
    expect(() => sendFrame(adaptDeviceSocket(slow), { type: 'ping', connectionEpoch: 'epoch' })).toThrow('backpressure'); slow.close()
  })
  it('supervisor rejects wrong-main, backs off and separates stopped state', async () => {
    vi.useFakeTimers()
    const socket = new Socket(); const connect = vi.fn(async () => adaptDeviceSocket(socket))
    const supervisor = new DeviceConnectionSupervisor({ identity, appVersion: 'build', mainPublicKeyFingerprint: fingerprint, connect, reconcile: async () => {} })
    supervisor.start(); await flush(); socket.frame({ ...welcome, mainId: 'different' }); await flush()
    expect(supervisor.status()).toMatchObject({ desired: true, phase: 'backoff', failure: 'wrong-main' })
    expect(connect).toHaveBeenCalledTimes(1)
    expect(socket.closed).toBe(true)
    expect(supervisor.currentBinding()).toBeUndefined()
    await supervisor.stop(); expect(supervisor.status()).toMatchObject({ desired: false, phase: 'disconnected' })
  })
  it.each(['missing', 'nonce', 'boot', 'generation', 'epoch', 'auth', 'key', 'signature', 'fingerprint', 'negotiation', 'negotiation-removed'])('blocks tampered or absent selected-main proof: %s', async (field) => {
    const socket = new Socket(); const reconcile = vi.fn(async () => {})
    const supervisor = new DeviceConnectionSupervisor({ identity, appVersion: 'build', mainPublicKeyFingerprint: fingerprint, connect: async () => adaptDeviceSocket(socket), reconcile })
    supervisor.start(); await flush()
    const response = await signedWelcome(socket.sent[0]!)
    const altered = response as unknown as { mainIdentityProof?: { request: Record<string, unknown>; signature: string; mainPublicKeyFingerprint: string } }
    if (field === 'missing') delete altered.mainIdentityProof
    else if (field === 'negotiation') altered.mainIdentityProof!.request.negotiationHash = 'a'.repeat(64)
    else if (field === 'negotiation-removed') delete altered.mainIdentityProof!.request.negotiationHash
    else if (field === 'signature') altered.mainIdentityProof!.signature = 'A'.repeat(86)
    else if (field === 'fingerprint') altered.mainIdentityProof!.mainPublicKeyFingerprint = 'a'.repeat(64)
    else { const key = { nonce: 'nonce', boot: 'bootId', generation: 'connectionGeneration', epoch: 'mainConnectionEpoch', auth: 'authorizationRevision', key: 'keyRevision' }[field]!; altered.mainIdentityProof!.request[key] = field === 'nonce' ? 'a'.repeat(43) : field === 'boot' || field === 'epoch' ? '99999999-9999-4999-8999-999999999999' : 99 }
    socket.frame(response); await flush()
    expect(supervisor.status()).toMatchObject({ phase: 'backoff', failure: 'wrong-main' })
    expect(socket.closed).toBe(true)
    expect(supervisor.currentBinding()).toBeUndefined()
    expect(reconcile).not.toHaveBeenCalled(); await supervisor.stop()
  })
  it('cancellation during open closes late sockets and leaves no timers', async () => {
    vi.useFakeTimers(); let resolve!: (value: ReturnType<typeof adaptDeviceSocket>) => void
    const supervisor = new DeviceConnectionSupervisor({ identity, appVersion: 'build', mainPublicKeyFingerprint: fingerprint, connect: () => new Promise((done) => { resolve = done }), reconcile: async () => {} })
    supervisor.start(); await supervisor.stop(); const socket = new Socket(); resolve(adaptDeviceSocket(socket)); await flush()
    expect(socket.closed).toBe(true); expect(vi.getTimerCount()).toBe(0)
  })
  it('transient reconnect gets a fresh generation and reconciles before ready', async () => {
    vi.useFakeTimers(); const sockets: Socket[] = []; const reconcile = vi.fn(async () => {})
    const supervisor = new DeviceConnectionSupervisor({ identity, appVersion: 'build', mainPublicKeyFingerprint: fingerprint, random: () => 0.5, heartbeatMs: 100, connect: async () => { const raw = new Socket(); sockets.push(raw); return adaptDeviceSocket(raw) }, reconcile })
    supervisor.start(); await flush(); sockets[0]!.frame(await signedWelcome(sockets[0]!.sent[0]!)); await flush(); expect(supervisor.status().phase).toBe('ready')
    sockets[0]!.close(); await vi.advanceTimersByTimeAsync(601); await flush(); sockets[1]!.frame(await signedWelcome(sockets[1]!.sent[0]!, '88888888-8888-4888-8888-888888888888')); await flush()
    expect(supervisor.status()).toMatchObject({ phase: 'ready', generation: 2 }); expect(reconcile).toHaveBeenCalledTimes(2)
    await supervisor.stop(); expect(vi.getTimerCount()).toBe(0)
  })
  it('reconnects to restarted Main through authentication and TLS rejection without restarting Worker', async () => {
    vi.useFakeTimers()
    const extension: DeviceExtensionRegistration = { namespace: 'probe-v1', version: 1, role: 'server',
      maxJsonBytes: 1024, maxBinaryBytes: 0, handle: async payload => ({ payload }) }
    let main = makeEndpoint([extension], 10_000)
    let registration = identity
    let rejectTls = false
    const refresh = vi.fn(async () => ({ identity: registration, mainPublicKeyFingerprint: fingerprint }))
    const connect = vi.fn(async () => {
      if (rejectTls) {
        rejectTls = false
        throw new DeviceConnectionError('wrong-main')
      }
      const workerSocket = new LinkedSocket()
      const mainSocket = new LinkedSocket()
      workerSocket.peer = mainSocket
      mainSocket.peer = workerSocket
      const workerTransport = adaptDeviceSocket(workerSocket)
      void main.endpoint.accept({ authorization: 'Bearer device' }, adaptDeviceSocket(mainSocket))
      return workerTransport
    })
    const worker = new DeviceConnectionSupervisor({ identity, appVersion: 'build',
      mainPublicKeyFingerprint: fingerprint, refresh, connect, random: () => 0.5,
      heartbeatMs: 100, reconcile: async () => {}, extensions: [{ ...extension, role: 'client' }] })
    try {
      worker.start()
      await flush()
      expect(worker.status().phase).toBe('ready')
      expect(main.presence.mock.calls.at(-1)![0].phase).toBe('ready')
      const before = worker.currentBinding()!
      main.endpoint.close()
      await main.endpoint.join()
      await flush()
      expect(worker.status()).toMatchObject({ phase: 'backoff', failure: 'transport' })
      main = makeEndpoint([extension], 10_000)
      registration = { ...identity, authorizationRevision: 2 }
      main.auth.authenticateDevice.mockRejectedValueOnce({ code: 'unauthorized' })
      main.auth.authenticateDevice.mockResolvedValue({ ...principal, ...registration })
      await vi.advanceTimersByTimeAsync(500)
      await flush()
      expect(worker.status()).toMatchObject({ phase: 'backoff', failure: 'authentication' })
      rejectTls = true
      await vi.advanceTimersByTimeAsync(1000)
      expect(worker.status()).toMatchObject({ phase: 'backoff', failure: 'wrong-main' })
      await vi.advanceTimersByTimeAsync(2000)
      await flush()
      expect(worker.status()).toMatchObject({ phase: 'ready', generation: 4 })
      expect(refresh).toHaveBeenCalledTimes(4)
      expect(worker.currentBinding()).toMatchObject({ bootId: before.bootId, authorizationRevision: 2 })
      expect(worker.currentBinding()!.connectionEpoch).not.toBe(before.connectionEpoch)
      expect(main.presence.mock.calls.at(-1)![0]).toMatchObject({ phase: 'ready',
        binding: { authorizationRevision: 2, bootId: before.bootId } })
      await expect(worker.request('probe-v1', { afterRestart: true }))
        .resolves.toEqual({ payload: { afterRestart: true } })
      main.endpoint.revoke(identity.deviceId, 3)
      await flush()
      expect(worker.status()).toMatchObject({ phase: 'blocked', failure: 'revoked' })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(connect).toHaveBeenCalledTimes(4)
    } finally {
      await worker.stop()
      main.endpoint.close()
      await main.endpoint.join()
    }
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['authentication', 'permission', 'wrong-main', 'incompatible-protocol', 'malformed-frame'] as const)(
    'retries %s with bounded backoff and cancels retries on stop', async code => {
      vi.useFakeTimers()
      const connect = vi.fn(async () => { throw new DeviceConnectionError(code) })
      const worker = new DeviceConnectionSupervisor({ identity, appVersion: 'build',
        mainPublicKeyFingerprint: fingerprint, connect, reconcile: async () => {}, random: () => 0.5 })
      try {
        worker.start()
        await flush()
        for (const delay of [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
          const attempts = connect.mock.calls.length
          expect(worker.status()).toMatchObject({ phase: 'backoff', failure: code })
          expect(worker.currentBinding()).toBeUndefined()
          await vi.advanceTimersByTimeAsync(delay - 1)
          expect(connect).toHaveBeenCalledTimes(attempts)
          await vi.advanceTimersByTimeAsync(1)
          expect(connect).toHaveBeenCalledTimes(attempts + 1)
        }
      } finally { await worker.stop() }
      await vi.advanceTimersByTimeAsync(60_000)
      expect(connect).toHaveBeenCalledTimes(9)
      expect(vi.getTimerCount()).toBe(0)
    })
  it('requires verified WSS and disables compression', async () => {
    expect(() => deviceConnector({ url: 'ws://main/device/connect', credential: 'secret', create: () => new Socket() })).toThrow('wrong-main')
    const socket = new Socket(); const create = vi.fn(() => socket); const connect = deviceConnector({ url: 'wss://main/device/connect', credential: 'secret', create })
    const abort = new AbortController(); const task = connect(abort.signal); socket.emit('open'); const adapted = await task
    expect(create.mock.calls[0]).toEqual(['wss://main/device/connect', expect.objectContaining({ rejectUnauthorized: true, perMessageDeflate: false, maxPayload: 16384 })]); adapted.close()
    expect(socket.listenerCount('message')).toBe(0)
    const rejectedSocket = new Socket()
    create.mockReturnValueOnce(rejectedSocket)
    const rejected = connect(new AbortController().signal)
    rejectedSocket.emit('error', { code: 'CERT_NOT_YET_VALID' })
    await expect(rejected).rejects.toThrow('wrong-main')
    expect(rejectedSocket.closed).toBe(true)
  })
  it.each([
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'wrong-main'],
    ['CERT_HAS_EXPIRED', 'wrong-main'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'wrong-main'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'wrong-main'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'wrong-main'],
    ['ECONNRESET', 'transport'],
  ])('classifies handshake error %s before synchronous socket close', async (code, failure) => {
    const socket = new Socket()
    const connect = deviceConnector({
      url: 'wss://main/device/connect', credential: 'secret', create: () => socket,
    })
    const connection = connect(new AbortController().signal)
    socket.emit('error', { code })
    await expect(connection).rejects.toMatchObject({ code: failure })
    expect(socket.closed).toBe(true)
    for (const event of ['open', 'message', 'error', 'close', 'unexpected-response']) {
      expect(socket.listenerCount(event)).toBe(0)
    }
  })
})


describe('pinned ws adapter on disposable loopback transport', () => {
  it('authenticates before upgrade and negotiates real bounded ws frames', async () => {
    const { endpoint, presence } = makeEndpoint()
    const server = createServer((_request, response) => { response.writeHead(404); response.end() })
    const carrier = new WebSocketServer({ noServer: true, maxPayload: 16384, perMessageDeflate: false })
    server.on('upgrade', deviceUpgradeHandler(endpoint, carrier))
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing loopback address')
    const client = new WebSocket(`ws://127.0.0.1:${address.port}/device/connect`, { headers: { Authorization: 'Bearer device' }, perMessageDeflate: false })
    try {
      await once(client, 'open')
      const welcomeMessage = once(client, 'message'); client.send(JSON.stringify(hello))
      const [received] = await welcomeMessage; const negotiated = JSON.parse(String(received))
      expect(negotiated).toMatchObject({ type: 'welcome', capabilities: { dispatch: false, transfer: false } })
      expect(client.extensions).toBe('')
      const mainReady = once(client, 'message')
      client.send(JSON.stringify({ type: 'ready', connectionEpoch: negotiated.connectionEpoch }))
      expect(JSON.parse(String((await mainReady)[0]))).toEqual({ type: 'pong',
        connectionEpoch: negotiated.connectionEpoch, observedAt: expect.any(String), mainReady: true })
      const pong = once(client, 'message'); client.send(JSON.stringify({ type: 'ping', connectionEpoch: negotiated.connectionEpoch }))
      expect(JSON.parse(String((await pong)[0]))).toEqual({ type: 'pong', connectionEpoch: negotiated.connectionEpoch,
        observedAt: expect.any(String) })
      const closed = once(client, 'close'); endpoint.revoke(identity.deviceId, 2); await closed
      await flush(); expect(presence.mock.calls.at(-1)![0].phase).toBe('offline')
    } finally {
      endpoint.close(); client.terminate(); carrier.close(); await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
  it.each([1, 17, 32])('negotiates %i signed duplex handlers and binds both request directions to the authenticated epoch', async (extensionCount) => {
    const mainHandler = vi.fn(async (payload: unknown) => ({ payload: { mainReceipt: payload } }))
    const mainExtension: DeviceExtensionRegistration = { namespace: 'execution-v1', version: 1, role: 'duplex', maxJsonBytes: 2048, maxBinaryBytes: 0, handle: mainHandler }
    let synchronizedReply: unknown
    const mainExtensions = Array.from({ length: extensionCount }, (_, index) => ({ ...mainExtension,
      namespace: index === 0 ? mainExtension.namespace : `additional-${index}-v1` }))
    const { endpoint, presence } = makeEndpoint(mainExtensions, 2000, async (_binding, signal) => {
      expect(endpoint.currentBinding(identity.deviceId)).toMatchObject(identity)
      expect(endpoint.currentBinding(identity.deviceId, 'execution-v1')).toBeUndefined(); expect(endpoint.captureRequest(identity.deviceId, 'execution-v1')).toBeUndefined()
      synchronizedReply = (await endpoint.request(identity.deviceId, 'execution-v1', { grant: 'exact-operation' }, { signal })).payload
      expect(presence.mock.calls.some(([view]) => view.phase === 'ready')).toBe(false)
    })
    const server = createServer(), carrier = new WebSocketServer({ noServer: true, maxPayload: 16384, perMessageDeflate: false })
    server.on('upgrade', deviceUpgradeHandler(endpoint, carrier)); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address')
    const workerHandler = vi.fn(async (payload: unknown, context: { binding: typeof identity & { connectionEpoch: string; connectionGeneration: number } }) => {
      if ((payload as { grant?: string }).grant !== 'exact-operation') throw { code: 'forbidden' }
      return { payload: { receipt: 'actual-handler', epoch: context.binding.connectionEpoch } }
    })
    const connect = deviceConnector({ url: 'wss://main/device/connect', credential: 'device', create: (_url, options) => new WebSocket(`ws://127.0.0.1:${address.port}/device/connect`, options) })
    const worker = new DeviceConnectionSupervisor({ identity, appVersion: 'build', mainPublicKeyFingerprint: fingerprint, connect, reconcile: async () => {}, heartbeatMs: 20, extensions: mainExtensions.map(extension => ({ ...extension, handle: workerHandler })) })
    try {
      worker.start(); await vi.waitFor(() => expect(worker.status().phase).toBe('ready'), { timeout: 2000, interval: 10 })
      await vi.waitFor(() => expect(endpoint.currentBinding(identity.deviceId, 'execution-v1')).toBeDefined())
      expect(endpoint.capabilities(identity.deviceId)).toHaveLength(extensionCount)
      expect(presence.mock.calls.at(-1)![0]).toMatchObject({ phase: 'ready', dispatch: true, transfer: false }); expect(synchronizedReply).toMatchObject({ receipt: 'actual-handler' })
      await expect(endpoint.request(identity.deviceId, 'execution-v1', { grant: 'heartbeat-only' })).rejects.toThrow('forbidden')
      const captured = endpoint.captureRequest(identity.deviceId, 'execution-v1')!
      expect(endpoint.currentBinding(identity.deviceId, 'execution-v1')).toEqual(captured.binding); expect(endpoint.currentBinding(identity.deviceId, 'unknown-v1')).toBeUndefined()
      endpoint.stopAdmission()
      await expect(endpoint.authenticate({ authorization: 'Bearer device' })).rejects.toThrow()
      expect(endpoint.currentBinding(identity.deviceId, 'execution-v1')).toEqual(captured.binding)
      await expect(endpoint.request(identity.deviceId, 'execution-v1', { grant: 'heartbeat-only' })).rejects.toThrow('forbidden')
      const response = await captured.request({ grant: 'exact-operation' })
      expect(response.payload).toMatchObject({ receipt: 'actual-handler' })
      const context = workerHandler.mock.calls.at(-1)![1]
      expect(context.binding).toMatchObject(identity); expect((response.payload as { epoch: string }).epoch).toBe(context.binding.connectionEpoch)
      expect(await worker.request('execution-v1', { report: 'accepted-job-only' })).toEqual({ payload: { mainReceipt: { report: 'accepted-job-only' } } })
      expect(mainHandler).toHaveBeenCalledOnce()
    } finally { await worker.stop(); endpoint.close(); await endpoint.join(); carrier.close(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  })
  it('maps definitive pre-upgrade revocation separately from authentication', async () => {
    const { endpoint, auth } = makeEndpoint(); auth.authenticateDevice.mockRejectedValue({ code: 'revoked' })
    const server = createServer(); const carrier = new WebSocketServer({ noServer: true, maxPayload: 16384, perMessageDeflate: false })
    server.on('upgrade', deviceUpgradeHandler(endpoint, carrier)); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address')
    // URL validation uses WSS; the injected constructor below uses disposable HTTP solely for this transport test.
    const connect = deviceConnector({ url: 'wss://main/device/connect', credential: 'revoked', create: (_url, options) => new WebSocket(`ws://127.0.0.1:${address.port}/device/connect`, options) })
    try { await expect(connect(new AbortController().signal)).rejects.toThrow('revoked') }
    finally { endpoint.close(); carrier.close(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  })
})


describe('device-only HTTP bootstrap', () => {
  it('returns selected-main descriptor and bounded signed pairing only', async () => {
    const pair = vi.fn(async () => ({ credential: 'device-only' }))
    const server = createServer(deviceHttpHandler({ mainId: identity.mainId, mainPublicKeyFingerprint: fingerprint, appVersion: 'build', pair, signMainEnrollmentProof: async (request: MainEnrollmentProofRequest) => signMainEnrollmentProof({ mainId: identity.mainId, publicKey: mainPublicKey, privateKey: mainKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKeyFingerprint: fingerprint }, request, 'build') }))
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address')
    const base = `http://127.0.0.1:${address.port}`
    try {
      const descriptor = await fetch(`${base}/device/identity`)
      expect(await descriptor.json()).toMatchObject({ mainId: identity.mainId, mainPublicKeyFingerprint: fingerprint, capabilities: { dispatch: false } })
      expect((await fetch(`${base}/device/identity`, { headers: { Cookie: 'owner=secret' } })).status).toBe(401)
      const input = { grant: Buffer.alloc(32).toString('base64url'), requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', mainId: identity.mainId, workerInstallationId: identity.workerInstallationId, publicKey: 'public', signature: 'A'.repeat(86) }
      const challengeRequest: MainEnrollmentProofRequest = { audience: 'graphql-worker-main-enrollment-v1', mainId: identity.mainId, workerInstallationId: identity.workerInstallationId, nonce: hello.nonce, protocolVersion: 1, workerApplicationVersion: 'build' }
      const challenge = await fetch(`${base}/device/challenge`, { method: 'POST', body: JSON.stringify(challengeRequest) })
      expect(challenge.status).toBe(200); expect(await challenge.json()).toMatchObject({ request: challengeRequest, mainPublicKeyFingerprint: fingerprint })
      const paired = await fetch(`${base}/device/pair`, { method: 'POST', body: JSON.stringify(input) })
      expect(paired.status).toBe(200); expect(pair).toHaveBeenCalledWith(input)
      expect((await fetch(`${base}/device/pair`, { method: 'POST', body: JSON.stringify({ ...input, mainId: '99999999-9999-4999-8999-999999999999' }) })).status).toBe(409)
      expect((await fetch(`${base}/device/pair`, { method: 'POST', body: '{' })).status).toBe(400)
      expect((await fetch(`${base}/management`, { method: 'POST' })).status).toBe(404)
      expect(pair).toHaveBeenCalledTimes(1)
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  })
})


it('refuses a GitHub mutation on a replacement authenticated installation after target validation', async () => {
  // Transport deadlines advance only when this test advances time, independent of runner scheduling.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  const withTransportProgress = async <T>(operation: Promise<T>): Promise<T> => {
    let settled = false
    void operation.then(
      () => { settled = true },
      () => { settled = true },
    )
    while (!settled) {
      await nextEventLoopTurn()
      // The HTTP adapter flushes responses on a zero-delay timer; device deadlines stay frozen.
      await vi.advanceTimersByTimeAsync(0)
    }
    return operation
  }
  const extension: DeviceExtensionRegistration = { namespace: COMPUTER_GITHUB_NAMESPACE, version: 1,
    role: 'client', maxJsonBytes: 2048, maxBinaryBytes: 0 }
  const { endpoint, auth, presence } = makeEndpoint([extension], 2000)
  const waitForReady = (installationId: string) => new Promise<void>(resolve => {
    presence.mockImplementation((view: DevicePresence) => {
      if (view.phase === 'ready' && view.binding.workerInstallationId === installationId) resolve()
    })
  })
  const server = createServer()
  const carrier = new WebSocketServer({ noServer: true, maxPayload: 16384, perMessageDeflate: false })
  server.on('upgrade', deviceUpgradeHandler(endpoint, carrier))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing address')
  const connect = deviceConnector({
    url: 'wss://main/device/connect',
    credential: 'device',
    create: (_url, options) => new WebSocket(`ws://127.0.0.1:${address.port}/device/connect`, options),
  })
  const state = { loginId: null, state: 'signed-out', code: null, verificationUrl: null,
    expiresAt: null, account: null, message: null }
  const mutate = vi.fn(async () => ({ payload: state }))
  const workerOptions = { appVersion: 'build', mainPublicKeyFingerprint: fingerprint, connect,
    reconcile: async () => {}, heartbeatMs: 20, extensions: [{ ...extension, role: 'server' as const, handle: mutate }] }
  const original = new DeviceConnectionSupervisor({ ...workerOptions, identity })
  const replacementIdentity = { ...identity, workerInstallationId: '77777777-7777-4777-8777-777777777777',
    keyRevision: 2, authorizationRevision: 2 }
  const replacement = new DeviceConnectionSupervisor({ ...workerOptions, identity: replacementIdentity })
  let release!: () => void
  const validation = new Promise<void>(resolve => { release = resolve })
  let validated!: () => void
  const reached = new Promise<void>(resolve => { validated = resolve })
  const caller: ManagementPrincipal = { id: 'github-owner', name: 'Owner', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00Z', revokedAt: null, grants: [{ actions: ['settings:update'], scope: {} }] }
  let registrationIdentity = identity
  const query = async (text: string) => {
    if (text.includes('from management_principals')) return { rows: [{ ...caller,
      expires_at: new Date(caller.expiresAt), revoked_at: null, delegated_from: null }] }
    const record = { mainId: registrationIdentity.mainId, deviceId: registrationIdentity.deviceId,
      workerInstallationId: registrationIdentity.workerInstallationId, keyRevision: registrationIdentity.keyRevision,
      authorizationRevision: registrationIdentity.authorizationRevision, status: 'paired',
      publicKeyFingerprint: 'a'.repeat(64), scopes: ['connect', 'heartbeat'] }
    validated()
    await validation
    return { rows: [{ record }] }
  }
  const pool = { connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
  const commands = { recordAudit: vi.fn(async () => {}), recordDenied: vi.fn(async () => {}) } as unknown as PostgresCommandCoordinator
  const local = { handle: vi.fn(async () => { throw new Error('Device requests must use the captured remote handler.') }) }
  const service = new ComputerGitHubService(pool, identity.mainId, () => endpoint, commands, { local })
  const access = new PostgresAccessService(pool)
  const authenticate = vi.spyOn(access, 'authenticate').mockImplementation(async token => token === 'writer'
    ? caller : { ...caller, grants: [{ actions: ['settings:read'], scope: {} }] })
  const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} },
    checkpoints: { ping: async () => {} } }, operator: { access,
    services: { computerGitHub: service, commands } as unknown as OperatorServices } })
  const clients: Client[] = []
  const target = { hostRef: { kind: 'device' as const, mainId: identity.mainId, deviceId: identity.deviceId },
    applicationInstallationId: identity.workerInstallationId, keyRevision: 1, authorizationRevision: 1 }
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 })
    const connectMcp = async (token: string) => {
      const client = new Client({ name: 'github-device-test', version: '1' })
      clients.push(client)
      await withTransportProgress(client.connect(new StreamableHTTPClientTransport(new URL('/mcp', url), {
        authProvider: { token: async () => token },
      })))
      return client
    }
    const writer = await connectMcp('writer')
    const reader = await connectMcp('reader')
    const originalReady = waitForReady(identity.workerInstallationId)
    original.start()
    await originalReady
    expect(endpoint.captureRequest(identity.deviceId, COMPUTER_GITHUB_NAMESPACE)).toBeDefined()
    const args = { target, expectedAccount: 'owner' }
    const denied = await withTransportProgress(reader.callTool({ name: 'computer_github_logout', arguments: args }))
    expect(denied.isError).toBe(true)
    expect(mutate).not.toHaveBeenCalled()
    const pending = withTransportProgress(writer.callTool({ name: 'computer_github_logout', arguments: args }))
    await Promise.race([reached, pending.then(() => {
      throw new Error('GitHub mutation returned before target validation.')
    })])
    await original.stop()
    auth.authenticateDevice.mockResolvedValue({ ...principal, ...replacementIdentity })
    registrationIdentity = replacementIdentity
    const replacementReady = waitForReady(replacementIdentity.workerInstallationId)
    replacement.start()
    await replacementReady
    expect(endpoint.currentBinding(identity.deviceId))
      .toMatchObject({ workerInstallationId: replacementIdentity.workerInstallationId })
    expect(endpoint.captureRequest(identity.deviceId, COMPUTER_GITHUB_NAMESPACE)).toBeDefined()
    release()
    expect((await pending).isError).toBe(true)
    expect(mutate).not.toHaveBeenCalled()
    const stale = await withTransportProgress(writer.callTool({ name: 'computer_github_logout', arguments: args }))
    expect(stale.isError).toBe(true)
    expect(JSON.stringify(stale)).toContain('COMPUTER_NOT_FOUND')
    const fresh = await withTransportProgress(writer.callTool({ name: 'computer_github_logout', arguments: { ...args, target: { ...target,
      applicationInstallationId: replacementIdentity.workerInstallationId, keyRevision: 2, authorizationRevision: 2 } } }))
    expect(decodeMcpToolResult(fresh)).toMatchObject({ state: 'signed-out' })
    expect(mutate).toHaveBeenCalledOnce()
    mutate.mockRejectedValueOnce(new DomainError('GITHUB_ACCOUNT_CHANGED', 'Account changed.', 409))
    const retry = await withTransportProgress(writer.callTool({ name: 'computer_github_logout', arguments: { ...args, target: { ...target,
      applicationInstallationId: replacementIdentity.workerInstallationId, keyRevision: 2, authorizationRevision: 2 } } }))
    expect(retry.isError).toBe(true)
    expect(JSON.stringify(retry)).toContain('GITHUB_ACCOUNT_CHANGED')
    expect(local.handle).not.toHaveBeenCalled()
  } finally {
    release()
    await Promise.allSettled(clients.map(client => client.close()))
    await withTransportProgress(app.close())
    authenticate.mockRestore()
    await original.stop()
    await replacement.stop()
    endpoint.close()
    await endpoint.join()
    carrier.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}, 15_000)
