import { randomUUID } from 'node:crypto'
import * as contracts from '@foreman-code/contracts/management'
import { describe, expect, it } from 'vitest'
import { WORKSPACE_FOLDER_LIFECYCLE_LOCK } from '../src/modules/workspaces/projectFolderCleanup.js'
import { callWorkspaceTool, waitForWorkspaceBlocker, workspaceMcpFixture } from './helpers/workspaceMcp.js'

const operations = [
  { tool: 'workspace_update', operation: 'workspace.update' },
  { tool: 'workspace_archive', operation: 'workspace.archive' },
  { tool: 'workspace_batch_archive', operation: 'workspace.batch_archive' },
  { tool: 'workspace_location_set', operation: 'workspace.location.set' },
  { tool: 'workspace_create', operation: 'workspace.create' },
] as const

describe('workspace mutation authority through authenticated MCP', () => {
  it.each(operations)('rejects $tool when its owner is revoked during a lock wait', async ({ tool, operation }) => {
    const f = await workspaceMcpFixture()
    const blocker = await f.pool.connect()
    const revoker = await f.pool.connect()
    let pending: ReturnType<typeof f.owner.client.callTool> | undefined
    try {
      const database = await f.pool.query<{ name: string }>('select current_database() as name')
      expect(database.rows[0]!.name).not.toBe(new URL(process.env.TEST_DATABASE_URL!).pathname.slice(1))
      const created = await callWorkspaceTool(f.owner.client, 'workspace_create',
        contracts.ManagedWorkspaceCommandResultSchema, { commandId: randomUUID(), name: 'Original' })
      const workspaceId = created.value.workspace.id
      const delegated = await f.issue()
      await f.pool.query('update management_principals set delegated_from = $2 where id = $1',
        [delegated.principal.id, f.owner.principal.id])
      await blocker.query('begin')
      await blocker.query("set local statement_timeout = '5s'")
      const pid = (await blocker.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      if (tool === 'workspace_create') {
        await blocker.query('select pg_advisory_xact_lock(hashtext($1))', [WORKSPACE_FOLDER_LIFECYCLE_LOCK])
      } else {
        await blocker.query('select id from workspaces where id = $1 for update', [workspaceId])
      }
      const commandId = randomUUID()
      let args: Record<string, unknown> = { workspaceId, commandId, expectedRevision: created.value.revision }
      if (tool === 'workspace_update') args.name = 'Revoked rename'
      if (tool === 'workspace_batch_archive') {
        args = { commandId, workspaces: [{ workspaceId, expectedRevision: created.value.revision }] }
      }
      if (tool === 'workspace_location_set') {
        args = { workspaceId, commandId, expectedLocationRevision: 0, runnerId: 'runner-local', rootPath: f.parentPath }
      }
      if (tool === 'workspace_create') args = { commandId, name: 'Revoked creation' }
      pending = delegated.client.callTool({ name: tool, arguments: args })
      await waitForWorkspaceBlocker(f.pool, pid)
      await revoker.query('begin')
      await revoker.query("set local statement_timeout = '3s'")
      expect((await revoker.query('update management_principals set revoked_at = now() where id = $1',
        [f.owner.principal.id])).rowCount).toBe(1)
      await revoker.query('commit')
      await blocker.query('commit')
      const response = await pending
      expect(response.isError).toBe(true)
      expect(JSON.stringify(response)).toContain('AUTH_REVOKED')
      const reader = await f.issue()
      const saved = await callWorkspaceTool(reader.client, 'workspace_get', contracts.ManagedWorkspaceSchema, { workspaceId })
      expect(saved.workspace).toEqual(created.value.workspace)
      expect(saved.revision).toBe(created.value.revision)
      expect(saved.archivedAt).toBeNull()
      expect(saved.executionLocation).toBeNull()
      expect(saved.locationRevision).toBe(0)
      expect((await f.pool.query('select count(*)::int as count from workspaces')).rows[0].count).toBe(1)
      expect((await f.pool.query(`select count(*)::int as count from management_command_receipts
        where principal_id = $1 and operation = $2 and command_id = $3`,
      [delegated.principal.id, operation, commandId])).rows[0].count).toBe(0)
      expect((await f.pool.query(`select outcome from management_audit
        where principal_id = $1 and action = $2 and details->>'commandId' = $3`,
      [delegated.principal.id, operation, commandId])).rows.map(row => row.outcome)).toEqual(['failed'])
    } finally {
      await revoker.query('rollback')
      revoker.release()
      await blocker.query('rollback')
      blocker.release()
      if (pending) await Promise.allSettled([pending])
      await f.close()
    }
  }, 30_000)

  it('denies an out-of-scope rename and preserves persisted workspace state', async () => {
    const f = await workspaceMcpFixture()
    try {
      const created = await callWorkspaceTool(f.owner.client, 'workspace_create',
        contracts.ManagedWorkspaceCommandResultSchema, { commandId: randomUUID(), name: 'Scoped' })
      const workspaceId = created.value.workspace.id
      const caller = await f.issue([{ actions: ['workspaces:update'], scope: { workspaceIds: ['another-workspace'] } }])
      const commandId = randomUUID()
      const denied = await caller.client.callTool({ name: 'workspace_update', arguments: {
        workspaceId, commandId, expectedRevision: created.value.revision, name: 'Denied',
      } })
      expect(denied.isError).toBe(true)
      expect((await callWorkspaceTool(f.owner.client, 'workspace_get', contracts.ManagedWorkspaceSchema,
        { workspaceId })).workspace).toEqual(created.value.workspace)
      expect((await f.pool.query('select count(*)::int as count from management_command_receipts where command_id = $1',
        [commandId])).rows[0].count).toBe(0)
    } finally { await f.close() }
  }, 30_000)

  it('rechecks live grants before replaying a committed command', async () => {
    const f = await workspaceMcpFixture()
    const blocker = await f.pool.connect()
    const revoker = await f.pool.connect()
    let pending: ReturnType<typeof f.owner.client.callTool> | undefined
    try {
      const created = await callWorkspaceTool(f.owner.client, 'workspace_create',
        contracts.ManagedWorkspaceCommandResultSchema, { commandId: randomUUID(), name: 'Before' })
      const workspaceId = created.value.workspace.id
      const caller = await f.issue([{ actions: ['workspaces:update', 'workspaces:read'], scope: { workspaceIds: [workspaceId] } }])
      const input = { workspaceId, commandId: randomUUID(), expectedRevision: created.value.revision, name: 'After' }
      const updated = await callWorkspaceTool(caller.client, 'workspace_update', contracts.ManagedWorkspaceCommandResultSchema, input)
      expect((await callWorkspaceTool(caller.client, 'workspace_update',
        contracts.ManagedWorkspaceCommandResultSchema, input)).replayed).toBe(true)
      await blocker.query('begin')
      await blocker.query('select id from workspaces where id = $1 for update', [workspaceId])
      const pid = (await blocker.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      pending = caller.client.callTool({ name: 'workspace_update', arguments: input })
      await waitForWorkspaceBlocker(f.pool, pid)
      await revoker.query('begin')
      await revoker.query("set local statement_timeout = '3s'")
      await revoker.query('update management_principals set grants = $2::jsonb where id = $1',
        [caller.principal.id, JSON.stringify([{ actions: ['workspaces:read'], scope: { workspaceIds: [workspaceId] } }])])
      await revoker.query('commit')
      await blocker.query('commit')
      const denied = await pending
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied)).toContain('ACCESS_DENIED')
      const saved = await callWorkspaceTool(f.owner.client, 'workspace_get', contracts.ManagedWorkspaceSchema, { workspaceId })
      expect(saved.workspace.name).toBe('After')
      expect(saved.revision).toBe(updated.value.revision)
      expect((await f.pool.query('select count(*)::int as count from management_command_receipts where command_id = $1',
        [input.commandId])).rows[0].count).toBe(1)
    } finally {
      await revoker.query('rollback')
      revoker.release()
      await blocker.query('rollback')
      blocker.release()
      if (pending) await Promise.allSettled([pending])
      await f.close()
    }
  }, 30_000)
})
