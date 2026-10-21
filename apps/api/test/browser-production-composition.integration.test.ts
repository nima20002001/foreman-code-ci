import { randomUUID } from 'node:crypto'
import { BrowserProfileSchema, BrowserOperationResponseSchemas } from '@foreman-code/contracts'
import WebSocket from 'ws'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { createBrowserProfileRepository } from '../src/modules/browser-profiles/repository.js'
import { access, address, database, production, registerProductionLifecycleFixture } from './helpers/productionLifecycleFixture.js'

registerProductionLifecycleFixture()

it('registers browser profile persistence in the application migration chain', async () => {
  const repository = createBrowserProfileRepository(database.pool)
  await expect(repository.read(tx => tx.catalogRevision())).resolves.toBe(0)
})

it('exposes the production browser catalog over authenticated HTTP and MCP with denied callers', async () => {
  const owner = await access.issue({ name: 'Browser profile owner', audience: 'operator',
    grants: [{ actions: ['settings:read', 'settings:update', 'agent_chat:read', 'agent_chat:write', 'capabilities:read'], scope: {} }] })
  const reader = new Client({ name: 'Browser composition client', version: '1' })
  const denied = new Client({ name: 'Denied browser client', version: '1' })
  try {
    await reader.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => owner.token },
    }))
    expect((await reader.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'browser_profiles_list', 'browser_profile_create', 'browser_sessions_list', 'browser_view_open', 'browser_control_release',
    ]))
    const listed = await reader.callTool({ name: 'browser_profiles_list', arguments: {} })
    expect(listed.isError, JSON.stringify(listed)).not.toBe(true)
    expect(decodeMcpToolResult(listed)).toMatchObject({ profiles: [], replicas: [], presentReplicas: [], pendingReplicas: [] })
    const http = await production.app.inject({ url: '/api/browser/profiles',
      headers: { authorization: `Bearer ${owner.token}` } })
    expect(http.statusCode, http.body).toBe(200)
    expect(http.json()).toEqual(decodeMcpToolResult(listed))
    const main = await production.app.inject({ url: '/api/devices/main', headers: { authorization: `Bearer ${owner.token}` } })
    expect(main.statusCode, main.body).toBe(200)
    const create = { name: 'Shared review profile', computerId: main.json().mainId, distribution: 'shared', commandId: randomUUID() }
    const created = await reader.callTool({ name: 'browser_profile_create', arguments: create })
    expect(created.isError, JSON.stringify(created)).not.toBe(true)
    const receipt = BrowserOperationResponseSchemas.browser_profile_create.parse(decodeMcpToolResult(created))
    const profile = BrowserProfileSchema.parse(receipt.value)
    expect(profile).toMatchObject({ name: create.name, sourceComputerId: create.computerId, distribution: 'shared' })
    expect(decodeMcpToolResult(await reader.callTool({ name: 'browser_profile_create', arguments: create })))
      .toMatchObject({ value: profile, replayed: true })
    const persisted = await production.app.inject({ url: `/api/browser/profiles/${profile.id}`, headers: { authorization: `Bearer ${owner.token}` } })
    expect(persisted.statusCode, persisted.body).toBe(200)
    expect(persisted.json()).toMatchObject({ profile })
    const stranger = await access.issue({ name: 'Unrelated browser caller', audience: 'operator',
      grants: [{ actions: ['workspaces:read'], scope: {} }] })
    await denied.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => stranger.token },
    }))
    expect((await denied.callTool({ name: 'browser_profiles_list', arguments: {} })).isError).toBe(true)
    expect((await denied.callTool({ name: 'browser_profile_create', arguments: { ...create, commandId: randomUUID() } })).isError).toBe(true)
    expect(decodeMcpToolResult(await reader.callTool({ name: 'browser_profile_get', arguments: { profileId: profile.id } }))).toMatchObject({ profile })
  } finally {
    await denied.close()
    await reader.close()
  }
})

it('mounts the browser viewer channel and rejects stale installation handshakes', async () => {
  const owner = await access.issue({ name: 'Browser viewer', audience: 'operator',
    grants: [{ actions: ['settings:read'], scope: {} }] })
  const url = new URL('/api/browser/sessions/unknown/view', address); url.protocol = 'ws:'
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${owner.token}` } })
  try {
    const code = await new Promise<number>((resolve, reject) => {
      socket.once('error', reject)
      socket.once('open', () => socket.send(JSON.stringify({ viewId: 'unknown', installationId: 'stale-installation' })))
      socket.once('close', resolve)
    })
    expect(code).toBe(1008)
  } finally { socket.terminate() }
})

it('queues a profile for an offline paired computer without requiring another database connection', async () => {
  const owner = await access.issue({ name: 'Offline profile owner', audience: 'operator',
    grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }] })
  const main = await production.app.inject({ url: '/api/devices/main', headers: { authorization: `Bearer ${owner.token}` } })
  const deviceId = randomUUID(), installationId = randomUUID(), mainId = main.json().mainId
  await database.pool.query(`insert into device_registrations(id,main_id,worker_installation_id,public_key,record)
    values($1,$2,$3,$4,$5::jsonb)`, [deviceId, mainId, installationId, 'fixture-public-key', JSON.stringify({
    mainId, deviceId, workerInstallationId: installationId, publicKeyFingerprint: 'b'.repeat(64), keyRevision: 1,
    authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat', 'metrics:report'],
  })])
  const client = new Client({ name: 'Offline browser client', version: '1' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => owner.token } }))
    const created = await client.callTool({ name: 'browser_profile_create', arguments: {
      name: 'Offline profile', computerId: deviceId, commandId: randomUUID(),
    } })
    expect(created.isError, JSON.stringify(created)).not.toBe(true)
    const receipt = BrowserOperationResponseSchemas.browser_profile_create.parse(decodeMcpToolResult(created))
    const profile = BrowserProfileSchema.parse(receipt.value)
    const read = decodeMcpToolResult(await client.callTool({ name: 'browser_profile_get', arguments: { profileId: profile.id } }))
    expect(read).toMatchObject({ profile, operations: [{ installationId, computerId: deviceId, operation: 'create', state: 'queued' }] })
  } finally { await client.close() }
})
