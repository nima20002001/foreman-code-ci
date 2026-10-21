import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import * as contracts from '@foreman-code/contracts/management'
import { expect, vi } from 'vitest'
import { callWorkspaceTool, workspaceMcpFixture } from './workspaceMcp.js'

export const workspaceCreationFailures = [
  'receipt', 'audit', 'commit', 'commit division by zero', 'commit localized rejection',
] as const

export async function checkWorkspaceCreationCompensation(
  failure: typeof workspaceCreationFailures[number],
  { explicitName }: { explicitName: boolean },
) {
  const f = await workspaceMcpFixture()
  try {
    const name = 'Recovered project'
    await f.defaults.updateWorkspaceDefaults({ suggestedName: name, description: '', parentPath: f.parentPath }, 0)
    const table = failure === 'receipt' ? 'management_command_receipts' : 'management_audit'
    const trigger = failure.startsWith('commit')
      ? `create constraint trigger reject_creation after insert on ${table}
         deferrable initially deferred for each row execute function reject_creation()`
      : `create trigger reject_creation before insert on ${table}
         for each row execute function reject_creation()`
    const condition = failure === 'receipt'
      ? "new.operation = 'workspace.create'" : "new.action = 'workspace.create' and new.outcome = 'succeeded'"
    const rejection = failure === 'commit division by zero' || failure === 'commit localized rejection'
      ? "raise exception 'Injected division by zero' using errcode = '22012'"
      : "raise exception 'Injected creation failure'"
    await f.pool.query(`create function reject_creation() returns trigger language plpgsql as $$
      begin
        if ${condition} then ${rejection}; end if;
        return new;
      end $$; ${trigger}`)
    if (failure === 'commit localized rejection') {
      const query = pg.Client.prototype.query as unknown as
        (this: pg.Client, ...args: unknown[]) => Promise<pg.QueryResult>
      // Keep the real deferred COMMIT rejection; represent its localized protocol severity.
      vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: unknown[]) {
        const response = query.apply(this, args)
        if (args[0] !== 'commit') return response
        return response.catch((error: unknown) => {
          if (error instanceof pg.DatabaseError && error.code === '22012') {
            error.severity = 'FEHLER'
          }
          throw error
        })
      } as never)
    }
    const input = { commandId: randomUUID(), parentPath: f.parentPath, ...(explicitName ? { name } : {}) }
    const failed = await f.owner.client.callTool({ name: 'workspace_create', arguments: input })
    expect(failed.isError, JSON.stringify(failed)).toBe(true)
    expect(JSON.stringify(failed)).toContain('INTERNAL_ERROR')
    expect(await readdir(f.parentPath)).toEqual([])
    expect((await f.pool.query('select id from workspace_project_provisioning')).rows).toEqual([])
    expect((await f.pool.query('select count(*)::int as count from workspaces')).rows[0].count).toBe(0)
    expect((await f.pool.query('select count(*)::int as count from management_command_receipts where command_id = $1',
      [input.commandId])).rows[0].count).toBe(0)
    await f.pool.query(`drop trigger reject_creation on ${table}`)
    const retried = await callWorkspaceTool(f.owner.client, 'workspace_create', contracts.ManagedWorkspaceCommandResultSchema, input)
    expect(retried.replayed).toBe(false)
    expect(retried.value.workspace.name).toBe(name)
    const readback = await callWorkspaceTool(f.owner.client, 'workspace_get', contracts.ManagedWorkspaceSchema,
      { workspaceId: retried.value.workspace.id })
    expect(readback.executionLocation?.rootPath).toBe(join(f.parentPath, name))
    expect(readback.locationValidation.status).toBe('ready')
    expect(await readdir(f.parentPath)).toEqual([name])
    const owned = (await f.pool.query('select id, created_project_folder from workspaces')).rows
    expect(owned).toHaveLength(1)
    expect(owned[0]).toMatchObject({ id: retried.value.workspace.id,
      created_project_folder: { rootPath: join(f.parentPath, name) } })
    expect((await callWorkspaceTool(f.owner.client, 'workspace_create',
      contracts.ManagedWorkspaceCommandResultSchema, input)).replayed).toBe(true)
    expect(await readdir(f.parentPath)).toEqual([name])
    expect((await f.pool.query(`select outcome from management_audit
      where action = 'workspace.create' and details->>'commandId' = $1 order by sequence`,
    [input.commandId])).rows.map(row => row.outcome)).toEqual(['failed', 'succeeded'])
  } finally { await f.close() }
}
