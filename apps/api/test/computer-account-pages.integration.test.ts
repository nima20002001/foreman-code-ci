import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ComputerAccountsListSchema, COMPUTER_ACCOUNTS_NAMESPACE } from '@foreman-code/contracts/computer-accounts'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { ComputerAccountsService } from '../src/modules/computers/accounts.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('computer account pagination through HTTP and Operator MCP', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  const apps: ReturnType<typeof buildApp>[] = []
  const clients: Client[] = []
  beforeAll(async () => { database = await agent3Database() }, 60000)
  afterAll(async () => {
    await Promise.allSettled(clients.map(client => client.close()))
    await Promise.allSettled(apps.map(app => app.close()))
    await database?.close()
  })
  it('reads every persisted registration past the first 100, with the same pages and denied scope on both transports', async () => {
    const mainId = (await database.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
    const access = new PostgresAccessService(database.pool)
    const reader = await access.issue({ name: 'Accounts reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 3600000), grants: [{ actions: ['settings:read'], scope: {} }] })
    const denied = await access.issue({ name: 'No global settings read', audience: 'operator',
      expiresAt: new Date(Date.now() + 3600000),
      grants: [{ actions: ['settings:read'], scope: { workspaceIds: ['other'] } }] })
    const registrations = Array.from({ length: 105 }, () => ({ mainId, deviceId: randomUUID(),
      workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1, status: 'paired',
      scopes: ['connect', 'heartbeat'], publicKeyFingerprint: 'a'.repeat(64) }))
      .sort((a, b) => a.deviceId.localeCompare(b.deviceId))
    for (const registration of registrations) {
      await database.pool.query(`insert into device_registrations
        (id,main_id,worker_installation_id,public_key,record) values($1,$2,$3,'fixture',$4::jsonb)`,
      [registration.deviceId, mainId, registration.workerInstallationId, JSON.stringify(registration)])
    }
    const account = (name: string) => ({ observedAt: new Date().toISOString(), accounts: [{
      tool: 'github' as const, installed: true, signedIn: true, account: name, details: [],
    }] })
    const commands = new PostgresCommandCoordinator(database.pool)
    const computerAccounts = new ComputerAccountsService(database.pool, mainId, () => ({
      capabilities: () => [{ namespace: COMPUTER_ACCOUNTS_NAMESPACE, mainCanRequest: true }],
      request: async deviceId => ({ payload: account(deviceId) }),
    }), commands, async () => account('Main'))
    const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { computerAccounts, commands } as unknown as OperatorServices } })
    apps.push(app)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    async function connect(token: string) {
      const client = new Client({ name: 'accounts-pages-test', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
        { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
      return client
    }
    const client = await connect(reader.token)
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const result = await client.callTool({ name: 'computer_accounts_list', arguments: cursor ? { cursor } : {} })
      expect(result.isError).not.toBe(true)
      const page = ComputerAccountsListSchema.parse(decodeMcpToolResult(result))
      const query = cursor ? `?cursor=${cursor}` : ''
      const http = await app.inject({ url: `/api/management/computers/accounts${query}`,
        headers: { authorization: `Bearer ${reader.token}` } })
      expect(http.statusCode, http.body).toBe(200)
      expect(http.json()).toEqual(page)
      seen.push(...page.computers.map(computer => computer.target.hostRef.kind === 'main'
        ? 'Main' : computer.target.hostRef.deviceId))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(seen).toEqual(['Main', ...registrations.map(value => value.deviceId)])
    const ungranted = await connect(denied.token)
    expect((await ungranted.callTool({ name: 'computer_accounts_list',
      arguments: { cursor: registrations[99]!.deviceId } })).isError).toBe(true)
    expect((await app.inject({ url: `/api/management/computers/accounts?cursor=${registrations[99]!.deviceId}`,
      headers: { authorization: `Bearer ${denied.token}` } })).statusCode).toBe(403)
  })
})
