import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { HarnessDirectoryBrowseResultSchema } from '@foreman-code/contracts/management'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { HarnessDirectoryBrowser } from '../src/modules/harnesses/directoryBrowser.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { agent3Database } from './helpers/wave25Agent3.js'

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  opendir: async () => (async function* () {
    for (let index = 0; index < 20_001; index++) {
      yield { name: `folder-${String(index).padStart(5, '0')}`, isDirectory: () => true }
    }
  })(),
}))

it('returns partial large-directory listings over authenticated MCP with grant checks', async () => {
  const database = await agent3Database()
  const directory = await mkdtemp(`${process.env.FOREMAN_CODE_TEST_ROOT}/partial-directory-`)
  await mkdir(join(directory, 'child'))
  const access = new PostgresAccessService(database.pool)
  const services = { commands: new PostgresCommandCoordinator(database.pool), harnessSettings: {
    directories: new HarnessDirectoryBrowser([directory], database.pool),
  } } as unknown as OperatorServices
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services } })
  const clients: Client[] = []
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (actions: ('harnesses:read' | 'workspace_locations:read')[]) => {
      const issued = await access.issue({ name: 'Directory caller', audience: 'operator',
        grants: [{ actions, scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
      const client = new Client({ name: 'directory-test', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => issued.token },
      }))
      return client
    }
    const allowed = await connect(['harnesses:read', 'workspace_locations:read'])
    const denied = await connect(['harnesses:read'])
    const list = async (cursor?: string) => HarnessDirectoryBrowseResultSchema.parse(decodeMcpToolResult(
      await allowed.callTool({ name: 'workspace_folders_list', arguments: { path: directory, ...(cursor ? { cursor } : {}) } })))
    const first = await list()
    expect(first).toMatchObject({ truncated: true, path: directory, nextCursor: 'folder-00099' })
    expect(first.directories).toHaveLength(100)
    expect(first.directories[0]).toEqual({ name: 'folder-00000', path: join(directory, 'folder-00000') })
    expect(await list(first.nextCursor!)).toMatchObject({ truncated: true, nextCursor: 'folder-00199' })
    const deniedResult = await denied.callTool({ name: 'workspace_folders_list', arguments: { path: directory } })
    expect(deniedResult.isError).toBe(true)
    expect(JSON.stringify(deniedResult.content)).toContain('ACCESS_DENIED')
    const outside = await allowed.callTool({ name: 'workspace_folders_list', arguments: { path: join(directory, '..') } })
    expect(outside.isError).not.toBe(true)
    expect(HarnessDirectoryBrowseResultSchema.parse(decodeMcpToolResult(outside)).path).toBe(resolve(directory, '..'))
  } finally {
    await Promise.all(clients.map(client => client.close()))
    await app.close()
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
})
