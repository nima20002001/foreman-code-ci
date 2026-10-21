import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { ManagementActionSchema, ManagedWorkspaceCommandResultSchema } from '@foreman-code/contracts/management'
import { makeCurrentWorkflowFixture, WorkflowRunV3Schema } from '@foreman-code/contracts/wave25'
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { seedAgent3 } from './helpers/wave25Agent3.js'

const execute = promisify(execFile)
async function git(path: string, ...args: string[]) {
  const result = await execute('git', ['-C', path, ...args], {
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  })
  return result.stdout.trim()
}

it.each([
  { archive: 'workspace_archive', state: 'running', alias: false },
  { archive: 'workspace_batch_archive', state: 'running', alias: true },
  { archive: 'workspace_archive', state: 'pending cleanup', alias: true },
  { archive: 'workspace_batch_archive', state: 'pending cleanup', alias: false },
  { archive: 'workspace_archive', state: 'idle workspace', alias: true },
  { archive: 'workspace_batch_archive', state: 'idle workspace', alias: false },
])('$archive retains a canonical Git common directory needed by $state', async ({ archive, state, alias }) => {
  const db = await currentDatabase()
  const clients: Client[] = []
  let app: ReturnType<typeof buildApp> | undefined
  try {
    const parent = join(db.directory, 'workspaces')
    const runtime = join(db.directory, 'runtime')
    await mkdir(parent)
    await mkdir(runtime)
    const commands = new PostgresCommandCoordinator(db.pool)
    const access = new PostgresAccessService(db.pool)
    const locations = new WorkspaceLocationService(db.pool, commands, runtime, 'runner-local')
    const defaults = new PostgresFoundationSettingsRepository(db.pool, parent)
    const workspaces = new WorkspaceManagementService(db.pool, commands, locations, defaults, parent)
    app = buildApp({ logger: false,
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { commands, locations, workspaces } as unknown as OperatorServices },
    })
    const owner = await access.issue({ name: 'Archive owner', audience: 'operator',
      grants: [{ actions: ManagementActionSchema.options, scope: {} }] })
    const reader = await access.issue({ name: 'Archive reader', audience: 'operator',
      grants: [{ actions: ['workspaces:read', 'workspace_locations:read'], scope: {} }] })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'Linked worktree archive regression', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    const client = await connect(owner.token)
    const denied = await connect(reader.token)
    const created = await client.callTool({ name: 'workspace_create', arguments: {
      name: 'Shared repository', parentPath: parent,
    } })
    expect(created.isError).not.toBe(true)
    const workspace = ManagedWorkspaceCommandResultSchema.parse(decodeMcpToolResult(created)).value
    const repository = workspace.executionLocation!.rootPath
    await git(repository, 'init', '--template=')
    await writeFile(join(repository, 'retained.txt'), 'Shared object store')
    await git(repository, 'add', 'retained.txt')
    await git(repository, '-c', 'user.name=Fixture Author', '-c', 'user.email=fixture@example.invalid',
      'commit', '-m', 'Initial content')
    const linked = join(db.directory, 'linked')
    await git(repository, 'worktree', 'add', '--detach', linked, 'HEAD')
    if (alias) {
      const metadata = join(db.directory, 'metadata-alias')
      await symlink(join(repository, '.git'), metadata)
      await writeFile(join(linked, '.git'), `gitdir: ${join(metadata, 'worktrees', 'linked')}\n`)
    }
    const cwd = join(linked, 'nested')
    await mkdir(cwd)
    const fixture = await seedAgent3(db.pool, cwd, makeCurrentWorkflowFixture(randomUUID(), 'single'),
      { run: state !== 'idle workspace' })
    const completed = WorkflowRunV3Schema.parse({ ...fixture.run, executionState: 'completed',
      outcome: 'canceled', result: { outcome: 'canceled' }, finishedAt: new Date().toISOString() })
    const run = state === 'running'
      ? WorkflowRunV3Schema.parse({ ...fixture.run, executionState: 'running' }) : completed
    await db.pool.query('update runs set execution_state=$2,record=$3::jsonb where id=$1',
      [run.id, run.executionState, JSON.stringify(run)])
    if (state === 'pending cleanup') {
      await db.pool.query('insert into run_cleanup_intents(run_id,pending) values($1,true)', [fixture.run.id])
    }
    expect(await git(cwd, 'show', 'HEAD:retained.txt')).toBe('Shared object store')
    const item = { workspaceId: workspace.workspace.id, expectedRevision: workspace.revision }
    const input = { commandId: randomUUID(), ...(archive === 'workspace_archive' ? item : { workspaces: [item] }) }
    await expectMcpAccessDenied(denied.callTool({ name: archive, arguments: input }))
    const archived = await client.callTool({ name: archive, arguments: input })
    expect(archived.isError).toBe(true)
    expect(archived.content).toEqual([{ type: 'text', text: expect.stringContaining('WORKSPACE_FOLDER_CLEANUP_FAILED') }])
    expect((await lstat(repository)).isDirectory()).toBe(true)
    expect(await git(cwd, 'show', 'HEAD:retained.txt')).toBe('Shared object store')
    const readback = await client.callTool({ name: 'workspace_get', arguments: { workspaceId: workspace.workspace.id } })
    expect(readback.isError).not.toBe(true)
    expect(decodeMcpToolResult(readback)).toMatchObject({ archivedAt: expect.any(String) })
    const retained = await db.pool.query<{ created_project_folder: unknown }>(
      'select created_project_folder from workspaces where id=$1', [workspace.workspace.id])
    expect(retained.rows[0]!.created_project_folder).not.toBeNull()
    await db.pool.query("update runs set execution_state='completed',record=$2::jsonb where id=$1",
      [completed.id, JSON.stringify(completed)])
    await db.pool.query('update run_cleanup_intents set pending=false where run_id=$1', [fixture.run.id])
    const afterRun = await client.callTool({ name: archive, arguments: input })
    expect(afterRun.isError).toBe(true)
    expect(afterRun.content).toEqual([{ type: 'text', text: expect.stringContaining('WORKSPACE_FOLDER_CLEANUP_FAILED') }])
    expect(await git(cwd, 'show', 'HEAD:retained.txt')).toBe('Shared object store')
    const relocated = join(db.directory, 'relocated')
    await mkdir(relocated)
    const moved = await client.callTool({ name: 'workspace_location_set', arguments: {
      workspaceId: fixture.run.workspaceId, runnerId: 'runner-local', rootPath: relocated,
      expectedLocationRevision: 1,
    } })
    expect(moved.isError, JSON.stringify(moved)).not.toBe(true)
    expect((await client.callTool({ name: archive, arguments: input })).isError).not.toBe(true)
    await expect(lstat(repository)).rejects.toMatchObject({ code: 'ENOENT' })
    const removed = await db.pool.query<{ created_project_folder: unknown }>(
      'select created_project_folder from workspaces where id=$1', [workspace.workspace.id])
    expect(removed.rows[0]!.created_project_folder).toBeNull()
  } finally {
    await Promise.allSettled(clients.map(client => client.close()))
    await app?.close()
    await db.close()
  }
}, 120_000)
