import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { requirePrincipal } from '../src/modules/access/http.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresTrustedConnectionSetup } from '../src/modules/devices/trustedConnectionSetup.js'
import { registerTrustedConnectionRoutes } from '../src/modules/devices/trustedConnectionManagement.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import type { ManagementGrant } from '@foreman-code/contracts/management'

const url = process.env.TEST_DATABASE_URL
const grants: ManagementGrant[] = [{ actions: ['settings:read', 'settings:update'], scope: {} }]
const origin = 'http://127.0.0.1:5173'
const browser = { host: '127.0.0.1:3000', origin }
describe.skipIf(!url)('trusted connection configuration through authenticated MCP (PostgreSQL)', () => {
  let admin: pg.Pool, pool: pg.Pool, access: PostgresAccessService, app: ReturnType<typeof buildApp>, address: string
  let owner: Awaited<ReturnType<PostgresAccessService['issue']>>
  const schema = `connection_configuration_${randomUUID().replaceAll('-', '')}`, mainId = randomUUID(), clients: Client[] = []
  beforeAll(async () => {
    const parsed = new URL(url!)
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
      || !parsed.pathname.includes('test')) throw new Error('Explicit owned loopback test database required.')
    admin = new pg.Pool({ connectionString: url }); await createFixtureSchema(admin, schema)
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` })
    await applyApplicationMigrations(pool)
    access = new PostgresAccessService(pool)
    owner = await access.issue({ name: 'Owned test human', audience: 'operator', grants, expiresAt: new Date(Date.now() + 3_600_000) })
    await pool.query('update local_human_principal set principal_id=$1', [owner.principal.id])
    const setup = new PostgresTrustedConnectionSetup(pool, mainId)
    app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      localHuman: { current: () => access.currentOperator(owner.principal.id) }, browserOrigin: origin,
      operator: { access, services: { commands: new PostgresCommandCoordinator(pool), trustedConnections: setup } as unknown as OperatorServices } })
    registerTrustedConnectionRoutes(app, setup, async request => request.reauthorizeOperator ? request.reauthorizeOperator() : requirePrincipal(request))
    address = await app.listen({ host: '127.0.0.1', port: 0 })
  }, 60_000)
  afterAll(async () => {
    await Promise.allSettled(clients.map(client => client.close())); await app?.close(); await pool?.end()
    if (admin) { await dropFixtureSchema(admin, schema); await admin.end() }
  })
  async function delegate(actions = grants) {
    const issued = await access.issue({ name: 'Owned test Operator', audience: 'operator', grants: actions, expiresAt: new Date(Date.now() + 3_600_000) })
    const conversationId = randomUUID(), operatorId = randomUUID(), configurationId = randomUUID()
    await pool.query("insert into application_operators(id,current_configuration_version_id,record) values($1,$2,'{}')", [operatorId, configurationId])
    await pool.query("insert into operator_configuration_versions(id,operator_id,version,record) values($1,$2,1,'{}')", [configurationId, operatorId])
    await pool.query("insert into operator_conversations(id,kind,operator_id,operator_configuration_version_id,owner_principal_id,harness,record) values($1,'operator',$2,$3,$4,'codex','{\"status\":\"open\"}')", [conversationId, operatorId, configurationId, owner.principal.id])
    await pool.query('update management_principals set delegated_from=$2 where id=$1', [issued.principal.id, owner.principal.id])
    await pool.query('insert into operator_chat_credentials(principal_id,conversation_id) values($1,$2)', [issued.principal.id, conversationId])
    return { ...issued, conversationId }
  }
  async function fixture() {
    const deviceId = randomUUID(), registration = { mainId, deviceId, workerInstallationId: randomUUID(), keyRevision: 1,
      authorizationRevision: 1, publicKeyFingerprint: 'a'.repeat(64), scopes: ['connect', 'heartbeat'], status: 'paired' }
    await pool.query("insert into device_registrations(id,main_id,worker_installation_id,public_key,record) values($1,$2,$3,'owned SQL fixture public key',$4::jsonb)", [deviceId, mainId, registration.workerInstallationId, JSON.stringify(registration)])
    const input = { deviceId, commandId: randomUUID(), expectedRevision: 0,
      expectedAuthorizationRevision: 1, endpoint: { host: '192.0.2.10', port: 22, osUser: 'test-user', transport: 'lan' as const },
      hostKeyFingerprint: `SHA256:${'b'.repeat(43)}`, allowOwnerCommands: true }
    return { deviceId, input }
  }
  async function client(token: string) {
    const c = new Client({ name: 'connection-sql-acceptance', version: '1' }); clients.push(c)
    await c.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    return c
  }
  const count = async (id: string, operation: string) => (await pool.query('select count(*)::int as count from management_command_receipts where operation=$1 and target_key=$2', [operation, `${mainId}:${id}`])).rows[0].count
  it('lets a granted Operator configure and revoke directly with persisted MCP and HTTP readback', async () => {
    const d = await delegate()
    const f = await fixture()
    const c = await client(d.token)
    const applied = await c.callTool({ name: 'device_connection_configure', arguments: f.input })
    expect(applied.isError, JSON.stringify(applied.content)).not.toBe(true)
    const consent = decodeMcpToolResult(applied)
    expect(consent).toMatchObject({ revision: 1, allowOwnerCommands: true,
      grantsAgentPermissions: false, automaticSudo: false })
    expect(consent).not.toHaveProperty('approvalId')
    expect(decodeMcpToolResult(await c.callTool({ name: 'device_connection_configure', arguments: f.input }))).toEqual(consent)
    expect(await count(f.deviceId, 'device.trusted-connection.configure')).toBe(1)
    const audit = await pool.query("select source,outcome from management_audit where principal_id=$1 and action='device.trusted-connection.configure' and outcome='succeeded'", [d.principal.id])
    expect(audit.rows).toEqual([{ source: 'mcp', outcome: 'succeeded' }])
    const http = await app.inject({ method: 'POST', url: '/api/devices/connection-read', headers: browser, payload: { deviceId: f.deviceId } })
    expect(http.statusCode).toBe(200)
    expect(http.json().consent).toEqual(consent)
    expect(decodeMcpToolResult(await c.callTool({ name: 'device_connection_read', arguments: { deviceId: f.deviceId } }))).toEqual(http.json())
    const revoked = await c.callTool({ name: 'device_connection_configure', arguments: {
      ...f.input, commandId: randomUUID(), expectedRevision: 1, allowOwnerCommands: false,
    } })
    expect(revoked.isError).not.toBe(true)
    expect(decodeMcpToolResult(revoked)).toMatchObject({ revision: 2, allowOwnerCommands: false })
    expect(decodeMcpToolResult(await c.callTool({ name: 'device_connection_read', arguments: { deviceId: f.deviceId } })))
      .toMatchObject({ consent: decodeMcpToolResult(revoked) })
  })
  it('supports the device setup guide sequence with a denied reader and persisted Operator readback', async () => {
    const f = await fixture()
    const writer = await client((await delegate()).token)
    const reader = await client((await delegate([{ actions: ['settings:read'], scope: {} }])).token)
    const read = () => reader.callTool({ name: 'device_connection_read', arguments: { deviceId: f.deviceId } })
    expect(decodeMcpToolResult(await read())).toMatchObject({ consent: null })
    const denied = await reader.callTool({ name: 'device_connection_configure', arguments: f.input })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    expect(decodeMcpToolResult(await read())).toMatchObject({ consent: null })
    const saved = await writer.callTool({ name: 'device_connection_configure', arguments: f.input })
    expect(saved.isError, JSON.stringify(saved.content)).not.toBe(true)
    const consent = decodeMcpToolResult(saved)
    expect(consent).toMatchObject({ allowOwnerCommands: true, automaticSudo: false, grantsAgentPermissions: false })
    expect(consent).not.toHaveProperty('approvalId')
    expect(decodeMcpToolResult(await read())).toMatchObject({ consent })
  })

  it('lets the browser configure directly and denies invalid bearer credentials', async () => {
    const f = await fixture()
    const response = await app.inject({ method: 'POST', url: '/api/devices/connection-configure', headers: browser, payload: f.input })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({ revision: 1, allowOwnerCommands: true })
    const denied = await app.inject({ method: 'POST', url: '/api/devices/connection-configure', headers: { authorization: 'Bearer invalid-token' }, payload: f.input })
    expect(denied.statusCode).toBe(401)
  })
  it.each([
    { grants: [{ actions: ['settings:read'], scope: {} }] },
    { grants: [{ actions: ['settings:read', 'settings:update'], scope: { workspaceIds: ['other-workspace'] } }] },
  ] satisfies { grants: ManagementGrant[] }[])('denies MCP callers without a global update grant: %j', async ({ grants: restrictedGrants }) => {
    const f = await fixture()
    const restricted = await delegate(restrictedGrants)
    const c = await client(restricted.token)
    expect((await c.listTools()).tools.map(tool => tool.name)).not.toContain('device_connection_configure')
    const denied = await c.callTool({ name: 'device_connection_configure', arguments: f.input })
    expect(denied.isError).toBe(true)
    expect(await count(f.deviceId, 'device.trusted-connection.configure')).toBe(0)
    expect((await pool.query("select count(*)::int as count from management_audit where principal_id=$1 and action='device_connection_configure' and outcome='denied'", [restricted.principal.id])).rows[0].count).toBe(1)
  })
  it('keeps device and consent revision conflicts and changed-command rejection', async () => {
    const d = await delegate()
    const f = await fixture()
    const c = await client(d.token)
    const call = (input: Record<string, unknown>) => c.callTool({ name: 'device_connection_configure', arguments: input })
    const identityConflict = await call({ ...f.input, expectedAuthorizationRevision: 2 })
    expect(identityConflict.isError).toBe(true)
    expect(identityConflict.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('DEVICE_CONNECTION_CONFLICT') })]))
    expect((await call(f.input)).isError).not.toBe(true)
    const revisionConflict = await call({ ...f.input, commandId: randomUUID() })
    expect(revisionConflict.isError).toBe(true)
    expect(revisionConflict.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('DEVICE_CONNECTION_CONFLICT') })]))
    const changedCommand = await call({ ...f.input, allowOwnerCommands: false })
    expect(changedCommand.isError).toBe(true)
    expect(changedCommand.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('COMMAND_ID_CONFLICT') })]))
    expect(await count(f.deviceId, 'device.trusted-connection.configure')).toBe(1)
  })
  it.each(['grants', 'revoked', 'expired', 'closed'] as const)('denies a delegated Operator after %s changes', async change => {
    const d = await delegate()
    const f = await fixture()
    const c = await client(d.token)
    if (change === 'grants') await pool.query("update management_principals set grants='[]' where id=$1", [d.principal.id])
    if (change === 'revoked') await access.revoke(d.principal.id)
    if (change === 'expired') await pool.query("update management_principals set expires_at=now()-interval '1 second' where id=$1", [d.principal.id])
    if (change === 'closed') await pool.query("update operator_conversations set record=jsonb_set(record,'{status}','\"closed\"') where id=$1", [d.conversationId])
    try { expect((await c.callTool({ name: 'device_connection_configure', arguments: f.input })).isError).toBe(true) }
    catch (error) { expect(String(error)).toMatch(/401|403|revoked|expired|Unauthorized/i) }
    expect(await count(f.deviceId, 'device.trusted-connection.configure')).toBe(0)
  })
})
