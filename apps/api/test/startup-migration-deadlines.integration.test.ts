import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase } from '../src/infrastructure/database.js'
import { withClientTransaction } from '../src/infrastructure/transaction.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { deferred } from './helpers/deferred.js'
import { readUntil } from './helpers/observableCondition.js'

describe.skipIf(!postgresEnabled)('server startup migration deadlines', () => {
  let fixture: Awaited<ReturnType<typeof currentDatabase>>
  beforeAll(async () => { fixture = await currentDatabase() }, 60_000)
  afterAll(async () => { await fixture?.close() })

  it('waits beyond the request deadline, serializes callers and preserves request budgets', async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!)
    url.searchParams.set('options', `-c search_path=${fixture.schema},public`)
    const database = createDatabase({ connectionString: url.toString(), maxConnections: 2,
      connectionTimeoutMs: 1000, queryTimeoutMs: 100 })
    const holder = await fixture.pool.connect()
    const release = deferred()
    const entered = deferred<number>()
    const holding = withClientTransaction(holder, async () => {
      await holder.query('lock table application_migrations in access exclusive mode')
      entered.resolve((await holder.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid)
      await release.promise
    })
    let migrating: Promise<unknown> | undefined
    try {
      const pid = await entered.promise
      migrating = Promise.allSettled([database.migrate(), database.migrate()])
      await readUntil(async () => (await fixture.pool.query<{ blocked: boolean }>(
        'select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as blocked', [pid],
      )).rows[0]!.blocked, value => value, { timeoutMs: 5000, description: 'startup migration lock wait' })
      // eslint-disable-next-line no-restricted-syntax -- Hold DDL contention past the ordinary request budget.
      await new Promise(resolve => setTimeout(resolve, 250))
      release.resolve()
      await holding
      expect(await migrating).toEqual([{ status: 'fulfilled', value: undefined }, { status: 'fulfilled', value: undefined }])
      await database.migrate()
      await expect(database.pool.query('select pg_sleep(0.2)')).rejects.toThrow(/timeout|canceling statement/i)
    } finally {
      release.resolve()
      await holding
      holder.release()
      if (migrating) await migrating
      await database.close()
    }
  }, 30_000)
})
