import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, symlink, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as c from '@foreman-code/contracts/management'
import { expect, it } from 'vitest'
import { FoundationSettingsManagementService } from '../src/modules/settings/management.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { HarnessDirectoryBrowser } from '../src/modules/harnesses/directoryBrowser.js'
import { callWorkspaceTool, workspaceMcpFixture } from './helpers/workspaceMcp.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

it('selects home folders and symlinked projects through HTTP and authenticated MCP with persisted readback', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const selected = await mkdtemp(join(cache, 'selected-project-'))
  const f = await workspaceMcpFixture({ configureServices: async ({ services, parentPath, pool, commands }) => {
    services.settings = new FoundationSettingsManagementService(new PostgresFoundationSettingsRepository(pool, parentPath), commands)
    services.harnessSettings = { directories: new HarnessDirectoryBrowser([parentPath], pool) } as never
  } })
  try {
    const headers = { authorization: `Bearer ${f.owner.token}` }
    const link = join(f.parentPath, 'linked-project')
    await symlink(selected, link)
    const canonical = await realpath(selected)
    const page = await callWorkspaceTool(f.owner.client, 'workspace_folders_list',
      c.HarnessDirectoryBrowseResultSchema, { path: f.parentPath })
    expect(page.directories).toEqual(expect.arrayContaining([{ name: 'linked-project', path: link }]))
    for (const path of [selected, link]) {
      const http = await f.app.inject({ url: `/api/management/harnesses/directories?path=${encodeURIComponent(path)}`, headers })
      expect(http.statusCode).toBe(200)
      expect(c.HarnessDirectoryBrowseResultSchema.parse(http.json()).path).toBe(canonical)
      const mcp = await callWorkspaceTool(f.owner.client, 'workspace_folders_list', c.HarnessDirectoryBrowseResultSchema, { path })
      expect(mcp.path).toBe(canonical)
    }
    const home = await callWorkspaceTool(f.owner.client, 'workspace_folders_list', c.HarnessDirectoryBrowseResultSchema)
    expect(home.roots).toEqual(expect.arrayContaining([expect.objectContaining({ path: await realpath(homedir()) })]))
    const defaults = await callWorkspaceTool(f.owner.client, 'workspace_defaults_get', c.ManagedWorkspaceDefaultsSchema)
    const defaultInput = { value: { ...defaults.value, parentPath: link }, expectedRevision: defaults.revision,
      commandId: randomUUID() }
    const defaultsHttp = await f.app.inject({ method: 'PUT', url: '/api/management/settings/workspaces',
      headers, payload: defaultInput })
    expect(defaultsHttp.statusCode).toBe(200)
    const defaultsSaved = await callWorkspaceTool(f.owner.client, 'workspace_defaults_get', c.ManagedWorkspaceDefaultsSchema)
    expect(defaultsSaved.value.parentPath).toBe(canonical)
    expect(c.WorkspaceDefaultsUpdateResultSchema.parse(defaultsHttp.json()).value).toEqual(defaultsSaved)
    const deniedDefaults = await f.issue([{ actions: ['settings:read'], scope: {} }])
    await expectMcpAccessDenied(deniedDefaults.client.callTool({ name: 'workspace_defaults_update', arguments: {
      ...defaultInput, expectedRevision: defaultsSaved.revision, commandId: randomUUID(),
    } }))
    const workspace = await callWorkspaceTool(f.owner.client, 'workspace_create', c.ManagedWorkspaceCommandResultSchema,
      { name: 'Selected project', commandId: randomUUID() })
    const workspaceId = workspace.value.workspace.id
    const reader = await f.issue([{ actions: ['workspaces:read', 'workspace_locations:read', 'harnesses:read'], scope: {} }])
    const scoped = await f.issue([{ actions: ['workspaces:read', 'workspace_locations:update'],
      scope: { workspaceIds: ['other-workspace'] } }])
    for (const [index, rootPath] of [selected, link].entries()) {
      const input = { workspaceId, runnerId: 'runner-local', rootPath,
        expectedLocationRevision: index, commandId: randomUUID() }
      await expectMcpAccessDenied(reader.client.callTool({ name: 'workspace_location_set', arguments: input }))
      await expectMcpAccessDenied(scoped.client.callTool({ name: 'workspace_location_set', arguments: input }))
      const deniedHttp = await f.app.inject({ method: 'PUT', url: `/api/management/workspaces/${workspaceId}/location`,
        headers: { authorization: `Bearer ${reader.token}` }, payload: input })
      expect(deniedHttp.statusCode).toBe(403)
      if (index === 0) {
        const response = await f.app.inject({ method: 'PUT', url: `/api/management/workspaces/${workspaceId}/location`, headers, payload: input })
        expect(response.statusCode).toBe(200)
        expect(c.WorkspaceLocationSetResultSchema.parse(response.json()).value.executionLocation.rootPath).toBe(canonical)
      } else {
        const saved = await callWorkspaceTool(f.owner.client, 'workspace_location_set', c.WorkspaceLocationSetResultSchema, input)
        expect(saved.value.executionLocation.rootPath).toBe(canonical)
        expect((await callWorkspaceTool(f.owner.client, 'workspace_location_set', c.WorkspaceLocationSetResultSchema, input)).replayed).toBe(true)
      }
      const read = await callWorkspaceTool(f.owner.client, 'workspace_get', c.ManagedWorkspaceSchema, { workspaceId })
      expect(read.executionLocation?.rootPath).toBe(canonical)
      expect(read.locationRevision).toBe(index + 1)
      const persisted = await f.pool.query<{ execution_location: { rootPath: string }; location_revision: string }>(
        'select execution_location, location_revision from workspaces where id=$1', [workspaceId])
      expect(persisted.rows[0]?.execution_location.rootPath).toBe(canonical)
      expect(Number(persisted.rows[0]?.location_revision)).toBe(index + 1)
    }
    const conflict = await f.owner.client.callTool({ name: 'workspace_location_set', arguments: {
      workspaceId, runnerId: 'runner-local', rootPath: link, expectedLocationRevision: 0, commandId: randomUUID(),
    } })
    expect(conflict.isError).toBe(true)
    const deniedBrowse = await f.issue([{ actions: ['harnesses:read'], scope: {} }])
    await expectMcpAccessDenied(deniedBrowse.client.callTool({ name: 'workspace_folders_list', arguments: { path: selected } }))
    const deniedBrowseHttp = await f.app.inject({ url: `/api/management/harnesses/directories?path=${encodeURIComponent(selected)}`,
      headers: { authorization: `Bearer ${deniedBrowse.token}` } })
    expect(deniedBrowseHttp.statusCode).toBe(403)
    const creation = { parentPath: link, name: 'New project', commandId: randomUUID() }
    const created = await callWorkspaceTool(f.owner.client, 'workspace_folder_create', c.WorkspaceFolderCreateResultSchema, creation)
    expect(created.value.path).toBe(join(canonical, creation.name))
    expect(await readdir(selected)).toContain(creation.name)
    const renamed = await f.app.inject({ method: 'POST', url: '/api/management/harnesses/directories/rename', headers,
      payload: { path: created.value.path, name: 'Renamed project', commandId: randomUUID() } })
    expect(renamed.statusCode).toBe(200)
    const outsideDelete = await f.app.inject({ method: 'POST', url: '/api/management/harnesses/directories/delete',
      payload: { paths: [join(canonical, 'Renamed project')], commandId: randomUUID() } })
    expect(outsideDelete.statusCode).toBe(403)
    expect(outsideDelete.json().error.code).toBe('DIRECTORY_OUTSIDE_ROOT')
    expect(await readdir(selected)).toContain('Renamed project')
  } finally {
    await f.close()
    await rm(selected, { recursive: true, force: true })
  }
}, 30_000)
