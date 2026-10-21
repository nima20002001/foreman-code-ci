import { EventEmitter } from 'node:events'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type pg from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { DevicePrincipal, DeviceRegistration, MainIdentityProofRequest, MainEnrollmentProofRequest, MainSignedEnrollmentProof } from '@foreman-code/contracts/device-identity'
import { publicKeyFingerprint, verifyMainIdentityProof, verifyMainEnrollmentProof } from '@foreman-code/contracts/device-identity-node'
import { DeviceEndpoint, type DeviceAuthenticator } from '../src/modules/devices/deviceEndpoint.js'
import { DeviceConnectionSupervisor } from '../src/modules/devices/connectionSupervisor.js'
import { adaptDeviceSocket } from '../src/modules/devices/deviceWire.js'
import { deviceHttpHandler } from '../src/modules/devices/deviceHttp.js'
import { signMainIdentityProof, signMainEnrollmentProof } from '../src/modules/devices/mainIdentity.js'
import { PostgresDeviceAccessService } from '../src/modules/devices/access.js'
import { deviceNegotiationHash } from '../src/modules/devices/deviceApplicationChannel.js'

class Socket extends EventEmitter {
  bufferedAmount = 0
  peer?: Socket
  closed = false
  frames: Record<string, unknown>[] = []
  send(text: string) { this.frames.push(JSON.parse(text)); queueMicrotask(() => { if (!this.closed && !this.peer?.closed) this.peer?.emit('message', text, false) }) }
  frame(value: unknown) { this.emit('message', JSON.stringify(value), false) }
  close() { if (this.closed) return; this.closed = true; this.emit('close'); this.peer?.close() }
}
const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const main = { mainId: randomUUID(), publicKey, privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKeyFingerprint: publicKeyFingerprint(publicKey) }
const registration: DeviceRegistration = { mainId: main.mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat'], publicKeyFingerprint: 'a'.repeat(64) }
const principal: DevicePrincipal = { ...registration, audience: 'graphql-worker', expiresAt: '2099-01-01T00:00:00.000Z' }
const identity = { mainId: main.mainId, deviceId: principal.deviceId, workerInstallationId: principal.workerInstallationId, keyRevision: 1, authorizationRevision: 1, bootId: randomUUID() }
const signer = async (request: MainIdentityProofRequest) => signMainIdentityProof(main, request, 'build')
const flush = async () => { for (let i = 0; i < 250; i++) await Promise.resolve() }
function endpoint(auth: DeviceAuthenticator) {
  return new DeviceEndpoint({ mainId: main.mainId, appVersion: 'build', auth, signMainIdentityProof: signer, presence: () => {}, reconcile: async () => {}, handshakeMs: 1000, heartbeatMs: 1000 })
}
async function challenge(body: unknown) {
  const pair = vi.fn(async () => ({})), signProof = vi.fn(async (request: MainEnrollmentProofRequest) => signMainEnrollmentProof(main, request, 'build'))
  const handler = deviceHttpHandler({ mainId: main.mainId, mainPublicKeyFingerprint: main.publicKeyFingerprint, appVersion: 'build', pair, signMainEnrollmentProof: signProof })
  const request = Object.assign(new EventEmitter(), { headers: {}, method: 'POST', url: '/device/challenge', destroy: vi.fn() })
  let status = 0
  const response = await new Promise<{ status: number; body: unknown }>((resolve) => {
    handler(request as unknown as IncomingMessage, { destroyed: false, writeHead: (value: number) => { status = value }, end: (value: string) => resolve({ status, body: JSON.parse(value) }) } as unknown as ServerResponse)
    request.emit('data', Buffer.from(JSON.stringify(body))); request.emit('end')
  })
  return { ...response, pair, signProof }
}
const manager: ManagementPrincipal = { id: randomUUID(), name: 'Owner', audience: 'operator', grants: [{ actions: ['settings:update'], scope: {} }], expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }
function commandPool() {
  let record = { ...registration }
  const receipts = new Map<string, { input_hash: string; target_key: string; result: DeviceRegistration }>()
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.includes('from management_principals')) return { rows: [{ id: manager.id, name: manager.name, audience: 'operator', grants: manager.grants, expires_at: new Date(manager.expiresAt), revoked_at: null, delegated_from: null }] }
    if (sql.includes('from management_command_receipts')) return { rows: receipts.has(String(values[2])) ? [receipts.get(String(values[2]))] : [] }
    if (sql.startsWith('insert into management_command_receipts')) receipts.set(String(values[2]), { input_hash: String(values[4]), target_key: String(values[3]), result: JSON.parse(String(values[5])) as DeviceRegistration })
    if (sql.includes('select record from device_registrations')) return { rows: [{ record }] }
    if (sql.startsWith('update device_registrations')) record = values[1] as DeviceRegistration
    return { rows: [] }
  })
  return { pool: { connect: async () => ({ query, release: vi.fn() }) } as unknown as pg.Pool, query, setRecord: (value: DeviceRegistration) => { record = value } }
}
function connectTo(endpoint: DeviceEndpoint, tasks: Promise<void>[], sockets: Socket[]) {
  return async () => {
    const admitted = await endpoint.authenticate({ authorization: 'Bearer credential' })
    const rawMain = new Socket(), rawWorker = new Socket(); rawMain.peer = rawWorker; rawWorker.peer = rawMain
    sockets.push(rawWorker); tasks.push(endpoint.acceptAuthenticated(admitted, adaptDeviceSocket(rawMain)))
    return adaptDeviceSocket(rawWorker)
  }
}
afterEach(() => vi.useRealTimers())
describe('W07 confirmed security and lifecycle regressions', () => {
  it('public challenge cannot mint a forged authenticated welcome for the actual supervisor', async () => {
    const socket = new Socket(), reconcile = vi.fn(async () => {})
    const supervisor = new DeviceConnectionSupervisor({ identity, appVersion: 'build', mainPublicKeyFingerprint: main.publicKeyFingerprint, connect: async () => adaptDeviceSocket(socket), reconcile })
    try {
      supervisor.start(); await flush(); const hello = socket.frames[0]!, epoch = randomUUID()
      const request: MainIdentityProofRequest = { audience: 'graphql-worker-main-v1', ...identity, nonce: String(hello.nonce), connectionGeneration: Number(hello.connectionGeneration), connectionEpoch: String(hello.connectionEpoch), mainConnectionEpoch: epoch, negotiationHash: deviceNegotiationHash([]), protocolVersion: 1, workerApplicationVersion: 'build' }
      const response = await challenge(request)
      socket.frame({ ...identity, type: 'welcome', protocolVersion: 1, appVersion: 'build', connectionGeneration: hello.connectionGeneration, connectionEpoch: epoch, mainIdentityProof: response.body, capabilities: { heartbeat: true, dispatch: false, transfer: false, extensions: [] } }); await flush()
      expect(supervisor.status()).toMatchObject({ phase: 'backoff', failure: 'wrong-main' })
      expect(socket.closed).toBe(true); expect(supervisor.currentBinding()).toBeUndefined()
      expect(response.status).toBe(400); expect(response.signProof).not.toHaveBeenCalled(); expect(response.pair).not.toHaveBeenCalled()
      expect(await verifyMainIdentityProof(response.body, request, main.publicKeyFingerprint)).toBe(false); expect(reconcile).not.toHaveBeenCalled()
    } finally { await supervisor.stop() }
  })
  it('valid public enrollment proof is unusable as a welcome and rejects connection fields', async () => {
    const socket = new Socket(), reconcile = vi.fn(async () => {})
    const supervisor = new DeviceConnectionSupervisor({ identity, appVersion: 'build', mainPublicKeyFingerprint: main.publicKeyFingerprint, connect: async () => adaptDeviceSocket(socket), reconcile })
    try {
      supervisor.start(); await flush(); const hello = socket.frames[0]!, epoch = randomUUID()
      const enrollment: MainEnrollmentProofRequest = { audience: 'graphql-worker-main-enrollment-v1', mainId: main.mainId, workerInstallationId: identity.workerInstallationId, nonce: String(hello.nonce), protocolVersion: 1, workerApplicationVersion: 'build' }
      const response = await challenge(enrollment)
      expect(response.status).toBe(200); expect(response.signProof).toHaveBeenCalledOnce(); expect(response.pair).not.toHaveBeenCalled()
      expect(await verifyMainEnrollmentProof(response.body, enrollment, main.publicKeyFingerprint)).toBe(true)
      const connection: MainIdentityProofRequest = { ...enrollment, audience: 'graphql-worker-main-v1', ...identity, connectionGeneration: Number(hello.connectionGeneration), connectionEpoch: String(hello.connectionEpoch), mainConnectionEpoch: epoch, negotiationHash: deviceNegotiationHash([]) }
      expect(await verifyMainIdentityProof(response.body, connection, main.publicKeyFingerprint)).toBe(false)
      expect(await verifyMainIdentityProof({ ...response.body as MainSignedEnrollmentProof, request: connection }, connection, main.publicKeyFingerprint)).toBe(false)
      const extraFields = await challenge({ ...enrollment, deviceId: identity.deviceId })
      expect(extraFields.status).toBe(400); expect(extraFields.signProof).not.toHaveBeenCalled()
      socket.frame({ ...identity, type: 'welcome', protocolVersion: 1, appVersion: 'build', connectionGeneration: hello.connectionGeneration, connectionEpoch: epoch, mainIdentityProof: response.body, capabilities: { heartbeat: true, dispatch: false, transfer: false, extensions: [] } }); await flush()
      expect(supervisor.status()).toMatchObject({ phase: 'backoff', failure: 'wrong-main' })
      expect(socket.closed).toBe(true); expect(supervisor.currentBinding()).toBeUndefined()
      expect(reconcile).not.toHaveBeenCalled()
    } finally { await supervisor.stop() }
  })
  it('actual authorization-storage outage backs off and recovers through actual admission', async () => {
    vi.useFakeTimers()
    const query = vi.fn(async () => ({ rows: [{ record: registration, credential_expires_at: new Date(principal.expiresAt) }] }))
    query.mockRejectedValueOnce(Object.assign(new Error('DB restarting'), { code: 'ECONNREFUSED' }))
    const service = new PostgresDeviceAccessService({ query } as unknown as pg.Pool, main.mainId), device = endpoint(service)
    const sockets: Socket[] = [], tasks: Promise<void>[] = [], connect = vi.fn(connectTo(device, tasks, sockets))
    const supervisor = new DeviceConnectionSupervisor({ identity, appVersion: 'build', mainPublicKeyFingerprint: main.publicKeyFingerprint, connect, random: () => 0.5, heartbeatMs: 1000, reconcile: async () => {} })
    try {
      supervisor.start(); await flush(); expect(supervisor.status()).toMatchObject({ desired: true, phase: 'backoff', failure: 'transport' })
      await vi.advanceTimersByTimeAsync(501); await flush()
      expect(connect).toHaveBeenCalledTimes(2); expect(supervisor.status().phase).toBe('ready'); expect(sockets[0]!.closed).toBe(false)
    } finally { await supervisor.stop(); device.close(); await Promise.allSettled(tasks) }
  })
  it('credential rejection retries admission without accepting rejected credentials or using fallback', async () => {
    vi.useFakeTimers()
    const query = vi.fn(async () => ({ rows: [] }))
    const service = new PostgresDeviceAccessService({ query } as unknown as pg.Pool, main.mainId), device = endpoint(service)
    const tasks: Promise<void>[] = [], connect = vi.fn(connectTo(device, tasks, []))
    const reconcile = vi.fn(async () => {})
    const supervisor = new DeviceConnectionSupervisor({ identity, appVersion: 'build',
      mainPublicKeyFingerprint: main.publicKeyFingerprint, connect, reconcile, random: () => 0.5 })
    try {
      supervisor.start(); await flush()
      expect(supervisor.status()).toMatchObject({ phase: 'backoff', failure: 'authentication' })
      await vi.advanceTimersByTimeAsync(499)
      expect(connect).toHaveBeenCalledOnce(); expect(query).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)
      expect(connect).toHaveBeenCalledTimes(2); expect(query).toHaveBeenCalledTimes(2)
      expect(supervisor.status()).toMatchObject({ phase: 'backoff', failure: 'authentication' })
      expect(supervisor.currentBinding()).toBeUndefined(); expect(reconcile).not.toHaveBeenCalled()
    } finally { await supervisor.stop(); device.close(); await Promise.allSettled(tasks) }
  })
  it('persisted definitive revocation stops retries and cannot admit a rejected credential', async () => {
    vi.useFakeTimers()
    const query = vi.fn(async () => ({ rows: [{ record: { ...registration, status: 'revoked' },
      credential_expires_at: new Date(principal.expiresAt) }] }))
    const service = new PostgresDeviceAccessService({ query } as unknown as pg.Pool, main.mainId)
    const device = endpoint(service)
    const tasks: Promise<void>[] = []
    const connect = vi.fn(connectTo(device, tasks, []))
    const reconcile = vi.fn(async () => {})
    const supervisor = new DeviceConnectionSupervisor({ identity, appVersion: 'build',
      mainPublicKeyFingerprint: main.publicKeyFingerprint, connect, reconcile })
    try {
      supervisor.start(); await flush()
      expect(supervisor.status()).toMatchObject({ phase: 'blocked', failure: 'revoked' })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(connect).toHaveBeenCalledOnce(); expect(query).toHaveBeenCalledTimes(2)
      expect(supervisor.currentBinding()).toBeUndefined(); expect(reconcile).not.toHaveBeenCalled()
    } finally { await supervisor.stop(); device.close(); await Promise.allSettled(tasks) }
  })
  it('live authorization-storage outage keeps the link instead of dropping or blocking it', async () => {
    vi.useFakeTimers()
    const query = vi.fn(async () => ({ rows: [{ record: registration, credential_expires_at: new Date(principal.expiresAt) }] }))
    const service = new PostgresDeviceAccessService({ query } as unknown as pg.Pool, main.mainId), device = endpoint(service)
    const sockets: Socket[] = [], tasks: Promise<void>[] = [], connect = vi.fn(connectTo(device, tasks, sockets))
    const supervisor = new DeviceConnectionSupervisor({ identity, appVersion: 'build', mainPublicKeyFingerprint: main.publicKeyFingerprint, connect, random: () => 0.5, heartbeatMs: 1000, reconcile: async () => {} })
    try {
      supervisor.start(); await flush(); expect(supervisor.status().phase).toBe('ready')
      query.mockRejectedValueOnce(Object.assign(new Error('DB restarting'), { code: 'ECONNREFUSED' }))
      sockets[0]!.send(JSON.stringify({ type: 'ping', connectionEpoch: sockets[0]!.peer!.frames[0]!.connectionEpoch })); await flush()
      expect(supervisor.status()).toMatchObject({ phase: 'ready', failure: null })
      await vi.advanceTimersByTimeAsync(501); await flush()
      expect(connect).toHaveBeenCalledOnce(); expect(sockets[0]!.closed).toBe(false); expect(supervisor.status().phase).toBe('ready')
    } finally { await supervisor.stop(); device.close(); await Promise.allSettled(tasks) }
  })
  it.each([true, false])('old revoke preserves newer pairing and ticket with prior local fence %s', async (priorFence) => {
    let deliverFence = priorFence
    const port = commandPool(), callbacks = vi.fn((deviceId: string, revision: number) => { if (deliverFence) device.revoke(deviceId, revision) })
    let admitted = principal
    const device = endpoint({ authenticateDevice: async () => admitted, revalidateDevice: async () => {} })
    const service = new PostgresDeviceAccessService(port.pool, main.mainId, callbacks), commandId = 'original-revocation'
    const revoked = await service.revoke(manager, principal.deviceId, 1, commandId)
    expect(revoked).toMatchObject({ status: 'revoked', authorizationRevision: 2 })
    deliverFence = true
    admitted = { ...principal, authorizationRevision: 3 }; port.setRecord({ ...registration, authorizationRevision: 3 })
    const ticket = await device.authenticate({ authorization: 'Bearer credential' })
    const tasks: Promise<void>[] = [], sockets: Socket[] = []
    const supervisor = new DeviceConnectionSupervisor({ identity: { ...identity, authorizationRevision: 3 }, appVersion: 'build', mainPublicKeyFingerprint: main.publicKeyFingerprint, connect: connectTo(device, tasks, sockets), reconcile: async () => {}, heartbeatMs: 1000 })
    try {
      supervisor.start(); await flush(); expect(supervisor.status().phase).toBe('ready')
      port.query.mockClear(); expect(await service.revoke(manager, principal.deviceId, 1, commandId)).toEqual(revoked); await flush()
      expect(port.query.mock.calls.filter(([sql]) => sql.includes('device_registrations'))).toHaveLength(0)
      expect(port.query.mock.calls.find(([sql]) => sql.includes('from management_command_receipts'))?.[1]).toEqual([[manager.id], 'device_revoke', commandId])
      expect(sockets[0]!.closed).toBe(false); expect(supervisor.status().phase).toBe('ready')
      const replacement = new Socket(); const task = device.acceptAuthenticated(ticket, adaptDeviceSocket(replacement)); tasks.push(task)
      replacement.frame({ ...identity, authorizationRevision: 3, type: 'hello', protocolVersion: 1, appVersion: 'build', nonce: Buffer.alloc(32).toString('base64url'), connectionGeneration: 1, connectionEpoch: randomUUID() }); await flush()
      expect(replacement.frames[0]).toMatchObject({ type: 'welcome', authorizationRevision: 3 })
    } finally { await supervisor.stop(); device.close(); await Promise.allSettled(tasks) }
  })
  it('replayed committed revoke recovers a missed fence while rejecting older admission tickets', async () => {
    const port = commandPool(), device = endpoint({ authenticateDevice: async () => principal, revalidateDevice: async () => {} })
    const callback = vi.fn((deviceId: string, revision: number) => device.revoke(deviceId, revision))
    callback.mockImplementationOnce(() => { throw new Error('post-commit fence interrupted') })
    const service = new PostgresDeviceAccessService(port.pool, main.mainId, callback), tasks: Promise<void>[] = [], sockets: Socket[] = []
    const ticket = await device.authenticate({ authorization: 'Bearer credential' })
    const supervisor = new DeviceConnectionSupervisor({ identity, appVersion: 'build', mainPublicKeyFingerprint: main.publicKeyFingerprint, connect: connectTo(device, tasks, sockets), reconcile: async () => {}, heartbeatMs: 1000 })
    try {
      supervisor.start(); await flush(); expect(supervisor.status().phase).toBe('ready')
      await expect(service.revoke(manager, principal.deviceId, 1, 'recover-revocation')).rejects.toThrow('post-commit fence interrupted')
      expect(sockets[0]!.closed).toBe(false); port.query.mockClear()
      expect(await service.revoke(manager, principal.deviceId, 1, 'recover-revocation')).toMatchObject({ status: 'revoked', authorizationRevision: 2 }); await flush()
      expect(callback).toHaveBeenLastCalledWith(principal.deviceId, 2)
      expect(port.query.mock.calls.filter(([sql]) => sql.includes('device_registrations'))).toHaveLength(0)
      expect(sockets[0]!.closed).toBe(true)
      const old = new Socket(); await device.acceptAuthenticated(ticket, adaptDeviceSocket(old))
      expect(old.frames[0]).toEqual({ type: 'blocked', code: 'revoked' })
      await expect(device.authenticate({ authorization: 'Bearer credential' })).rejects.toThrow('revoked')
    } finally { await supervisor.stop(); device.close(); await Promise.allSettled(tasks) }
  })
})
