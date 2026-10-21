import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { pairingProof, publicKeyFingerprint } from '@foreman-code/contracts/device-identity-node'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresDeviceAccessService } from '../src/modules/devices/access.js'
import { buildProductionApp } from '../src/production.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'

const origin = 'http://127.0.0.1:5173'
const browserHeaders = { host: '127.0.0.1:3000', origin }

async function fixture() {
  const db = await currentDatabase(), access = new PostgresAccessService(db.pool)
  const owner = await access.issue({ name: 'Existing installation owner', audience: 'operator',
    grants: [{ actions: ManagementActionSchema.options, scope: {} }], expiresAt: new Date(Date.now() + 3_600_000) })
  const config = loadConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL!, HARNESS_WORKSPACE_ROOT: join(db.directory, 'runtime'),
    CODEX_BINARY: '/unprovisioned-test-codex',
    FOREMAN_CODE_BROWSER_ORIGIN: origin })
  await db.pool.query('update local_human_principal set principal_id=$1', [owner.principal.id])
  config.workspaceStorageRoot = join(db.directory, 'workspaces')
  await mkdir(config.harnesses.workspaceRoot, { mode: 0o700 })
  const cpSchema = `${db.schema}_cp`
  await createFixtureSchema(db.pool, cpSchema)
  const checkpoints = createCheckpointStore(process.env.TEST_DATABASE_URL!, cpSchema, config.database)
  const clients: Client[] = []
  let production: ReturnType<typeof buildProductionApp> | undefined
  const close = async () => {
    try { await Promise.allSettled(clients.map(client => client.close())); await production?.shutdown() }
    finally {
      await checkpoints.close()
      await dropFixtureSchema(db.pool, cpSchema)
      await db.close()
    }
  }
  try {
    await checkpoints.setup()
    const build = () => buildProductionApp(config, { pool: db.pool, ping: async () => { await db.pool.query('select 1') },
      migrate: () => applyApplicationMigrations(db.pool), close: async () => {} }, checkpoints, false)
    production = build()
    await production.initialize()
    const app = production.app
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const auth = { authorization: `Bearer ${owner.token}` }
    // Pair through the original grant service and signed worker proof. Never insert an owner or consent record.
    const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const grant = await app.inject({ method: 'POST', url: '/api/devices/pairing-grants', headers: auth, payload: {
      workerInstallationId: randomUUID(), publicKey, expectedFingerprint: publicKeyFingerprint(publicKey),
      scopes: ['connect', 'heartbeat'], commandId: randomUUID(),
    } })
    expect(grant.statusCode, grant.body).toBe(200)
    const granted = grant.json(), pairing = { mainId: granted.registration.mainId,
      workerInstallationId: granted.registration.workerInstallationId, publicKey, grant: granted.grant, requestId: randomUUID() }
    const paired = await new PostgresDeviceAccessService(db.pool, pairing.mainId).pair({ ...pairing,
      signature: sign(null, Buffer.from(pairingProof(pairing)), keys.privateKey).toString('base64url') })
    const call = async (token: string) => {
      const client = new Client({ name: 'production trusted-connection readback', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const setup = async () => browserHeaders
    return { db, access, owner, get app() { return app }, auth, paired, setup, call, close }
  } catch (error) { await close(); throw error }
}

describe.skipIf(!postgresEnabled)('trusted connections through the production Main entrypoint', { timeout: 60_000 }, () => {
  it('opens an existing installation without login and preserves machine identities', async () => {
    const f = await fixture()
    try {
      const before = (await f.db.pool.query('select * from device_registrations')).rows
      const human = await f.app.inject({ url: '/api/local-human', headers: browserHeaders })
      expect(human.statusCode, human.body).toBe(200)
      expect(human.json().principal.id).toBe(f.owner.principal.id)
      expect(human.headers['set-cookie']).toBeUndefined()
      expect((await f.db.pool.query('select * from device_registrations')).rows).toEqual(before)
    } finally { await f.close() }
  })

  it('mounts direct HTTP and MCP configuration with denial and persisted readback', async () => {
    const f = await fixture()
    try {
      const browser = await f.setup(), deviceId = f.paired.registration.deviceId
      const read = await f.app.inject({ method: 'POST', url: '/api/devices/connection-read', headers: f.auth, payload: { deviceId } })
      expect(read.statusCode, read.body).toBe(200)
      expect(read.json()).toEqual({ registration: f.paired.registration, consent: null })
      const checked = await f.app.inject({ method: 'POST', url: '/api/devices/connection-check', headers: f.auth, payload: { deviceId } })
      expect(checked.statusCode, checked.body).toBe(200)
      expect(checked.json().state).toBe('consent-required')
      for (const [method, url] of [['GET', '/api/devices/connection-host'], ['POST', '/api/devices/connection-inspect']] as const) {
        expect(f.app.hasRoute({ method, url })).toBe(true)
      }
      const client = await f.call(f.owner.token)
      const tools = (await client.listTools()).tools.map(tool => tool.name)
      for (const suffix of ['host_discover', 'read', 'inspect', 'check', 'configure']) expect(tools).toContain(`device_connection_${suffix}`)
      expect(decodeMcpToolResult((await client.callTool({ name: 'device_connection_read', arguments: { deviceId } })))).toEqual(read.json())
      const outsider = await f.access.issue({ name: 'Denied scoped caller', audience: 'operator',
        grants: [{ actions: ['settings:read', 'settings:update'], scope: { workspaceIds: ['another-workspace'] } }], expiresAt: new Date(Date.now() + 600_000) })
      const reader = await f.access.issue({ name: 'Read-only caller', audience: 'operator',
        grants: [{ actions: ['settings:read'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
      expect((await f.app.inject({ method: 'POST', url: '/api/devices/connection-read',
        headers: { authorization: `Bearer ${outsider.token}` }, payload: { deviceId } })).statusCode).toBe(403)
      const deniedClient = await f.call(outsider.token), readerClient = await f.call(reader.token)
      expect((await deniedClient.callTool({ name: 'device_connection_read', arguments: { deviceId } })).isError).toBe(true)
      const input = { deviceId, commandId: randomUUID(), expectedRevision: 0,
        expectedAuthorizationRevision: 1, endpoint: { host: '192.0.2.10', port: 22, osUser: 'test-user', transport: 'lan' },
        hostKeyFingerprint: `SHA256:${'b'.repeat(43)}`, allowOwnerCommands: true }
      expect((await readerClient.callTool({ name: 'device_connection_configure', arguments: input })).isError).toBe(true)
      const applied = await client.callTool({ name: 'device_connection_configure', arguments: input })
      expect(applied.isError, JSON.stringify(applied.content)).not.toBe(true)
      expect(decodeMcpToolResult(applied)).toMatchObject({ revision: 1, automaticSudo: false, grantsAgentPermissions: false })
      expect(decodeMcpToolResult((await client.callTool({ name: 'device_connection_configure', arguments: input })))).toEqual(decodeMcpToolResult(applied))
      const persisted = await f.app.inject({ method: 'POST', url: '/api/devices/connection-read', headers: browser, payload: { deviceId } })
      expect(persisted.statusCode, persisted.body).toBe(200)
      expect(persisted.json().consent).toEqual(decodeMcpToolResult(applied))
      expect(decodeMcpToolResult((await client.callTool({ name: 'device_connection_read', arguments: { deviceId } })))).toEqual(persisted.json())
      const receipts = await f.db.pool.query("select result from management_command_receipts where operation='device.trusted-connection.configure' and command_id=$1", [input.commandId])
      expect(receipts.rows).toEqual([{ result: decodeMcpToolResult(applied) }])
      const audit = await f.db.pool.query("select outcome from management_audit where action='device.trusted-connection.configure'")
      expect(audit.rows.filter(row => row.outcome === 'succeeded')).toHaveLength(1)
      expect(audit.rows.filter(row => row.outcome === 'failed')).toHaveLength(0)
      const deniedAudit = await f.db.pool.query("select outcome from management_audit where action='device_connection_configure' and principal_id=$1", [reader.principal.id])
      expect(deniedAudit.rows).toEqual([{ outcome: 'denied' }])
    } finally { await f.close() }
  }, 120_000)
})
