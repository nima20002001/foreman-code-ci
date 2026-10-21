import { expect, it } from 'vitest'
import type pg from 'pg'
import { createDatabase } from '../src/infrastructure/database.js'
import { withCiDatabasePriority, withCiDatabaseReservation,
  withoutCiDatabaseReservation } from '../src/infrastructure/ciDatabasePriority.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { CircleCreditCache, circleCreditKey, circleMonthStart } from '../src/modules/ci-host/circleCreditCache.js'
import { CircleCreditUsage } from '../src/modules/ci-host/circleCredits.js'
import { CloudHttp } from '../src/modules/ci-host/cloudHttp.js'
import { CircleStandby, circleOrgKey } from '../src/modules/ci-host/circleStandby.js'
import { CiDispatchDeadlineError, withCiDispatchDeadline } from '../src/modules/ci-host/dispatchDeadline.js'
import { deferred } from './helpers/deferred.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

it('shares a slow credit-policy read with start admission without inheriting the expired scheduling pass', async () => {
  const fixture = await migratedDatabase()
  const database = createDatabase({ connectionString: fixture.databaseUrl, maxConnections: 4, connectionTimeoutMs: 1000 })
  const repository = new PostgresFoundationSettingsRepository(database.pool)
  const cache = new CircleCreditCache()
  const now = Date.now()
  const at = new Date(now).toISOString()
  const release = deferred()
  const finishPass = deferred()
  const held: pg.PoolClient[] = []
  let settled: Promise<PromiseSettledResult<unknown>[]> | undefined
  let lock: Promise<void> | undefined
  try {
    await cache.transaction(states => {
      states[circleCreditKey('fixture-org')] = { attempts: [], lastAttemptAt: now,
        snapshot: { basis: 'compute', used: 0, asOf: at, windowEnd: at, periodStart: circleMonthStart(now) } }
    })
    const usage = new CircleCreditUsage(() => { throw new Error('Unexpected fixture export') }, {
      allowance: () => withCiDatabaseReservation(database.pool, async () => (await repository.getCircleCreditAllowance()).value),
      primaryOwner: async () => 'fixture-org',
    }, { cache, now: () => now })
    const selector = new CircleStandby(async () => [{ owner: 'fixture-org', circleAccountId: 'default',
      role: 'primary', ready: true, mirrorNames: new Set(['ci-mirror']) }], usage, cache, () => now)
    lock = cache.transaction(async () => { await release.promise })
    held.push(...await Promise.all(Array.from({ length: 4 }, () => database.pool.connect())))
    let evaluation: ReturnType<CircleStandby['roles']> | undefined
    const pass = withCiDispatchDeadline(async () => {
      evaluation = withoutCiDatabaseReservation(() => selector.roles('ci-mirror'))
      await finishPass.promise
    })
    const expired = expect(pass).rejects.toBeInstanceOf(CiDispatchDeadlineError)
    const admission = selector.eligible('fixture-org', 'default', 'ci-mirror')
    settled = Promise.allSettled([evaluation!, admission])
    await expired
    const reserved = await withCiDatabasePriority(() => Promise.all([database.pool.connect(), database.pool.connect()]))
    for (const client of reserved) client.release()
    release.resolve()
    await lock
    const results = await settled
    expect(results[0]).toMatchObject({ status: 'fulfilled' })
    expect(results[1]).toEqual({ status: 'fulfilled', value: true })
    for (const client of held.splice(0)) client.release()
    expect((await selector.roles('ci-mirror')).get(circleOrgKey('fixture-org'))?.schedulingRole).toBe('active')
  } finally {
    finishPass.resolve()
    release.resolve()
    await lock
    await settled
    for (const client of held) client.release()
    await database.close()
    await fixture.close()
  }
})

it('finishes a background usage export after the read that requested it ends', async () => {
  const fixture = await migratedDatabase()
  const database = createDatabase({ connectionString: fixture.databaseUrl, maxConnections: 4, connectionTimeoutMs: 1000 })
  const repository = new PostgresFoundationSettingsRepository(database.pool)
  const entered = deferred()
  const release = deferred()
  const now = Date.now()
  const http = new CloudHttp({ run: async () => { throw new Error('Unexpected fixture CLI request') },
    now: () => new Date(now), cpus: 4, memoryBytes: 2 ** 30 }, 'circleci', {
    circleToken: async () => 'fixture-token', fetch: async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/v2/me/collaborations') {
        return Response.json([{ id: 'fixture-org-id', name: 'fixture-org', vcs_type: 'github' }])
      }
      if (init?.method === 'POST') return Response.json({ usage_export_job_id: 'fixture-export' })
      if (url.pathname.endsWith('/fixture-export')) {
        return Response.json({ state: 'completed', download_urls: ['https://fixture.invalid/usage.csv'] })
      }
      if (url.hostname === 'fixture.invalid') return new Response('COMPUTE_CREDITS\n10\n')
      throw new Error(`Unexpected fixture HTTP request: ${url.pathname}`)
    },
  })
  const usage = new CircleCreditUsage(async () => {
    entered.resolve()
    await release.promise
    await repository.getCircleAccounts()
    return http
  }, { allowance: async () => (await repository.getCircleCreditAllowance()).value,
    primaryOwner: async () => 'fixture-org' }, { now: () => now })
  try {
    await withCiDispatchDeadline(async () => {
      expect((await usage.reading('fixture-org')).credits).toBeNull()
      await entered.promise
    })
    release.resolve()
    await expect.poll(async () => (await usage.reading('fixture-org')).credits)
      .toMatchObject({ total: 400_000, used: 10, remaining: 399_990 })
  } finally {
    release.resolve()
    await database.close()
    await fixture.close()
  }
})
