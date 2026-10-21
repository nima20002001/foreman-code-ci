import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { removeFixtureDirectory } from './helpers/testResources.js'
import { AppMcpRoutes } from '../src/modules/harnesses/appMcpRoutes.js'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { afterEach, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { createDatabase } from '../src/infrastructure/database.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { FoundationSettingsManagementService } from '../src/modules/settings/management.js'
import { registerAppRoute } from '../src/modules/harnesses/appMcpLauncher.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
it.each(['GRAPHQL_MCP_TOKEN', 'FOREMAN_CODE_MCP_TOKEN', 'both'])('routes %s for simultaneous instances and changed ports through authenticated MCP, preserving grants and durable writes', async (tokenVariable) => {
  const database = createDatabase({ connectionString: process.env.TEST_DATABASE_URL!,
    maxConnections: 4, connectionTimeoutMs: 5000, queryTimeoutMs: 5000 })
  cleanup.push(() => database.close())
  await database.migrate()
  const access = new PostgresAccessService(database.pool)
  const commands = new PostgresCommandCoordinator(database.pool)
  const settings = new FoundationSettingsManagementService(new PostgresFoundationSettingsRepository(database.pool), commands)
  const services = { settings, commands } as OperatorServices
  const directory = await mkdtemp(join(tmpdir(), 'operator-routing-'))
  cleanup.push(() => removeFixtureDirectory(directory))
  const launcher = join(directory, 'launcher.mjs')
  await copyFile(new URL('../../../scripts/graphql-mcp.mjs', import.meta.url), launcher)
  const issue = async (writable: boolean) => access.issue({ name: 'launcher-test', audience: 'operator',
    grants: [{ actions: writable ? ['settings:read', 'settings:update'] : ['settings:read'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
  const owner = await issue(true)
  const reader = await issue(false)
  cleanup.push(async () => {
    for (const principal of [owner.principal, reader.principal]) {
      await database.pool.query('delete from management_audit where principal_id=$1', [principal.id])
      await database.pool.query('delete from management_command_receipts where principal_id=$1', [principal.id])
      await database.pool.query('delete from management_principals where id=$1', [principal.id])
    }
  })
  const start = async () => {
    const app = buildApp({ readiness: { database, checkpoints: { ping: async () => undefined } }, operator: { access, services } })
    let requests = 0
    app.addHook('onRequest', async () => { requests++ })
    const endpoint = `${await app.listen({ host: '127.0.0.1', port: 0 })}/mcp`
    cleanup.push(() => app.close())
    return { app, endpoint, requests: () => requests }
  }
  const first = await start()
  const second = await start()
  expect(first.endpoint).not.toBe(second.endpoint)
  let removeOwner = await registerAppRoute(owner.token, first.endpoint, owner.principal.expiresAt, launcher)
  cleanup.push(() => removeOwner())
  const removeReader = await registerAppRoute(reader.token, second.endpoint, reader.principal.expiresAt, launcher)
  cleanup.push(removeReader)
  const connect = async (token: string) => {
    const client = new Client({ name: 'launcher-integration', version: '1' })
    cleanup.push(() => client.close())
    const environment = tokenVariable === 'both'
      ? { GRAPHQL_MCP_TOKEN: token, FOREMAN_CODE_MCP_TOKEN: token } : { [tokenVariable]: token }
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [launcher],
      env: environment, stderr: 'pipe' }))
    return client
  }
  const ownerClient = await connect(owner.token)
  expect(first.requests()).toBeGreaterThan(0)
  expect(second.requests()).toBe(0)
  const readerClient = await connect(reader.token)
  expect(second.requests()).toBeGreaterThan(0)
  const initial = decodeMcpToolResult((await ownerClient.callTool({ name: 'workspace_defaults_get', arguments: {} }))) as { revision: number; value: Record<string, unknown> }
  let value = { ...initial.value, description: `automatic routing ${randomUUID()}` }
  const saved = await ownerClient.callTool({ name: 'workspace_defaults_update', arguments: { commandId: randomUUID(), expectedRevision: initial.revision, value } })
  expect(saved.isError).not.toBe(true)
  const readback = await readerClient.callTool({ name: 'workspace_defaults_get', arguments: {} })
  expect(decodeMcpToolResult(readback)).toMatchObject({ value })
  expect(await settings.getWorkspaceDefaults(owner.principal)).toMatchObject({ value })
  const deniedUpdate = await readerClient.callTool({ name: 'workspace_defaults_update', arguments: {
    commandId: randomUUID(), expectedRevision: initial.revision + 1, value: initial.value,
  } })
  expect(deniedUpdate.isError).toBe(true)
  expect(JSON.stringify(deniedUpdate.content)).toContain('ACCESS_DENIED')
  const commandId = randomUUID()
  const uncertainValue = { ...value, description: `response lost ${randomUUID()}` }
  let writes = 0
  const proxy = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk.toString()
    const upstream = await fetch(second.endpoint, { method: 'POST', body,
      headers: { authorization: request.headers.authorization!, 'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': String(request.headers['mcp-protocol-version'] ?? '2025-03-26') },
    })
    await upstream.text()
    writes++
    // The real authenticated endpoint has finished committing before the reply is cut.
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"jsonrpc":"2.0","result":')
  })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => {
    proxy.closeAllConnections()
    await new Promise<void>(resolve => proxy.close(() => resolve()))
  })
  const proxyAddress = proxy.address()
  if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('Expected a TCP proxy')
  await removeOwner()
  removeOwner = await registerAppRoute(owner.token, `http://127.0.0.1:${proxyAddress.port}/mcp`, owner.principal.expiresAt, launcher)
  await expect(ownerClient.callTool({ name: 'workspace_defaults_update', arguments: {
    commandId, expectedRevision: initial.revision + 1, value: uncertainValue,
  } })).rejects.toThrow('Read back the original command')
  expect(writes).toBe(1)
  const persisted = await readerClient.callTool({ name: 'workspace_defaults_get', arguments: {} })
  expect(decodeMcpToolResult(persisted)).toMatchObject({ value: uncertainValue, revision: initial.revision + 2 })
  const receipt = await database.pool.query('select command_id from management_command_receipts where principal_id=$1 and command_id=$2',
    [owner.principal.id, commandId])
  expect(receipt.rows).toHaveLength(1)
  value = uncertainValue
  // The SAME launcher and client follow a refreshed owner route after a port change.
  await first.app.close()
  const removePredecessor = removeOwner
  removeOwner = await registerAppRoute(owner.token, second.endpoint, owner.principal.expiresAt, launcher)
  await removePredecessor()
  expect(decodeMcpToolResult((await ownerClient.callTool({ name: 'workspace_defaults_get', arguments: {} })))).toMatchObject({ value })
  for (const file of await readdir(join(directory, 'routes'))) {
    const text = await readFile(join(directory, 'routes', file), 'utf8')
    expect(text).not.toContain(owner.token)
    expect(text).not.toContain(reader.token)
  }
  await access.revoke(reader.principal.id)
  await expect(readerClient.callTool({ name: 'workspace_defaults_get', arguments: {} })).rejects.toThrow('authentication expired or was revoked')
  await removeOwner()
  await expect(ownerClient.callTool({ name: 'workspace_defaults_get', arguments: {} })).rejects.toThrow('route is unavailable')
  await removeReader()
  const restarted = new AppMcpRoutes(database.pool, second.endpoint, launcher)
  cleanup.push(() => restarted.close())
  await restarted.refresh()
  expect(decodeMcpToolResult((await ownerClient.callTool({ name: 'workspace_defaults_get', arguments: {} })))).toMatchObject({ value })
  await access.revoke(owner.principal.id)
  await restarted.refresh()
  const remaining = await readdir(join(directory, 'routes'))
  // Other integration fixtures may leave active root credentials in this DB.
  for (const token of [owner.token, reader.token]) expect(remaining).not.toContain(`${createHash('sha256').update(token).digest('hex')}.json`)
}, 30_000)

it('refuses conflicting launcher token aliases without exposing either credential', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'launcher-conflict-'))
  cleanup.push(() => removeFixtureDirectory(directory))
  const launcher = join(directory, 'launcher.mjs')
  await copyFile(new URL('../../../scripts/graphql-mcp.mjs', import.meta.url), launcher)
  const client = new Client({ name: 'launcher-conflict', version: '1' })
  cleanup.push(() => client.close())
  const transport = new StdioClientTransport({ command: process.execPath, args: [launcher],
    env: { GRAPHQL_MCP_TOKEN: 'old-private-token', FOREMAN_CODE_MCP_TOKEN: 'new-private-token' }, stderr: 'pipe' })
  let failure: unknown
  try { await client.connect(transport) } catch (error) { failure = error }
  expect(String(failure)).toContain('FOREMAN_CODE_MCP_TOKEN conflicts with GRAPHQL_MCP_TOKEN')
  expect(String(failure)).not.toContain('old-private-token')
  expect(String(failure)).not.toContain('new-private-token')
})
