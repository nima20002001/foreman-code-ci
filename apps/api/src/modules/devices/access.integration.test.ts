import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { DevicePairingGrantResultSchema } from '@foreman-code/contracts/device-identity'
import { applyApplicationMigrations } from '../../infrastructure/migrations.js'
import { PostgresAccessService } from '../access/postgres.js'
import { publicKeyFingerprint } from '@foreman-code/contracts/device-identity-node'
import { PostgresDeviceAccessService, pairingProof } from './access.js'
import { loadOrCreateMainDeviceIdentity, mainDeviceIdentityMigration } from './mainIdentity.js'
import { deviceIdentityMigration } from './migration.js'
import { authorizeDeviceHost } from './hostAuthorization.js'
import { registerDeviceManagementTools } from './management.js'

it('persists pair/revoke with denied and authenticated Operator MCP readback across main restart', async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('Requires explicit owned TEST_DATABASE_URL.')
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
  const schema = `devices_${randomUUID().replaceAll('-', '')}`
  await admin.query(`create schema "${schema}"`)
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` })
  const app = Fastify(), clients: Client[] = []
  try {
    await applyApplicationMigrations(pool)
    // Root may have integrated this migration already.
    if (!(await pool.query("select to_regclass('device_registrations') as relation")).rows[0]?.relation) await pool.query(deviceIdentityMigration.sql)
    const mainId = (await pool.query('select id from application_installation')).rows[0].id as string
    if (!(await pool.query("select to_regclass('device_main_identity') as relation")).rows[0]?.relation) await pool.query(mainDeviceIdentityMigration.sql)
    const mainKeys = await Promise.all([loadOrCreateMainDeviceIdentity(pool, mainId), loadOrCreateMainDeviceIdentity(pool, mainId)])
    expect(mainKeys[0]!.publicKeyFingerprint).toBe(mainKeys[1]!.publicKeyFingerprint)
    expect((await loadOrCreateMainDeviceIdentity(pool, mainId)).publicKeyFingerprint).toBe(mainKeys[0]!.publicKeyFingerprint)
    let devices = new PostgresDeviceAccessService(pool, mainId)
    const access = new PostgresAccessService(pool)
    const owner = await access.issue({ name: 'owner', audience: 'operator', grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }], expiresAt: new Date(Date.now() + 2 * 60 * 60_000) })
    const reader = await access.issue({ name: 'reader', audience: 'operator', grants: [{ actions: ['settings:read'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    app.post('/mcp', async (request, reply) => {
      const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1]
      const principal = await access.authenticate(token, ['operator'])
      const server = new McpServer({ name: 'devices-integration', version: '1' })
      registerDeviceManagementTools(server, devices, principal)
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      reply.raw.once('close', () => { void Promise.allSettled([transport.close(), server.close()]) })
      await server.connect(transport); reply.hijack(); await transport.handleRequest(request.raw, reply.raw, request.body)
    })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'device-mcp-test', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const client = await connect(owner.token), denied = await connect(reader.token)
    expect((await denied.listTools()).tools.map(tool => tool.name)).not.toContain('device_pairing_grant_create')
    const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const args = { commandId: randomUUID(), workerInstallationId: randomUUID(), publicKey, expectedFingerprint: publicKeyFingerprint(publicKey), scopes: ['connect', 'heartbeat'] }
    const issued = DevicePairingGrantResultSchema.parse(decodeMcpToolResult(
      await client.callTool({ name: 'device_pairing_grant_create', arguments: args })))
    expect(Date.parse(issued.expiresAt) - Date.now()).toBeGreaterThan(59 * 60_000)
    expect(decodeMcpToolResult((await client.callTool({ name: 'device_pairing_grant_create', arguments: args })))).toEqual(issued)
    const pairing = { mainId, workerInstallationId: args.workerInstallationId, publicKey, grant: issued.grant, requestId: randomUUID() }
    const input = { ...pairing, signature: sign(null, Buffer.from(pairingProof(pairing)), keys.privateKey).toString('base64url') }
    const issuedAt = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(issuedAt + 30 * 60_000)
    const simultaneous = await Promise.all([devices.pair(input), devices.pair(input)])
    const paired = simultaneous[0]!
    expect(simultaneous[1]).toEqual(paired)
    const replay = { ...pairing, requestId: randomUUID() }
    await expect(devices.pair({ ...replay, signature: sign(null, Buffer.from(pairingProof(replay)), keys.privateKey).toString('base64url') })).rejects.toMatchObject({ code: 'conflict' })
    devices = new PostgresDeviceAccessService(pool, mainId)
    expect(await devices.pair(input)).toEqual(paired)
    clock.mockReturnValue(issuedAt + 365 * 86400_000)
    expect(await devices.pair(input)).toEqual(paired)
    const principal = await devices.authenticateDevice(paired.credential, 'connect')
    await expect(devices.revalidateDevice(principal, 'heartbeat')).resolves.toBeUndefined()
    await expect(devices.authenticateDevice(paired.credential, 'metrics:report')).rejects.toThrow()
    clock.mockRestore()
    await expect(authorizeDeviceHost(pool, reader.principal, 'harnesses:read', { kind: 'device', mainId, deviceId: paired.registration.deviceId }, args.workerInstallationId)).rejects.toThrow()
    const readback = decodeMcpToolResult((await client.callTool({ name: 'devices_list', arguments: {} }))) as { devices: unknown[] }
    expect(readback.devices).toEqual([paired.registration])
    const revoke = { commandId: randomUUID(), deviceId: paired.registration.deviceId, expectedRevision: 1 }
    const revoked = await client.callTool({ name: 'device_revoke', arguments: revoke })
    expect(decodeMcpToolResult(revoked)).toMatchObject({ status: 'revoked', authorizationRevision: 2 })
    expect(decodeMcpToolResult((await client.callTool({ name: 'device_revoke', arguments: revoke })))).toEqual(decodeMcpToolResult(revoked))
    devices = new PostgresDeviceAccessService(pool, mainId)
    await expect(devices.authenticateDevice(paired.credential, 'connect')).rejects.toThrow()
    await expect(devices.revalidateDevice(principal, 'heartbeat')).rejects.toThrow()
    expect((await devices.list(owner.principal))[0]?.status).toBe('revoked')
    expect(JSON.stringify((await pool.query('select result from management_command_receipts')).rows)).not.toContain(issued.grant)
    const expiredGrant = await devices.createPairingGrant(owner.principal, { ...args, workerInstallationId: randomUUID(), scopes: ['connect'], commandId: randomUUID() })
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(expiredGrant.expiresAt) + 1)
    const expired = { ...pairing, grant: expiredGrant.grant, workerInstallationId: expiredGrant.registration.workerInstallationId, requestId: randomUUID() }
    await expect(devices.pair({ ...expired, signature: sign(null, Buffer.from(pairingProof(expired)), keys.privateKey).toString('base64url') })).rejects.toMatchObject({ code: 'expired' })
    vi.restoreAllMocks()
    await pool.query('update management_principals set revoked_at=now() where id=$1', [owner.principal.id])
    await expect(devices.list(owner.principal)).rejects.toThrow()
  } finally {
    vi.restoreAllMocks()
    await Promise.all(clients.map(client => client.close())); await app.close(); await pool.end()
    await admin.query(`drop schema "${schema}" cascade`); await admin.end()
  }
})
