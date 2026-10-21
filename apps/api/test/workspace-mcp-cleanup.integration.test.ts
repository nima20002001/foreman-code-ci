import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import * as contracts from '@foreman-code/contracts/management'
import pg from 'pg'
import { expect, it } from 'vitest'
import { callWorkspaceTool, workspaceMcpFixture } from './helpers/workspaceMcp.js'
import { closeTestResources } from './support/cleanup.js'

it('removes the owned database and project directory after authenticated MCP work', async () => {
  const f = await workspaceMcpFixture()
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
  let closed = false
  try {
    const database = (await f.pool.query<{ name: string }>('select current_database() as name')).rows[0]!.name
    expect(database).not.toBe(new URL(process.env.TEST_DATABASE_URL!).pathname.slice(1))
    const created = await callWorkspaceTool(f.owner.client, 'workspace_create',
      contracts.ManagedWorkspaceCommandResultSchema, { commandId: randomUUID(), name: 'Cleanup workspace' })
    const saved = await callWorkspaceTool(f.owner.client, 'workspace_get', contracts.ManagedWorkspaceSchema,
      { workspaceId: created.value.workspace.id })
    expect(saved.workspace).toEqual(created.value.workspace)
    await f.close()
    closed = true
    await expect(stat(f.parentPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await admin.query('select 1 from pg_database where datname=$1', [database])).rowCount).toBe(0)
    await expect(f.close()).resolves.toBeUndefined()
  } finally {
    await closeTestResources([
      ...(!closed ? [() => f.close()] : []),
      () => admin.end(),
    ])
  }
}, 30_000)

it('removes the owned database and project directory after fixture setup fails', async () => {
  const failure = new Error('Fixture setup failed')
  let directory = ''
  let database = ''
  await expect(workspaceMcpFixture({ async configure({ parentPath, pool }) {
    directory = parentPath
    database = (await pool.query<{ name: string }>('select current_database() as name')).rows[0]!.name
    throw failure
  } })).rejects.toBe(failure)
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
  try {
    expect(directory).not.toBe('')
    expect(database).not.toBe('')
    expect(database).not.toBe(new URL(process.env.TEST_DATABASE_URL!).pathname.slice(1))
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await admin.query('select 1 from pg_database where datname=$1', [database])).rowCount).toBe(0)
  } finally { await admin.end() }
}, 30_000)

it('removes the owned database and project directory even when app closure fails', async () => {
  const failure = new Error('App closure failed')
  const f = await workspaceMcpFixture({ async configure({ app }) {
    app.addHook('onClose', async () => { throw failure })
  } })
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
  let closed = false
  try {
    const database = (await f.pool.query<{ name: string }>('select current_database() as name')).rows[0]!.name
    expect(database).not.toBe(new URL(process.env.TEST_DATABASE_URL!).pathname.slice(1))
    const result: unknown = await f.close().then(() => undefined, error => error)
    closed = true
    expect(result).toBeInstanceOf(AggregateError)
    expect((result as AggregateError).errors).toContain(failure)
    expect((result as AggregateError).errors).toHaveLength(1)
    await expect(stat(f.parentPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await admin.query('select 1 from pg_database where datname=$1', [database])).rowCount).toBe(0)
  } finally {
    await closeTestResources([
      ...(!closed ? [() => f.close()] : []),
      () => admin.end(),
    ])
  }
}, 30_000)
