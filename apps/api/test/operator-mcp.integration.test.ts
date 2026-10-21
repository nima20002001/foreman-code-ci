import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { removeFixtureDirectory } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CURRENT_WORKFLOW_TOOLS, CurrentWorkflowSaveResultSchema } from '@foreman-code/contracts/wave25'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'

function value(result: { isError?: boolean | undefined; structuredContent?: unknown }) {
  // SDK optional properties can be present with undefined. Success retains its
  // structured body; an error's text-only envelope is diagnostic, not success.
  expect(result.isError, JSON.stringify(result)).not.toBe(true)
  return decodeMcpToolResult(result) as Record<string, unknown>
}
afterEach(() => vi.restoreAllMocks())
describe.skipIf(!postgresEnabled)('Operator MCP current PostgreSQL integration', () => {
  it('keeps persisted edits and denial auditing fresh for a warmed caller after its grants change', async () => {
    const f = await currentOperatorIntegration()
    try {
      const created = value(await f.client.callTool({ name: 'workspace_create', arguments: {
        commandId: randomUUID(), name: 'Registration cache fixture',
      } })).value as { workspace: { id: string }; revision: number }
      const workspaceId = created.workspace.id
      const credential = await f.access.issue({
        name: 'Scoped editor', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
        grants: [{ actions: ['workspaces:read', 'workspaces:update', 'workspace_locations:read'],
          scope: { workspaceIds: [workspaceId] } }],
      })
      const editor = await f.connect(credential.token)
      expect((await editor.listTools()).tools.map(tool => tool.name)).toContain('workspace_update')
      const updated = value(await editor.callTool({ name: 'workspace_update', arguments: {
        workspaceId, commandId: randomUUID(), expectedRevision: created.revision, name: 'Persisted edit',
      } })).value as { workspace: { id: string; name: string }; revision: number }
      expect(value(await editor.callTool({ name: 'workspace_get', arguments: { workspaceId } })))
        .toMatchObject(updated)
      const before = (await f.db.pool.query('select record,revision from workspaces where id=$1', [workspaceId])).rows[0]
      expect(before.record.name).toBe('Persisted edit')
      const scopeDenial = await editor.callTool({ name: 'workspace_get', arguments: { workspaceId: f.f.scope.workspaceId } })
      expect(scopeDenial.isError).toBe(true)
      await f.db.pool.query('update management_principals set grants=$2::jsonb where id=$1', [
        credential.principal.id,
        JSON.stringify([{ actions: ['workspaces:read', 'workspace_locations:read'], scope: { workspaceIds: [workspaceId] } }]),
      ])
      const denied = await editor.callTool({ name: 'workspace_update', arguments: {
        workspaceId, commandId: randomUUID(), expectedRevision: updated.revision, name: 'Denied edit',
      } })
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied)).toContain('ACCESS_DENIED')
      expect((await f.db.pool.query('select record,revision from workspaces where id=$1', [workspaceId])).rows[0])
        .toEqual(before)
      expect(value(await editor.callTool({ name: 'workspace_get', arguments: { workspaceId } })))
        .toMatchObject(updated)
      const audits = await f.db.pool.query(
        "select action,source,target_key from management_audit where principal_id=$1 and outcome='denied' order by sequence",
        [credential.principal.id],
      )
      expect(audits.rows).toEqual([
        { action: 'workspace_get', source: 'mcp', target_key: 'mcp:workspace_get' },
        { action: 'workspace_update', source: 'mcp', target_key: 'mcp:workspace_update' },
      ])
    } finally {
      await f.close()
    }
  }, 60000)

  it('creates available default workspace names through authenticated MCP, replays and reads them back, and denies provisioning without grants', async () => {
    const f = await currentOperatorIntegration()
    try {
      await new PostgresFoundationSettingsRepository(f.db.pool).updateWorkspaceDefaults({
        suggestedName: 'New workspace', description: 'Default description', parentPath: f.db.directory,
      }, 0)
      const tools = (await f.client.listTools()).tools
      const schema = tools.find((tool) => tool.name === 'workspace_create')!.inputSchema
      expect(schema.required ?? []).toEqual([])
      expect(schema.properties).toHaveProperty('name')
      expect(schema.properties).toHaveProperty('commandId')
      const create = (arguments_: Record<string, unknown>) => f.client.callTool({ name: 'workspace_create', arguments: arguments_ })
      const base = value(await create({ commandId: randomUUID(), parentPath: f.db.directory }))
      expect(base.value).toMatchObject({ workspace: { name: 'New workspace', description: 'Default description' } })
      await mkdir(join(f.db.directory, 'New workspace (1)'))
      const args = { commandId: randomUUID(), parentPath: f.db.directory, description: 'Override description' }
      const created = value(await create(args))
      const workspace = (created.value as { workspace: { id: string; name: string } }).workspace
      expect(created.value).toMatchObject({ workspace: { name: 'New workspace (2)', description: 'Override description' },
        executionLocation: { rootPath: join(f.db.directory, 'New workspace (2)') }, locationValidation: { status: 'ready' } })
      expect(value(await create(args))).toEqual({ ...created, replayed: true })
      expect(value(await f.client.callTool({ name: 'workspace_get', arguments: { workspaceId: workspace.id } })))
        .toMatchObject({ workspace, executionLocation: { rootPath: join(f.db.directory, 'New workspace (2)') },
          locationRevision: 1, locationValidation: { status: 'ready' } })
      const concurrent = await Promise.all([0, 1].map(() => create({ commandId: randomUUID(), parentPath: f.db.directory })))
      expect(concurrent.map((result) => (value(result).value as { workspace: { name: string } }).workspace.name).sort())
        .toEqual(['New workspace (3)', 'New workspace (4)'])
      expect((await create({ commandId: randomUUID(), name: 'New workspace', parentPath: f.db.directory })).isError).toBe(true)
      const folders = await readdir(f.db.directory)
      const restricted = await f.access.issue({ name: 'No provisioning', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
        grants: [{ actions: ['workspaces:create'], scope: {} }] })
      const denied = await (await f.connect(restricted.token)).callTool({ name: 'workspace_create', arguments: {
        commandId: randomUUID(), parentPath: f.db.directory,
      } })
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied)).toContain('ACCESS_DENIED')
      expect(await readdir(f.db.directory)).toEqual(folders)
      expect((await f.db.pool.query("select record from workspaces where record->>'name' like 'New workspace%'")).rowCount).toBe(4)
      expect((await f.db.pool.query('select sequence from management_audit where principal_id=$1', [restricted.principal.id])).rowCount).toBeGreaterThan(0)
    } finally { await f.close() }
  }, 60000)

  it('discovers current tools and denies missing, worker, expired, revoked, wrong-scope and read-only callers', async () => {
    const f = await currentOperatorIntegration()
    try {
      const names = (await f.client.listTools()).tools.map((tool) => tool.name)
      expect(names).toEqual(expect.arrayContaining(['workspace_create', 'workflow_create', 'run_start', 'run_stop', CURRENT_WORKFLOW_TOOLS.save]))
      expect(names).not.toContain('graph_draft_open')
      const readiness = value(await f.client.callTool({ name: 'execution_readiness_get', arguments: { harness: 'codex' } }))
      expect(readiness).toMatchObject({ status: 'eligible', scope: 'saved-harness-defaults', defaultsRevision: (await f.services.harnesses.get(f.writer.principal, 'codex')).defaultsRevision })
      const readonly = await f.access.issue({ name: 'Reader', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
        grants: [{ actions: ['workflows:read', 'graph:read', 'workspace_locations:validate'], scope: { workspaceIds: [f.f.scope.workspaceId] } }] })
      const reader = await f.connect(readonly.token)
      expect((await reader.listTools()).tools.map((tool) => tool.name)).not.toContain(CURRENT_WORKFLOW_TOOLS.save)
      expect((await reader.listTools()).tools.map((tool) => tool.name)).not.toContain('execution_readiness_get')
      const deniedReadiness = await reader.callTool({ name: 'execution_readiness_get', arguments: { harness: 'codex' } })
      expect(deniedReadiness.isError).toBe(true)
      expect(JSON.stringify(deniedReadiness.content)).toContain('ACCESS_DENIED')
      const input = await f.create()
      expect((await reader.callTool({ name: CURRENT_WORKFLOW_TOOLS.save, arguments: input })).isError).toBe(true)
      const wrong = await f.access.issue({ name: 'Wrong workspace', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
        grants: [{ actions: ManagementActionSchema.options, scope: { workspaceIds: ['wrong'] } }] })
      expect((await (await f.connect(wrong.token)).callTool({ name: 'workflow_get', arguments: { workspaceId: input.workspaceId, workflowId: input.workflowId } })).isError).toBe(true)
      async function post(token?: string, origin?: string) {
        const response = await fetch(new URL('/mcp', f.address), { method: 'POST', headers: { 'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) })
        await response.arrayBuffer()
        return response
      }
      expect((await post()).status).toBe(401)
      const worker = await f.access.issue({ name: 'Worker', audience: 'worker', agentId: f.f.configurations[0]!.agentId,
        expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ManagementActionSchema.options, scope: {} }] })
      expect((await post(worker.token)).status).toBe(403)
      await f.db.pool.query('update management_principals set expires_at=now()-interval \'1 second\' where id=$1', [wrong.principal.id])
      expect((await post(wrong.token)).status).toBe(401)
      await f.access.revoke(readonly.principal.id)
      expect((await post(readonly.token)).status).toBe(401)
      expect((await post(f.writer.token, 'https://example.com')).status).toBe(403)
      expect((await f.db.pool.query('select sequence from management_audit where principal_id=$1', [readonly.principal.id])).rowCount).toBeGreaterThan(0)
    } finally { await f.close() }
  }, 60000)

  it('creates independent workspaces, persists and conflicts on location revisions, and reports unavailable paths', async () => {
    const f = await currentOperatorIntegration()
    vi.spyOn(f.locations, 'revalidateSnapshot').mockRestore()
    try {
      const ids: string[] = []
      for (const index of [0, 1]) {
        const commandId = randomUUID()
        const args = { commandId, name: `Independent workspace ${index}` }
        const created = value(await f.client.callTool({ name: 'workspace_create', arguments: args }))
        const workspace = (created.value as { workspace: { id: string } }).workspace; ids.push(workspace.id)
        expect(value(await f.client.callTool({ name: 'workspace_create', arguments: args }))).toEqual({ ...created, replayed: true })
        const rootPath = join(f.db.directory, `project-${index}`); await mkdir(rootPath)
        const location = { workspaceId: workspace.id, commandId: randomUUID(), expectedLocationRevision: 0, runnerId: f.locations.runnerId, rootPath }
        value(await f.client.callTool({ name: 'workspace_location_set', arguments: location }))
        expect(value(await f.client.callTool({ name: 'workspace_get', arguments: { workspaceId: workspace.id } })))
          .toMatchObject({ executionLocation: { rootPath }, locationRevision: 1 })
        expect((await f.client.callTool({ name: 'workspace_location_set', arguments: { ...location, commandId: randomUUID() } })).isError).toBe(true)
      }
      expect(ids[0]).not.toBe(ids[1])
      const rootPath = join(f.db.directory, 'project-1'); await removeFixtureDirectory(rootPath, { force: false })
      await expect(stat(rootPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(value(await f.client.callTool({ name: 'workspace_get', arguments: { workspaceId: ids[1] } })))
        .toMatchObject({ executionLocation: { rootPath }, locationValidation: { status: 'unavailable' } })
      const listed = value(await f.client.callTool({ name: 'workspace_list', arguments: { detail: 'full', limit: 100 } }))
      expect((listed.items as Array<{ workspace: { id: string } }>).map((item) => item.workspace.id)).toEqual(expect.arrayContaining(ids))
    } finally { await f.close() }
  }, 60000)

  it('saves, validates, reads, starts and Stops through authenticated MCP with exact current pins and durable retries', async () => {
    const f = await currentOperatorIntegration()
    try {
      const location = await f.db.pool.query<{ root: string }>("select execution_location->>'rootPath' as root from workspaces where id=$1", [f.f.scope.workspaceId])
      const identity = await stat(location.rows[0]!.root, { bigint: true })
      await f.db.pool.query('update workspaces set execution_location_identity=$2::jsonb where id=$1',
        [f.f.scope.workspaceId, JSON.stringify({ device: String(identity.dev), inode: String(identity.ino) })])
      const input = await f.create(), { commandId: _commandId, ...validation } = input
    void _commandId
      value(await f.client.callTool({ name: CURRENT_WORKFLOW_TOOLS.validate, arguments: validation }))
      const saved = CurrentWorkflowSaveResultSchema.parse(value(await f.client.callTool({ name: CURRENT_WORKFLOW_TOOLS.save, arguments: input })))
      expect(value(await f.client.callTool({ name: CURRENT_WORKFLOW_TOOLS.save, arguments: input }))).toEqual({ ...saved, replayed: true })
      expect((await f.client.callTool({ name: CURRENT_WORKFLOW_TOOLS.save, arguments: { ...input, graph: { ...input.graph, name: 'Conflicting command' } } })).isError).toBe(true)
      const read = value(await f.client.callTool({ name: CURRENT_WORKFLOW_TOOLS.saved, arguments: { workspaceId: input.workspaceId, workflowId: input.workflowId } }))
      expect(read.version).toEqual(saved.value.version)
      const start = { workspaceId: input.workspaceId, workflowId: input.workflowId, workflowVersionId: saved.value.currentVersionId,
        executionSemanticsVersion: 3, expectedWorkflowRevision: saved.value.revision,
        expectedAgentConfigurationVersionIds: saved.value.version.agentConfigurationVersionIds,
        expectedLocationRevision: 1, commandId: randomUUID(), input: { message: 'exact input' } }
      const started = value(await f.client.callTool({ name: 'run_start', arguments: start }))
      const run = started.run as { id: string }
      expect(value(await f.client.callTool({ name: 'run_start', arguments: start }))).toMatchObject({ run: { id: run.id }, replayed: true })
      await expect.poll(async () => (await f.runs.get(run.id))?.executionState,
        { timeout: 45000, interval: 10 }).toBe('waiting')
      expect(f.provider.counts).toMatchObject({ starts: 2, sessions: 2 })
      const persisted = value(await f.client.callTool({ name: 'run_get', arguments: { workspaceId: input.workspaceId, runId: run.id } }))
      expect(persisted.run).toMatchObject({ workflowVersionId: saved.value.currentVersionId, executionSemanticsVersion: 3 })
      expect((await f.client.callTool({ name: 'run_start', arguments: { ...start, input: { message: 'changed' } } })).isError).toBe(true)
      expect((await f.client.callTool({ name: 'workflow_archive', arguments: { workspaceId: input.workspaceId, workflowId: input.workflowId,
        expectedRevision: saved.value.revision, commandId: randomUUID() } })).isError).toBe(true)
      const stop = { workspaceId: input.workspaceId, runId: run.id, commandId: randomUUID() }
      expect(value(await f.client.callTool({ name: 'run_stop', arguments: stop }))).toMatchObject({ runId: run.id, processStopped: false })
      expect(value(await f.client.callTool({ name: 'run_stop', arguments: stop }))).toMatchObject({ runId: run.id, replayed: true })
      await expect.poll(async () => (await f.runs.get(run.id))?.outcome,
        { timeout: 20000, interval: 10 }).toBe('canceled')
      const archived = value(await f.client.callTool({ name: 'workflow_archive', arguments: { workspaceId: input.workspaceId, workflowId: input.workflowId,
        expectedRevision: saved.value.revision, commandId: randomUUID() } }))
      expect(archived.value).toMatchObject({ archivedAt: expect.any(String) })
      expect(value(await f.client.callTool({ name: 'run_get', arguments: { workspaceId: input.workspaceId, runId: run.id } })))
        .toMatchObject({ run: { id: run.id, outcome: 'canceled' } })
      expect(f.dispatchErrors).toEqual([])
    } finally { await f.close() }
  }, 90000)
})
