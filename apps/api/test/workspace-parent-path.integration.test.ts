import { randomUUID } from 'node:crypto'
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import * as c from '@foreman-code/contracts/management'
import { expect, it } from 'vitest'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { HarnessDirectoryBrowser } from '../src/modules/harnesses/directoryBrowser.js'
import { callWorkspaceTool, workspaceMcpFixture } from './helpers/workspaceMcp.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

it('preserves browsed parent paths through HTTP and authenticated MCP, retries and persisted readback', async () => {
  const database = await migratedDatabase()
  const fixtureOptions = { connectionString: database.databaseUrl, database }
  let fixture: Awaited<ReturnType<typeof workspaceMcpFixture>> | undefined
  try {
    fixture = await workspaceMcpFixture(fixtureOptions)
  } catch (error) {
    await database.close()
    throw error
  }
  const f = fixture
  const directories = new HarnessDirectoryBrowser([f.parentPath], f.pool)
  try {
    const restricted = await f.issue([{ actions: ['workspaces:create'], scope: {} }])
    for (const siblingExists of [true, false]) {
      const name = siblingExists ? 'Selected' : 'Only selected'
      const selected = join(f.parentPath, name + ' ')
      await mkdir(selected)
      if (siblingExists) await mkdir(join(f.parentPath, name))
      const page = await directories.browse(f.owner.principal, {})
      const parentPath = page.directories.find(entry => entry.name === name + ' ')!.path
      expect(parentPath).toBe(selected)
      for (const source of ['http', 'mcp'] as const) {
        const input = { commandId: randomUUID(), parentPath, name: source + (siblingExists ? ' sibling' : ' only') }
        const create = async () => {
          if (source === 'mcp') return callWorkspaceTool(f.owner.client, 'workspace_create', c.ManagedWorkspaceCommandResultSchema, input)
          const response = await f.app.inject({ method: 'POST', url: '/api/management/workspaces',
            remoteAddress: '127.0.0.1', headers: { host: 'localhost' }, payload: input })
          expect([200, 201], response.body).toContain(response.statusCode)
          return c.ManagedWorkspaceCommandResultSchema.parse(response.json())
        }
        const created = await create()
        const expectedPath = join(selected, input.name)
        expect(created.value.executionLocation?.rootPath).toBe(expectedPath)
        expect(created.value.locationValidation.status).toBe('ready')
        expect((await create()).replayed).toBe(true)
        const read = await callWorkspaceTool(f.owner.client, 'workspace_get', c.ManagedWorkspaceSchema,
          { workspaceId: created.value.workspace.id })
        expect(read.executionLocation?.rootPath).toBe(expectedPath)
        const persisted = await database.pool.query<{ execution_location: { rootPath: string } }>(
          'select execution_location from workspaces where id=$1', [created.value.workspace.id])
        expect(persisted.rows).toEqual([{ execution_location: created.value.executionLocation }])
        expect(await readdir(selected)).toContain(input.name)
        if (siblingExists) expect(await readdir(join(f.parentPath, name))).toEqual([])
        await expectMcpAccessDenied(restricted.client.callTool({ name: 'workspace_create', arguments: {
          ...input, commandId: randomUUID(), name: 'Denied',
        } }))
        expect(await readdir(selected)).not.toContain('Denied')
      }
    }
    for (const parentPath of ['', 'relative/path', '/invalid\0path']) {
      const response = await f.app.inject({ method: 'POST', url: '/api/management/workspaces',
        remoteAddress: '127.0.0.1', headers: { host: 'localhost' }, payload: {
          commandId: randomUUID(), parentPath, name: 'Invalid',
        } })
      expect(response.statusCode).toBeGreaterThanOrEqual(400)
    }
  } finally {
    try { await f.close() } finally { await database.close() }
  }
}, 30_000)
