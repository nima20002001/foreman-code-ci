import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import * as c from '@foreman-code/contracts/management'
import { expect, it } from 'vitest'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { callWorkspaceTool, workspaceMcpFixture } from './helpers/workspaceMcp.js'
import { closeTestResources } from './support/cleanup.js'

it('reuses a caller-owned migrated database through authenticated MCP without disposing its rows or directory', async () => {
  const database = await migratedDatabase()
  const fixtures: Awaited<ReturnType<typeof workspaceMcpFixture>>[] = []
  try {
    const first = await workspaceMcpFixture({ database })
    fixtures.push(first)
    const created = await callWorkspaceTool(first.owner.client, 'workspace_create',
      c.ManagedWorkspaceCommandResultSchema, { commandId: randomUUID(), name: 'Shared database project' })
    await first.close()

    expect((await stat(database.directory)).isDirectory()).toBe(true)
    expect((await database.pool.query('select id from workspaces where id=$1', [created.value.workspace.id])).rows)
      .toEqual([{ id: created.value.workspace.id }])

    const second = await workspaceMcpFixture({ database })
    fixtures.push(second)
    const read = await callWorkspaceTool(second.owner.client, 'workspace_get', c.ManagedWorkspaceSchema,
      { workspaceId: created.value.workspace.id })
    expect(read.workspace).toEqual(created.value.workspace)
    expect(read.executionLocation).toEqual(created.value.executionLocation)
  } finally {
    await closeTestResources([
      ...fixtures.map(fixture => () => fixture.close()),
      () => database.close(),
    ])
  }
}, 30_000)

it('rejects a migrated database whose ownership marker belongs to another invocation', async () => {
  const database = await migratedDatabase()
  const name = new URL(database.databaseUrl).pathname.slice(1)
  const { rows } = await database.pool.query<{ marker: string }>(
    "select shobj_description(oid, 'pg_database') as marker from pg_database where datname=$1", [name])
  const marker = rows[0]!.marker
  let fixture: Awaited<ReturnType<typeof workspaceMcpFixture>> | undefined
  try {
    await database.pool.query(`comment on database "${name}" is 'graphql-test:${randomUUID()}'`)
    await expect((async () => {
      fixture = await workspaceMcpFixture({ database })
    })()).rejects.toThrow('Disposable database ownership mismatch')
  } finally {
    await closeTestResources([
      async () => { await fixture?.close() },
      async () => { await database.pool.query(`comment on database "${name}" is '${marker}'`) },
      () => database.close(),
    ])
  }
}, 30_000)
