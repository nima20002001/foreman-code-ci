import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { deferred } from './helpers/deferred.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { createTestPool } from './helpers/testPool.mjs'

let database: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { database = await migratedDatabase() }, 60_000)
afterAll(async () => { await database?.close() }, 60_000)

it('reuses a session across prepared commands, gives concurrent commands their own, and closes them with the pool', async () => {
  const pool = createTestPool({ connectionString: database.databaseUrl, max: 4, application_name: 'command-session-test' })
  let ended = false
  try {
    const issued = await new PostgresAccessService(pool).issue({ name: 'Command caller', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['workspaces:read'], scope: { workspaceIds: [randomUUID()] } }] })
    const commands = new PostgresCommandCoordinator(pool)
    const prepared = (commandId: string, prepare = async () => {}) => commands.execute({
      principal: issued.principal, source: 'mcp', operation: 'session.check', commandId, targetKey: 'sessions',
      payload: { commandId }, prepare,
      perform: async client => (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid,
    })
    const first = await prepared('first')
    const second = await prepared('second')
    expect(second.value).toBe(first.value)

    const entered = [deferred(), deferred()]
    const release = deferred()
    const concurrent = Promise.all(entered.map((gate, index) => prepared(`concurrent-${index}`, async () => {
      gate.resolve()
      await release.promise
    })))
    await Promise.all(entered.map(gate => gate.promise))
    release.resolve()
    const [left, right] = await concurrent
    expect(left!.value).not.toBe(right!.value)

    ended = true
    await pool.end()
    const open = await database.pool.query<{ count: number }>(`select count(*)::int as count from pg_stat_activity
      where datname=current_database() and application_name='graphql-lifecycle-command'`)
    expect(open.rows).toEqual([{ count: 0 }])
  } finally {
    if (!ended) await pool.end()
  }
})
