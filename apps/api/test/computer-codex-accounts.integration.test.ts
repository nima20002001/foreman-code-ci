import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { ComputerAccountsListSchema } from '@foreman-code/contracts/computer-accounts'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { probeComputerAccounts, systemPorts, type AccountProbePorts } from '../src/modules/computers/accountProbe.js'
import { ComputerAccountsService } from '../src/modules/computers/accounts.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'

it.skipIf(!postgresEnabled)('reads passive Codex account state through authenticated MCP', async () => {
  const database = await agent3Database()
  const mainId = (await database.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
  const target = { hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
    keyRevision: null, authorizationRevision: null }
  const authPath = join(database.directory, 'auth.json')
  const local = systemPorts({ CODEX_HOME: database.directory })
  let unreadable = false
  const run = vi.fn<AccountProbePorts['run']>()
  const probe: AccountProbePorts = {
    ...local,
    find: async name => name === 'codex' ? '/fixture/codex' : null,
    run,
    readText: async path => {
      if (unreadable) throw new Error('Access denied')
      return local.readText(path)
    },
  }
  const access = new PostgresAccessService(database.pool)
  const commands = new PostgresCommandCoordinator(database.pool)
  const accounts = new ComputerAccountsService(database.pool, mainId, () => undefined, commands,
    () => probeComputerAccounts(probe))
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { computerAccounts: accounts, commands } as unknown as OperatorServices } })
  const clients: Client[] = []
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const reader = await access.issue({ name: 'Codex accounts reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 3_600_000), grants: [{ actions: ['settings:read'], scope: {} }] })
    const denied = await access.issue({ name: 'Scoped accounts reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 3_600_000),
      grants: [{ actions: ['settings:read'], scope: { workspaceIds: ['other'] } }] })
    const connect = async (token: string) => {
      const client = new Client({ name: 'codex-accounts-test', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
        { authProvider: { token: async () => token } }))
      return client
    }
    const client = await connect(reader.token)
    const read = async () => {
      const response = await client.callTool({ name: 'computer_accounts_list', arguments: { target, refresh: true } })
      expect(response.isError).not.toBe(true)
      return ComputerAccountsListSchema.parse(decodeMcpToolResult(response))
    }
    const codex = (result: Awaited<ReturnType<typeof read>>) => result.computers[0]!.accounts!.accounts[0]
    const unknown = { tool: 'codex', installed: true, signedIn: null, account: null, details: [] }
    expect(codex(await read())).toEqual(unknown)
    unreadable = true
    const unavailable = await read()
    expect(unavailable).toEqual({ computers: [{ target, accounts: null }], nextCursor: null })
    const unavailableHttp = await app.inject({ method: 'POST', url: '/api/management/computers/accounts/read',
      headers: { authorization: `Bearer ${reader.token}` }, payload: { target, refresh: true } })
    expect(unavailableHttp.statusCode).toBe(200)
    expect(ComputerAccountsListSchema.parse(unavailableHttp.json())).toEqual(unavailable)
    unreadable = false
    const ungranted = await connect(denied.token)
    expect((await ungranted.callTool({ name: 'computer_accounts_list', arguments: { target } })).isError).toBe(true)
    expect(codex(await read())).toEqual(unknown)

    const payload = Buffer.from(JSON.stringify({ email: 'coder@example.com' })).toString('base64url')
    await writeFile(authPath, JSON.stringify({ tokens: {
      id_token: `header.${payload}.signature`, refresh_token: 'fixture-secret',
    } }))
    const persisted = await read()
    expect(codex(persisted)).toEqual({
      tool: 'codex', installed: true, signedIn: true, account: 'coder@example.com', details: ['ChatGPT'],
    })
    const http = await app.inject({ method: 'POST', url: '/api/management/computers/accounts/read',
      headers: { authorization: `Bearer ${reader.token}` }, payload: { target } })
    expect(http.statusCode).toBe(200)
    const httpReadback = ComputerAccountsListSchema.parse(http.json())
    expect(httpReadback.computers[0]?.accounts?.accounts).toEqual(persisted.computers[0]?.accounts?.accounts)
    expect(httpReadback.computers[0]?.target).toEqual(target)
    expect(JSON.stringify(persisted)).not.toMatch(/fixture-secret|signature|auth\.json/)
    expect(run).not.toHaveBeenCalled()
  } finally {
    await Promise.allSettled(clients.map(client => client.close()))
    await app.close()
    await database.close()
  }
}, 60_000)
