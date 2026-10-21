import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, expect, it, vi } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { HarnessMcpListResultSchema } from '@foreman-code/contracts/management'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { HarnessMcpSettingsService } from '../src/modules/harnesses/mcpSettings.js'
import { createInstalledWorkerManagedMcp } from '../src/modules/harnesses/installedWorkerManagedMcp.js'
import { createWorkerManagedMcpExtension } from '../src/modules/harnesses/workerManagedMcp.js'
import { DeviceManagedMcp } from '../src/modules/harnesses/deviceManagedMcp.js'
import { DomainError } from '../src/modules/errors.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { managedMcpNativeFixture } from './helpers/managedMcpNative.js'
import { managedMcpChannelFixture } from './helpers/managedMcpChannel.js'
import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'

vi.mock('../src/modules/harnesses/codexMcpConnections.js', async () => ({
  CodexMcpConnections: (await import('./helpers/managedMcpNative.js')).ManagedMcpCodexProcess,
}))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it.each(['consecutive listings', 'coded Worker failure', 'native Worker failure'] as const)(
  'handles %s through authenticated device Operator MCP', async scenario => {
  const f = await managedMcpNativeFixture()
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
  const schema = `device_mcp_list_${randomUUID().replaceAll('-', '')}`
  await createFixtureSchema(admin, schema)
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` })
  const mainId = randomUUID()
  const hostRef = { kind: 'device' as const, mainId, deviceId: randomUUID() }
  const binding = { mainId, deviceId: hostRef.deviceId, workerInstallationId: randomUUID(), keyRevision: 1,
    authorizationRevision: 1, connectionEpoch: randomUUID(), bootId: randomUUID(), connectionGeneration: 1 }
  const { worker } = createInstalledWorkerManagedMcp(f.options)
  const channel = managedMcpChannelFixture(binding, createWorkerManagedMcpExtension(worker, () => binding))
  const endpoint = { captureRequest: () => ({ binding,
    request: (payload: unknown) => channel.main.request('managed-mcp-v1', payload) }) }
  const access = new PostgresAccessService(pool)
  const commands = new PostgresCommandCoordinator(pool)
  const device = new DeviceManagedMcp(pool, mainId, () => endpoint, commands)
  const mcp = new HarnessMcpSettingsService(pool, commands, { codex: {
    read: async () => { throw new Error('Main must not be inspected') },
    apply: async () => { throw new Error('Main must not be changed') },
  } }, () => {}, async () => {}, 'https://app.test/mcp', device)
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, harnessSettings: { mcp, directories: {} },
      extensions: { workspace: {} } } as unknown as OperatorServices } })
  const clients: Client[] = []
  try {
    await applyApplicationMigrations(pool)
    const record = { mainId, deviceId: hostRef.deviceId, workerInstallationId: binding.workerInstallationId,
      keyRevision: 1, authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat'],
      publicKeyFingerprint: 'a'.repeat(64) }
    await pool.query(`insert into device_registrations(id,main_id,worker_installation_id,public_key,record)
      values($1,$2,$3,$4,$5::jsonb)`,
    [hostRef.deviceId, mainId, binding.workerInstallationId, 'fixture-public-key', JSON.stringify(record)])
    const reader = await access.issue({ name: 'Reader', audience: 'operator',
      grants: [{ actions: ['harnesses:read'], scope: {} }] })
    const denied = await access.issue({ name: 'Denied', audience: 'operator', grants: [] })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'device-mcp-list', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    const client = await connect(reader.token)
    const deniedClient = await connect(denied.token)
    const args = { name: 'harness_mcp_servers_list', arguments: { harness: 'codex', hostRef } }
    expect((await deniedClient.callTool(args)).isError).toBe(true)
    const list = async () => HarnessMcpListResultSchema.parse(decodeMcpToolResult(await client.callTool(args)))
    if (scenario === 'consecutive listings') {
      for (let request = 0; request < 2; request++) {
        const result = await list()
        expect(result).toMatchObject({ hostRef, harness: 'codex' })
        expect(result.servers.map(server => server.name)).toContain('example')
        expect(f.native.owners.size).toBe(0)
      }
    } else {
      const message = 'Codex could not list its native MCP connections.'
      const coded = scenario === 'coded Worker failure'
      f.native.failRead = coded ? new DomainError('MCP_CONFIG_UNAVAILABLE', message, 503) : new Error(message)
      const failed = await client.callTool(args)
      expect(failed.isError).toBe(true)
      expect(decodeMcpToolResult(failed)).toEqual({ error: {
        code: coded ? 'MCP_CONFIG_UNAVAILABLE' : 'MCP_OPERATION_FAILED', message,
      } })
    }
    expect((await list()).servers.map(server => server.name)).toContain('example')
    expect(f.native.owners.size).toBe(0)
    expect(f.writes()).toBe(0)
  } finally {
    await Promise.all(clients.map(client => client.close()))
    await app.close()
    await channel.close()
    await pool.end()
    await dropFixtureSchema(admin, schema)
    await admin.end()
    f.dispose()
    await rm(f.directory, { recursive: true, force: true })
  }
})
