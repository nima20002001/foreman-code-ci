import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it } from 'vitest'
import { DeviceListResultSchema, DevicePairingGrantResultSchema, MainDeviceIdentityPublicSchema } from '@foreman-code/contracts/device-identity'
import { publicKeyFingerprint, pairingProof } from '@foreman-code/contracts/device-identity-node'
import type { OperatorServices } from '../../mcp/operator/types.js'
import { buildApp } from '../../app.js'
import { applyApplicationMigrations } from '../../infrastructure/migrations.js'
import { PostgresAccessService } from '../access/postgres.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { PostgresDeviceAccessService } from './access.js'
import { loadOrCreateMainDeviceIdentity, mainDeviceIdentityMigration } from './mainIdentity.js'
import { deviceIdentityMigration } from './migration.js'

/** Root runs this fixture after applying the real /mcp and management-route composition patch. */
it('serves device management through the existing authenticated API/MCP with denial audit and persisted readback', async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('Requires explicit owned TEST_DATABASE_URL.')
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
  const schema = `existing_device_mcp_${randomUUID().replaceAll('-', '')}`
  await admin.query(`create schema "${schema}"`)
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` })
  const clients: Client[] = []
  let app: ReturnType<typeof buildApp> | undefined
  try {
    await applyApplicationMigrations(pool)
    if (!(await pool.query("select to_regclass('device_registrations') as relation")).rows[0]?.relation) await pool.query(deviceIdentityMigration.sql)
    if (!(await pool.query("select to_regclass('device_main_identity') as relation")).rows[0]?.relation) await pool.query(mainDeviceIdentityMigration.sql)
    const mainId = (await pool.query('select id from application_installation where singleton=true')).rows[0].id as string
    const mainIdentity = await loadOrCreateMainDeviceIdentity(pool, mainId)
    const access = new PostgresAccessService(pool), commands = new PostgresCommandCoordinator(pool)
    const devices = new PostgresDeviceAccessService(pool, mainId)
    const services = { devices, commands } as unknown as OperatorServices
    app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } }, operator: { access, services } })
    const owner = await access.issue({ name: 'device owner', audience: 'operator', expiresAt: new Date(Date.now() + 120_000),
      grants: [{ actions: ['settings:read', 'settings:update', 'capabilities:read'], scope: {} }] })
    const reader = await access.issue({ name: 'device reader', audience: 'operator', expiresAt: new Date(Date.now() + 120_000),
      grants: [{ actions: ['settings:read'], scope: {} }] })
    const scoped = await access.issue({ name: 'scoped operator', audience: 'operator', expiresAt: new Date(Date.now() + 120_000),
      grants: [{ actions: ['settings:read', 'settings:update', 'capabilities:read'], scope: { workspaceIds: ['other-workspace'] } }] })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'existing-device-mcp', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const ownerClient = await connect(owner.token), readerClient = await connect(reader.token), scopedClient = await connect(scoped.token)
    const toolNames = ['device_main_identity_get', 'devices_list', 'device_pairing_grant_create', 'device_revoke']
    expect((await ownerClient.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining(toolNames))
    const capability = decodeMcpToolResult((await ownerClient.callTool({ name: 'operator_get_capabilities', arguments: { detail: 'full' } }))) as { tools: string[]; requirements: Array<{ name: string; actions: string[] }> }
    expect(capability.tools).toEqual(expect.arrayContaining(toolNames))
    expect(capability.requirements.find(item => item.name === 'device_revoke')?.actions).toEqual(['settings:update'])
    expect((await readerClient.listTools()).tools.map(tool => tool.name)).not.toContain('device_revoke')
    expect((await scopedClient.listTools()).tools.map(tool => tool.name)).not.toContain('devices_list')
    const denied = await readerClient.callTool({ name: 'device_revoke', arguments: { deviceId: randomUUID(), expectedRevision: 1, commandId: randomUUID() } })
    expect(denied.isError).toBe(true)
    expect((await pool.query("select count(*)::int as count from management_audit where principal_id=$1 and source='mcp' and action='device_revoke' and outcome='denied'", [reader.principal.id])).rows[0].count).toBe(1)
    const publicMain = MainDeviceIdentityPublicSchema.parse(decodeMcpToolResult((await ownerClient.callTool({ name: 'device_main_identity_get', arguments: {} }))))
    expect(publicMain.mainId).toBe(mainId)
    expect(publicMain.mainPublicKeyFingerprint).toBe(mainIdentity.publicKeyFingerprint)
    const httpMain = await app.inject({ method: 'GET', url: '/api/devices/main', headers: { authorization: `Bearer ${reader.token}` } })
    expect(httpMain.statusCode).toBe(200)
    expect(httpMain.json()).toEqual(publicMain)
    const explicitInvalid = await app.inject({ method: 'GET', url: '/api/devices', headers: { authorization: 'Bearer invalid', cookie: `graphql_operator=${owner.token}` } })
    expect(explicitInvalid.statusCode).toBe(401)
    const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const grantInput = { workerInstallationId: randomUUID(), publicKey, expectedFingerprint: publicKeyFingerprint(publicKey), scopes: ['connect', 'heartbeat'], commandId: randomUUID() }
    const issued = DevicePairingGrantResultSchema.parse(decodeMcpToolResult((await ownerClient.callTool({ name: 'device_pairing_grant_create', arguments: grantInput }))))
    const httpReplay = await app.inject({ method: 'POST', url: '/api/devices/pairing-grants', headers: { authorization: `Bearer ${owner.token}` }, payload: grantInput })
    expect(httpReplay.statusCode).toBe(200)
    expect(httpReplay.json()).toEqual(issued)
    const pairing = { mainId, workerInstallationId: grantInput.workerInstallationId, publicKey, grant: issued.grant, requestId: randomUUID() }
    const paired = await devices.pair({ ...pairing, signature: sign(null, Buffer.from(pairingProof(pairing)), keys.privateKey).toString('base64url') })
    const readback = DeviceListResultSchema.parse(decodeMcpToolResult((await ownerClient.callTool({ name: 'devices_list', arguments: {} }))))
    expect(readback.devices).toEqual([paired.registration])
    expect(JSON.stringify(readback)).not.toContain(paired.credential)
    const httpRead = await app.inject({ method: 'GET', url: '/api/devices', headers: { authorization: `Bearer ${reader.token}` } })
    expect(httpRead.statusCode).toBe(200)
    expect(httpRead.json()).toEqual(readback)
    const revokeInput = { deviceId: paired.registration.deviceId, expectedRevision: 1, commandId: randomUUID() }
    const revoked = decodeMcpToolResult((await ownerClient.callTool({ name: 'device_revoke', arguments: revokeInput })))
    expect(revoked).toMatchObject({ status: 'revoked', authorizationRevision: 2 })
    const restart = new PostgresDeviceAccessService(pool, mainId)
    await expect(restart.authenticateDevice(paired.credential, 'connect')).rejects.toThrow()
    expect((await restart.list(owner.principal))[0]).toMatchObject(revoked as object)
    const httpRevokeReplay = await app.inject({ method: 'POST', url: '/api/devices/revoke', headers: { authorization: `Bearer ${owner.token}` }, payload: revokeInput })
    expect(httpRevokeReplay.statusCode).toBe(200)
    expect(httpRevokeReplay.json()).toEqual(revoked)
    await pool.query('update management_principals set revoked_at=now() where id=$1', [owner.principal.id])
    const stale = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${owner.token}`, accept: 'application/json, text/event-stream' }, payload: { jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'devices_list', arguments: {} } } })
    expect(stale.statusCode).toBe(401)
  } finally {
    await Promise.all(clients.map(client => client.close())); await app?.close(); await pool.end()
    await admin.query(`drop schema "${schema}" cascade`); await admin.end()
  }
})
