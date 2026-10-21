import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'
import { describe, expect, it, vi } from 'vitest'
import { PostgresTrustedConnectionSetup, type TrustedConnectionConfigure } from './trustedConnectionSetup.js'
import type { ConnectionProbe } from './trustedConnectionProbe.js'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { TransferIntentSchema } from '@foreman-code/contracts/byte-transfer'
import { transferContextForBinding } from '../byte-transfer/carrier.js'
import { isDeepStrictEqual } from 'node:util'
function fixture() {
  const mainId = randomUUID(), deviceId = randomUUID()
  let registration: DeviceRegistration = { mainId, deviceId, workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1, publicKeyFingerprint: 'a'.repeat(64), status: 'paired', scopes: ['connect', 'heartbeat'] }
  const principal: ManagementPrincipal = { id: 'owner', name: 'Owner', audience: 'operator', grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }], expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }
  let revoked = false
  const receipts = new Map<string, { input_hash: unknown; target_key: unknown; result: unknown }>()
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    let rows: unknown[] = []
    if (sql.includes('select id,name,audience,grants')) rows = [{ ...principal, expires_at: new Date(principal.expiresAt), revoked_at: revoked ? new Date() : null, delegated_from: null }]
    else if (sql.includes('select record from device_registrations')) rows = [{ record: registration }]
    else if (sql.includes('input_hash, target_key, result')) rows = receipts.has(String(values[2])) ? [receipts.get(String(values[2]))] : []
    else if (sql.includes('select result from management_command_receipts')) rows = [...receipts.values()].sort((a, b) => (b.result as { revision: number }).revision - (a.result as { revision: number }).revision).slice(0, 1)
    else if (sql.includes('insert into management_command_receipts')) receipts.set(String(values[2]), { input_hash: values[4], target_key: values[3], result: JSON.parse(values[5] as string) })
    return { rows, rowCount: rows.length, fields: [], oid: 0, command: 'SELECT' }
  })
  const pool = { connect: async () => ({ query, release: vi.fn() }), query } as unknown as pg.Pool
  const probe = vi.fn(async (): Promise<ConnectionProbe> => ({ state: 'connected', hostKeyFingerprint: `SHA256:${'b'.repeat(43)}`, osUser: 'builder', uid: 1000, hostname: 'laptop', sshVersion: 'OpenSSH_9.6p1', rsyncVersion: 'rsync  version 3.2.7', tailscaleVersion: '1.102.4' }))
  const service = new PostgresTrustedConnectionSetup(pool, mainId, { probe })
  const input: TrustedConnectionConfigure = { deviceId, commandId: randomUUID(), expectedRevision: 0, expectedAuthorizationRevision: 1, endpoint: { transport: 'tailscale', host: '100.64.0.20', port: 22, osUser: 'builder' }, hostKeyFingerprint: `SHA256:${'b'.repeat(43)}`, allowOwnerCommands: true }
  return { service, principal, input, probe, query, receipts, revokePrincipal: () => { revoked = true }, updateDevice: (change: Partial<DeviceRegistration>) => { registration = { ...registration, ...change } } }
}
describe('trusted connection consent and readiness', () => {
  it('requires pair/consent before probing and separates owner SSH from agent authority', async () => {
    const f = fixture()
    expect((await f.service.check(f.principal, f.input.deviceId)).state).toBe('consent-required'); expect(f.probe).not.toHaveBeenCalled()
    const consent = await f.service.configure(f.principal, f.input)
    expect(consent).toMatchObject({ revision: 1, automaticSudo: false, grantsAgentPermissions: false, privilege: 'selected-os-user' })
    expect((await f.service.check(f.principal, f.input.deviceId)).state).toBe('ready')
    expect((await f.service.read(f.principal, f.input.deviceId)).registration.scopes).toEqual(['connect', 'heartbeat'])
  })
  it('configures directly with settings:update and reads back the saved consent', async () => {
    const f = fixture()
    const consent = await f.service.configure(f.principal, f.input, 'mcp')
    expect(consent).toMatchObject({ revision: 1, allowOwnerCommands: true })
    expect((await f.service.read(f.principal, f.input.deviceId)).consent).toEqual(consent)
  })
  it('reads saved consent without retired approval metadata and preserves the stored receipt', async () => {
    const f = fixture()
    const { registration } = await f.service.read(f.principal, f.input.deviceId)
    const stored = {
      mainId: registration.mainId, deviceId: registration.deviceId,
      workerInstallationId: registration.workerInstallationId,
      keyRevision: registration.keyRevision, authorizationRevision: registration.authorizationRevision,
      publicKeyFingerprint: registration.publicKeyFingerprint, revision: 1,
      endpoint: f.input.endpoint, hostKeyFingerprint: f.input.hostKeyFingerprint,
      allowOwnerCommands: true, privilege: 'selected-os-user', automaticSudo: false, grantsAgentPermissions: false,
      approvalId: randomUUID(), approvedBy: 'test-owner', approvedAt: '2026-10-01T00:00:00.000Z',
    }
    f.receipts.set('saved-command', { input_hash: 'saved-hash', target_key: 'saved-device', result: stored })
    const read = await f.service.read(f.principal, f.input.deviceId)
    expect(read.consent).toMatchObject({ revision: 1, endpoint: f.input.endpoint, allowOwnerCommands: true })
    expect(read.consent).not.toHaveProperty('approvalId')
    expect(read.consent).not.toHaveProperty('approvedBy')
    expect(read.consent).not.toHaveProperty('approvedAt')
    expect(f.receipts.get('saved-command')?.result).toEqual(stored)
  })
  it.each(['pending', 'revoked'] as const)('rejects configuration for a %s device', async status => {
    const f = fixture()
    f.updateDevice({ status })
    await expect(f.service.configure(f.principal, f.input)).rejects.toMatchObject({ code: 'DEVICE_CONNECTION_NOT_PAIRED' })
    expect(f.receipts.size).toBe(0)
  })
  it('denies readonly caller and revoked live principal before mutation/probe', async () => {
    const f = fixture(), reader = { ...f.principal, grants: [{ actions: ['settings:read'] as ('settings:read')[], scope: {} }] }
    await expect(f.service.configure(reader, f.input)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    f.revokePrincipal()
    await expect(f.service.inspect(f.principal, f.input.deviceId, f.input.endpoint)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    expect(f.probe).not.toHaveBeenCalled()
  })
  it('replays original command across HTTP/MCP and rejects changed payload', async () => {
    const f = fixture(), first = await f.service.configure(f.principal, f.input, 'http')
    expect(await f.service.configure(f.principal, f.input, 'mcp')).toEqual(first)
    await expect(f.service.configure(f.principal, { ...f.input, allowOwnerCommands: false })).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
    await expect(f.service.configure(f.principal, { ...f.input, commandId: randomUUID() })).rejects.toMatchObject({ code: 'DEVICE_CONNECTION_CONFLICT' })
  })
  it('persists revocation without SSH or live host security changes; old receipt cannot revive current consent', async () => {
    const f = fixture(); await f.service.configure(f.principal, f.input)
    await f.service.configure(f.principal, { ...f.input, commandId: randomUUID(), expectedRevision: 1, allowOwnerCommands: false })
    expect((await f.service.check(f.principal, f.input.deviceId)).state).toBe('consent-revoked')
    await f.service.configure(f.principal, f.input)
    expect((await f.service.check(f.principal, f.input.deviceId)).state).toBe('consent-revoked')
    expect(f.probe).not.toHaveBeenCalled()
  })
  it.each([{ status: 'revoked' as const }, { authorizationRevision: 2 }, { keyRevision: 2 }, { workerInstallationId: randomUUID() }, { publicKeyFingerprint: 'c'.repeat(64) }])('fences changed paired identity %j', async change => {
    const f = fixture(); await f.service.configure(f.principal, f.input); f.updateDevice(change)
    expect((await f.service.check(f.principal, f.input.deviceId)).state).toBe(change.status === 'revoked' ? 'revoked' : 'identity-changed')
    expect(f.probe).not.toHaveBeenCalled()
  })
  it('revocation during SSH check fences successful result', async () => {
    const f = fixture(); await f.service.configure(f.principal, f.input)
    f.probe.mockImplementationOnce(async () => { f.updateDevice({ status: 'revoked' }); return { state: 'connected', hostKeyFingerprint: f.input.hostKeyFingerprint, osUser: 'builder', uid: 1000, hostname: 'host', sshVersion: 'OpenSSH', rsyncVersion: 'rsync', tailscaleVersion: '1.102.4' } })
    expect(await f.service.check(f.principal, f.input.deviceId)).toMatchObject({ state: 'revoked', probe: null })
  })
  it('retains authentication/offline states and rejects a different trusted SSH key or missing tools', async () => {
    const f = fixture(); await f.service.configure(f.principal, f.input)
    const connected = await f.probe()
    f.probe.mockResolvedValue({ ...connected, state: 'authentication-required' }); expect((await f.service.check(f.principal, f.input.deviceId)).state).toBe('authentication-required')
    f.probe.mockResolvedValue({ ...connected, state: 'offline' }); expect((await f.service.check(f.principal, f.input.deviceId)).state).toBe('offline')
    f.probe.mockResolvedValue({ ...connected, hostKeyFingerprint: `SHA256:${'c'.repeat(43)}` }); expect((await f.service.check(f.principal, f.input.deviceId)).state).toBe('host-key-mismatch')
    f.probe.mockResolvedValue({ ...connected, rsyncVersion: null }); expect((await f.service.check(f.principal, f.input.deviceId)).state).toBe('tools-missing')
  })
  it('offers fixed inspection before consent without claiming ready or issuing a grant', async () => {
    const f = fixture()
    expect((await f.service.inspect(f.principal, f.input.deviceId, f.input.endpoint)).state).toBe('connected')
    expect((await f.service.read(f.principal, f.input.deviceId)).consent).toBeNull()
    expect(f.receipts.size).toBe(0)
  })
})

async function acceptedFixture() {
  const f = fixture(), consent = await f.service.configure(f.principal, f.input)
  let binding: DeviceSessionBinding = { mainId: consent.mainId, deviceId: consent.deviceId, workerInstallationId: consent.workerInstallationId,
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1 }
  const intent = TransferIntentSchema.parse({ ...transferContextForBinding(binding), version: 1, transferId: randomUUID(), operationId: randomUUID(), executionId: randomUUID(),
    attemptId: randomUUID(), placementHash: 'a'.repeat(64), rootId: randomUUID(), rootBindingRevision: 1, direction: 'to-worker', byteClass: 'source',
    sha256: 'b'.repeat(64), byteSize: 2, manifestDigest: 'c'.repeat(64), chunkBytes: 2, expiresAt: new Date(Date.now() + 120000).toISOString() })
  let denied = false
  const accepted = { intent: vi.fn(async () => intent), authorize: vi.fn(async (candidate: typeof intent) => {
    if (denied) throw new Error('original domain grant revoked')
    if (!isDeepStrictEqual(candidate, intent)) throw new Error('original accepted intent changed')
  }) }
  const authority = { accepted, binding: structuredClone(binding), current: () => binding }
  return { ...f, intent, authority, deny: () => { denied = true }, move: () => { binding = { ...binding, connectionEpoch: randomUUID(), connectionGeneration: 2 } } }
}
describe('accepted-transfer trusted setup domain capability', () => {
  it('uses original accepted authority without settings:read or a borrowed management principal', async () => {
    const f = await acceptedFixture(), actor = { ...f.principal, grants: [{ actions: ['job_artifacts:read'] as ('job_artifacts:read')[], scope: {} }] }
    await expect(f.service.check(actor, f.input.deviceId)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    f.query.mockClear()
    const checked = await f.service.checkAcceptedTransfer(f.intent, f.authority, new AbortController().signal)
    expect(checked.state).toBe('ready'); expect(f.authority.accepted.authorize).toHaveBeenCalledTimes(2)
    expect(actor.grants[0]!.actions).toEqual(['job_artifacts:read'])
  })
  it('rejects altered accepted identity and denied data grants before probing', async () => {
    const f = await acceptedFixture()
    await expect(f.service.checkAcceptedTransfer({ ...f.intent, sha256: 'e'.repeat(64) }, f.authority, new AbortController().signal)).rejects.toMatchObject({ code: 'DEVICE_TRANSFER_INTENT_CHANGED' })
    f.deny(); await expect(f.service.checkAcceptedTransfer(f.intent, f.authority, new AbortController().signal)).rejects.toThrow('original domain grant revoked')
    expect(f.probe).not.toHaveBeenCalled()
  })
  it('fences current outgoing W07 capture before and after probe', async () => {
    const f = await acceptedFixture(); f.move()
    await expect(f.service.checkAcceptedTransfer(f.intent, f.authority, new AbortController().signal)).rejects.toMatchObject({ code: 'DEVICE_TRANSFER_CONNECTION_CHANGED' })
    expect(f.probe).not.toHaveBeenCalled()
    const g = await acceptedFixture(), observed = await g.probe(); g.probe.mockClear()
    g.probe.mockImplementationOnce(async () => { g.move(); return observed })
    await expect(g.service.checkAcceptedTransfer(g.intent, g.authority, new AbortController().signal)).rejects.toMatchObject({ code: 'DEVICE_TRANSFER_CONNECTION_CHANGED' })
  })
  it('rechecks original domain grant and current consent after asynchronous probing', async () => {
    const f = await acceptedFixture(), observed = await f.probe(); f.probe.mockClear()
    f.probe.mockImplementationOnce(async () => { f.deny(); return observed })
    await expect(f.service.checkAcceptedTransfer(f.intent, f.authority, new AbortController().signal)).rejects.toThrow('original domain grant revoked')
    const g = await acceptedFixture(), same = await g.probe(); g.probe.mockClear()
    g.probe.mockImplementationOnce(async () => { await g.service.configure(g.principal, { ...g.input, commandId: randomUUID(), expectedRevision: 1, allowOwnerCommands: false }); return same })
    expect((await g.service.checkAcceptedTransfer(g.intent, g.authority, new AbortController().signal)).state).toBe('consent-revoked')
  })
  it('fences expiry/cancellation and changed registration without creating setup grants', async () => {
    const f = await acceptedFixture(), controller = new AbortController(); controller.abort(new Error('cancelled'))
    await expect(f.service.checkAcceptedTransfer(f.intent, f.authority, controller.signal)).rejects.toThrow('cancelled')
    const expired = { ...f.intent, expiresAt: new Date(Date.now() - 1).toISOString() }; f.authority.accepted.intent.mockResolvedValueOnce(expired)
    f.authority.accepted.authorize.mockResolvedValueOnce()
    await expect(f.service.checkAcceptedTransfer(expired, f.authority, new AbortController().signal)).rejects.toMatchObject({ code: 'DEVICE_TRANSFER_EXPIRED' })
    const g = await acceptedFixture(), observed = await g.probe(); g.probe.mockClear()
    g.probe.mockImplementationOnce(async () => { g.updateDevice({ keyRevision: 2 }); return observed })
    await expect(g.service.checkAcceptedTransfer(g.intent, g.authority, new AbortController().signal)).rejects.toMatchObject({ code: 'DEVICE_TRANSFER_IDENTITY_CHANGED' })
  })
})
