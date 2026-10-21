import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { HarnessMcpListResultSchema, HarnessMcpPlanSchema } from '@foreman-code/contracts/management'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { HarnessMcpSettingsService } from '../src/modules/harnesses/mcpSettings.js'
import { WorkerManagedMcp, createWorkerManagedMcpExtension } from '../src/modules/harnesses/workerManagedMcp.js'
import { DeviceManagedMcp } from '../src/modules/harnesses/deviceManagedMcp.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { deviceManagedMcpFixture } from './helpers/deviceManagedMcp.js'
import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { appLauncherConnection } from '../src/modules/harnesses/appMcpLauncher.js'
import { nativeConnection } from '../src/modules/harnesses/nativeMcpCommon.js'

it('applies paired-device MCP through authenticated Operator MCP with denial, retries and persisted readback', async () => {
  const f = await deviceManagedMcpFixture()
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
  const schema = `device_mcp_${randomUUID().replaceAll('-', '')}`
  await createFixtureSchema(admin, schema)
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` })
  const mainId = randomUUID()
  const hostRef = { kind: 'device' as const, mainId, deviceId: randomUUID() }
  const binding = { mainId, deviceId: hostRef.deviceId, workerInstallationId: randomUUID(), keyRevision: 1,
    authorizationRevision: 1, connectionEpoch: randomUUID(), bootId: randomUUID(), connectionGeneration: 1 }
  const worker = new WorkerManagedMcp({ directory: f.directory, adapters: f.adapters, installLauncher: async () => {} })
  const extension = createWorkerManagedMcpExtension(worker, () => binding)
  const endpoint = { captureRequest: () => ({ binding, request: async (payload: unknown) =>
    extension.handle!(payload, { binding, signal: AbortSignal.timeout(5000) }) }) }
  const access = new PostgresAccessService(pool)
  const commands = new PostgresCommandCoordinator(pool)
  const device = new DeviceManagedMcp(pool, mainId, () => endpoint, commands)
  const mcp = new HarnessMcpSettingsService(pool, commands, { codex: { read: async () => { throw new Error('Main must not be inspected') },
      apply: async () => { throw new Error('Main must not be changed') } } }, () => {},
    async () => {}, 'https://app.test/mcp', device)
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, harnessSettings: { mcp, directories: {} }, extensions: { workspace: {} } } as unknown as OperatorServices } })
  const clients: Client[] = []
  try {
    await applyApplicationMigrations(pool)
    await pool.query(`insert into device_registrations(id,main_id,worker_installation_id,public_key,record) values($1,$2,$3,$4,$5::jsonb)`,
      [hostRef.deviceId, mainId, binding.workerInstallationId, 'fixture-public-key', JSON.stringify({ mainId, deviceId: hostRef.deviceId, workerInstallationId: binding.workerInstallationId,
        keyRevision: 1, authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat'],
        publicKeyFingerprint: 'a'.repeat(64) })])
    const writer = await access.issue({ name: 'Operator', audience: 'operator',
      grants: [{ actions: ['harnesses:read', 'harnesses:update', 'workspace_locations:read'], scope: {} }], expiresAt: new Date(Date.now() + 3600_000) })
    const reader = await access.issue({ name: 'Reader', audience: 'operator',
      grants: [{ actions: ['harnesses:read'], scope: {} }], expiresAt: new Date(Date.now() + 3600_000) })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'device-mcp', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const client = await connect(writer.token)
    const denied = await connect(reader.token)
    const args = { harness: 'codex', hostRef, preset: 'graphql', installed: true, commandId: randomUUID() }
    expect((await denied.callTool({ name: 'harness_mcp_managed_request', arguments: args })).isError).toBe(true)
    expect(f.writes()).toBe(0)
    const call = async () => HarnessMcpPlanSchema.parse(decodeMcpToolResult(
      await client.callTool({ name: 'harness_mcp_managed_request', arguments: args })))
    const applied = await call()
    expect(applied).toMatchObject({ hostRef, status: 'applied' })
    expect(await call()).toEqual(applied)
    expect(f.writes()).toBe(1)
    const readback = HarnessMcpListResultSchema.parse(decodeMcpToolResult(await client.callTool({
      name: 'harness_mcp_servers_list', arguments: { harness: 'codex', hostRef },
    })))
    expect(readback).toMatchObject({ hostRef, presets: { graphql: 'installed' } })
    expect(readback.servers.map(server => server.name)).toContain('example')
    const legacy = nativeConnection({ ...appLauncherConnection(), environmentVariables: ['GRAPHQL_MCP_TOKEN'] })
    await writeFile(join(f.directory, 'codex.json'), JSON.stringify({
      graphql: { ...legacy, disabled_tools: ['interaction_respond'] },
      example: { url: 'https://example.test/mcp' },
    }))
    const detectionArgs = { workspaceId: 'fixture-workspace', harness: 'codex', hostRef }
    const legacyDetection = decodeMcpToolResult(await client.callTool({
      name: 'harness_mcp_detection_get', arguments: detectionArgs,
    }))
    expect(legacyDetection).toMatchObject({ detection: { serverName: 'graphql',
      credentialEnvironmentVariable: 'GRAPHQL_MCP_TOKEN', state: 'status_unavailable' } })
    await worker.ensureReady(['codex'])
    const migrated = HarnessMcpListResultSchema.parse(decodeMcpToolResult(await client.callTool({
      name: 'harness_mcp_servers_list', arguments: { harness: 'codex', hostRef },
    })))
    expect(migrated.servers.map(server => server.name)).toEqual(['example', 'foreman-code'])
    expect(migrated.presets).toMatchObject({ graphql: 'installed' })
    const native = await f.adapters.codex.read(AbortSignal.timeout(5000))
    expect(native.user['foreman-code']).toMatchObject({ env_vars: ['FOREMAN_CODE_MCP_TOKEN'],
      disabled_tools: ['interaction_respond'] })
    await worker.ensureReady(['codex'])
    expect(f.writes()).toBe(2)
    expect((await denied.callTool({ name: 'harness_mcp_detection_get', arguments: detectionArgs })).isError).toBe(true)
    const detection = decodeMcpToolResult(await client.callTool({
      name: 'harness_mcp_detection_get', arguments: detectionArgs,
    }))
    expect(detection).toMatchObject({ detection: { serverName: 'foreman-code', state: 'status_unavailable',
      credentialEnvironmentVariable: 'FOREMAN_CODE_MCP_TOKEN' }, runnerId: hostRef.deviceId })
    const stored = await pool.query('select host_ref,status from harness_mcp_change_plans where id=$1', [applied.id])
    expect(stored.rows).toEqual([{ host_ref: hostRef, status: 'applied' }])
    const audit = await pool.query('select target_key from management_audit where action=$1 and outcome=$2',
      ['harness.mcp.managed.device', 'succeeded'])
    expect(audit.rows).toEqual([{ target_key: `harness-mcp:${mainId}:${hostRef.deviceId}:codex` }])
  } finally {
    await Promise.all(clients.map(client => client.close()))
    await app.close()
    await pool.end()
    await dropFixtureSchema(admin, schema)
    await admin.end()
    await rm(f.directory, { recursive: true, force: true })
  }
})
