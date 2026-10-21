import pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { OperatorRuntimeOwner } from '../src/infrastructure/operatorRuntimeOwner.js'
import { DomainError } from '../src/modules/errors.js'
import { readUntil } from './helpers/observableCondition.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { deferred } from './helpers/deferred.js'

async function stalledReplies(afterReady: number) {
  const connect = pg.Client.prototype.connect
  const query = pg.Client.prototype.query as unknown as
    (this: pg.Client, ...args: unknown[]) => Promise<pg.QueryResult>
  const release = deferred()
  const ownerClients = new Set<pg.Client>()
  const connection = vi.spyOn(pg.Client.prototype, 'connect').mockImplementation((function (
    this: pg.Client, ...args: unknown[]
  ) {
    if (!ownerClients.size) ownerClients.add(this)
    return Reflect.apply(connect, this, args)
  }) as typeof pg.Client.prototype.connect)
  let replies = 0
  // Keep the guarded disposable endpoint; suppress delivery after PostgreSQL executes the query.
  const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation((function (
    this: pg.Client, ...args: unknown[]
  ) {
    const response = query.apply(this, args)
    if (!ownerClients.has(this) || ++replies < afterReady) return response
    return response.then(async result => {
      await release.promise
      return result
    })
  }) as typeof pg.Client.prototype.query)
  return { url: process.env.TEST_DATABASE_URL!, get stalledReplyCount() { return Math.max(0, replies - afterReady + 1) }, async close() {
    spy.mockRestore()
    connection.mockRestore()
    release.resolve()
  } }
}

describe.skipIf(!postgresEnabled)('runtime owner with PostgreSQL reply loss', () => {
  it.each(['released', 'taken over'] as const)('fences a %s ownership lock without reconciliation or delivered transport events', async condition => {
    const monitor = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL! })
    await monitor.connect()
    const originalQuery = pg.Client.prototype.query as unknown as
      (this: pg.Client, ...args: unknown[]) => Promise<pg.QueryResult>
    const originalEmit = pg.Client.prototype.emit
    const reply = deferred<pg.QueryResult>()
    const ownerClients = new Set<pg.Client>()
    let disconnected = false
    const query = vi.spyOn(pg.Client.prototype, 'query').mockImplementation((function (
      this: pg.Client, ...args: unknown[]
    ) {
      if (this !== monitor && !ownerClients.size) ownerClients.add(this)
      if (ownerClients.has(this) && disconnected) {
        return reply.promise
      }
      return originalQuery.apply(this, args)
    }) as typeof pg.Client.prototype.query)
    const emit = vi.spyOn(pg.Client.prototype, 'emit').mockImplementation(function (this: pg.Client, event, ...args) {
      if (ownerClients.has(this) && disconnected && (event === 'error' || event === 'end')) return false
      return originalEmit.call(this, event, ...args)
    })
    const lost = vi.fn()
    const owner = new OperatorRuntimeOwner(process.env.TEST_DATABASE_URL!, lost)
    const successor = new OperatorRuntimeOwner(process.env.TEST_DATABASE_URL!, vi.fn())
    try {
      await owner.acquire()
      const pid = (await monitor.query<{ pid: number }>(`select pid from pg_locks
        where locktype='advisory' and classid=0::oid and objid=710014::oid and objsubid=1 and granted
        and database=(select oid from pg_database where datname=current_database())`)).rows[0]!.pid
      disconnected = true
      await monitor.query('select pg_terminate_backend($1)', [pid])
      await readUntil(async () => (await monitor.query('select pid from pg_stat_activity where pid=$1', [pid])).rows.length,
      count => count === 0, { timeoutMs: 5_000, description: 'terminated ownership backend' })
      if (condition === 'taken over') {
        await successor.acquire()
        expect(successor.active).toBe(true)
      }
      await readUntil(async () => owner.active, active => !active,
        { timeoutMs: 15_000, description: 'independent lost-session fencing' })
      expect(lost).toHaveBeenCalledOnce()
      await expect(owner.acquire()).rejects.toBeInstanceOf(Error)
      await expect(owner.readRuntimeEpoch()).rejects.toMatchObject({ code: 'NATIVE_RUNTIME_UNAVAILABLE' })
    } finally {
      query.mockRestore()
      emit.mockRestore()
      reply.resolve({ rows: [{ epoch: '123456' }], command: 'SELECT', rowCount: 1, oid: 0, fields: [] })
      await owner.close().catch(() => { /* ignore: the terminated backend can reject the pre-fix owner's unlock. */ })
      await successor.close()
      await monitor.end()
    }
  }, 25_000)

  it('acquires ownership and reads an epoch before injecting reply loss', async () => {
    const proxy = await stalledReplies(3)
    const owner = new OperatorRuntimeOwner(proxy.url, () => undefined)
    try {
      await owner.acquire()
      expect(owner.active).toBe(true)
      expect(await owner.readRuntimeEpoch()).toMatch(/^\d+$/)
    } finally {
      await proxy.close()
      await owner.close().catch(() => { /* ignore: cleanup after a failed acquisition reports its original failure. */ })
    }
  })

  it('keeps ownership and excludes a successor while an epoch reply is delayed beyond its deadline', async () => {
    const proxy = await stalledReplies(2)
    const lost = vi.fn()
    const owner = new OperatorRuntimeOwner(proxy.url, lost)
    const successor = new OperatorRuntimeOwner(proxy.url, vi.fn())
    let reading: Promise<unknown> | undefined
    try {
      await owner.acquire()
      reading = owner.readRuntimeEpoch().then(value => ({ value }), error => ({ error }))
      await readUntil(async () => ({ active: owner.active, replies: proxy.stalledReplyCount }),
        result => !result.active || result.replies >= 2,
        { timeoutMs: 7_000, description: 'epoch read retry or ownership loss' })
      expect(owner.active).toBe(true)
      expect(lost).not.toHaveBeenCalled()
      await expect(successor.acquire()).rejects.toMatchObject({ code: 'OPERATOR_API_ALREADY_OWNED' })
      await proxy.close()
      expect(await reading).toEqual({ value: expect.stringMatching(/^\d+$/) })
      expect(owner.active).toBe(true)
      expect(lost).not.toHaveBeenCalled()
    } finally {
      await proxy.close()
      await reading
      await successor.close()
      await owner.close()
    }
  })

  it.each(['acquire', 'close'] as const)('bounds %s and releases its physical advisory-lock session', async (operation) => {
    const monitor = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL! })
    await monitor.connect()
    const proxy = await stalledReplies(operation === 'acquire' ? 1 : 2)
    const owner = new OperatorRuntimeOwner(proxy.url, () => undefined)
    let successor: OperatorRuntimeOwner | undefined
    let work: Promise<unknown> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (operation !== 'acquire') await owner.acquire()
      const readOwnerPid = async () => (await monitor.query<{ pid: number }>(`
        select pid from pg_locks where locktype='advisory' and classid=0::oid
          and objid=710014::oid and objsubid=1 and granted
          and database=(select oid from pg_database where datname=current_database())`)).rows[0]?.pid
      let ownerPid = operation === 'acquire' ? undefined : await readOwnerPid()
      work = operation === 'acquire' ? owner.acquire() : owner.close()
      const result = work.then(() => 'success', error => error)
      if (operation === 'acquire') {
        ownerPid = await readUntil(readOwnerPid, pid => pid !== undefined,
          { timeoutMs: 4000, description: 'server-side runtime ownership before lost reply' })
      }
      expect(ownerPid).toBeDefined()
      const watchdog = new Promise<string>(resolve => { timer = setTimeout(() => resolve('unbounded'), 7000) })
      expect(await Promise.race([result, watchdog])).toMatchObject({
        code: 'NATIVE_RUNTIME_DATABASE_TIMEOUT',
      })
      expect(owner.active).toBe(false)
      await readUntil(async () => (await monitor.query(
        'select pid from pg_stat_activity where pid=$1', [ownerPid])).rows.length,
      count => count === 0, { timeoutMs: 5000, description: 'closed runtime-owner backend' })
      successor = await readUntil(async () => {
        const candidate = new OperatorRuntimeOwner(process.env.TEST_DATABASE_URL!, () => undefined)
        try {
          await candidate.acquire()
          return candidate
        } catch (error) {
          await candidate.close()
          if (error instanceof DomainError && error.code === 'OPERATOR_API_ALREADY_OWNED') return undefined
          throw error
        }
      }, candidate => candidate !== undefined, { timeoutMs: 5000, description: 'released runtime-owner session' })
      expect(successor?.active).toBe(true)
    } finally {
      if (timer) clearTimeout(timer)
      await proxy.close()
      if (work) await work.catch(() => { /* ignore: the operation's failure is asserted above. */ })
      await owner.close().catch(() => { /* ignore: a failed unlock still closes the physical session. */ })
      await successor?.close()
      await monitor.end()
    }
  }, 20_000)
})
