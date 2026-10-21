import { randomUUID } from 'node:crypto'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import * as contracts from '@foreman-code/contracts/management'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { callWorkspaceTool, workspaceMcpFixture } from './helpers/workspaceMcp.js'
import { WorkspaceProjectProvisioning } from '../src/modules/workspaces/projectProvisioning.js'

afterEach(() => vi.restoreAllMocks())

describe('workspace project folder compensation through authenticated MCP', () => {
  it('retains a committed project folder after lost acknowledgement and replays the same workspace', async () => {
    const f = await workspaceMcpFixture()
    try {
      const input = { commandId: randomUUID(), parentPath: f.parentPath, name: 'Acknowledged on retry' }
      const query = pg.Client.prototype.query as unknown as
        (this: pg.Client, ...args: unknown[]) => Promise<pg.QueryResult>
      const creatingClients = new WeakSet<pg.Client>()
      let loseAcknowledgement = true
      vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: unknown[]) {
        const sql = args[0]
        const values = args[1] as unknown[] | undefined
        if (typeof sql === 'string' && sql.includes('insert into management_command_receipts')
          && values?.[2] === input.commandId) creatingClients.add(this)
        const response = query.apply(this, args)
        if (sql === 'commit' && creatingClients.has(this) && loseAcknowledgement) {
          loseAcknowledgement = false
          return response.then(() => { throw new Error('Commit acknowledgement lost') })
        }
        return response
      } as never)
      const failed = await f.owner.client.callTool({ name: 'workspace_create', arguments: input })
      expect(failed.isError, JSON.stringify(failed)).toBe(true)
      expect(JSON.stringify(failed)).toContain('INTERNAL_ERROR')
      vi.restoreAllMocks()
      const directory = join(f.parentPath, input.name)
      expect((await stat(directory)).isDirectory()).toBe(true)
      const persisted = (await f.pool.query('select id from workspaces')).rows
      expect(persisted).toHaveLength(1)
      const replayed = await callWorkspaceTool(f.owner.client, 'workspace_create', contracts.ManagedWorkspaceCommandResultSchema, input)
      expect(replayed.replayed).toBe(true)
      expect(replayed.value.workspace.id).toBe(persisted[0].id)
      const readback = await callWorkspaceTool(f.owner.client, 'workspace_get', contracts.ManagedWorkspaceSchema,
        { workspaceId: replayed.value.workspace.id })
      expect(readback.executionLocation?.rootPath).toBe(directory)
      expect(readback.locationValidation.status).toBe('ready')
      expect(await readdir(f.parentPath)).toEqual([input.name])
    } finally {
      vi.restoreAllMocks()
      await f.close()
    }
  }, 30_000)

  it('denies creation without provisioning grants and creates neither workspace nor directory', async () => {
    const f = await workspaceMcpFixture()
    try {
      const caller = await f.issue([{ actions: ['workspaces:create'], scope: {} }])
      const input = { commandId: randomUUID(), name: 'Denied project', parentPath: f.parentPath }
      const denied = await caller.client.callTool({ name: 'workspace_create', arguments: input })
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied)).toContain('ACCESS_DENIED')
      expect(await readdir(f.parentPath)).toEqual([])
      const listed = await callWorkspaceTool(f.owner.client, 'workspace_list', contracts.ManagedWorkspacePageSchema,
        { detail: 'full' })
      expect(listed.items).toEqual([])
      expect((await f.pool.query('select count(*)::int as count from management_command_receipts where command_id = $1',
        [input.commandId])).rows[0].count).toBe(0)
    } finally { await f.close() }
  }, 30_000)

  it('preserves an empty destination created between validation and publication', async () => {
    const f = await workspaceMcpFixture()
    try {
      const name = 'Racing project'
      const destination = join(f.parentPath, name)
      let destinationIdentity: Awaited<ReturnType<typeof stat>> | undefined
      const create = WorkspaceProjectProvisioning.prototype.create
      vi.spyOn(WorkspaceProjectProvisioning.prototype, 'create').mockImplementation(async function (
        this: WorkspaceProjectProvisioning, rootPath, owner,
      ) {
        if (rootPath === destination) {
          await mkdir(destination)
          destinationIdentity = await stat(destination)
        }
        return create.call(this, rootPath, owner)
      })
      const result = await f.owner.client.callTool({ name: 'workspace_create', arguments: {
        commandId: randomUUID(), name, parentPath: f.parentPath,
      } })
      expect(result.isError, JSON.stringify(result)).toBe(true)
      expect(JSON.stringify(result)).toContain('WORKSPACE_FOLDER_EXISTS')
      expect(await stat(destination)).toMatchObject({ dev: destinationIdentity!.dev, ino: destinationIdentity!.ino })
      expect(await readdir(f.parentPath)).toEqual([name])
      expect((await f.pool.query('select id from workspace_project_provisioning')).rows).toEqual([])
      expect((await f.pool.query('select id from workspaces')).rows).toEqual([])
    } finally {
      vi.restoreAllMocks()
      await f.close()
    }
  }, 30_000)
})
