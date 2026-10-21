import pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { createDatabase } from '../../infrastructure/database.js'
import { withCiDatabasePriority, withoutCiDatabasePriority,
  withoutCiDatabaseReservation } from '../../infrastructure/ciDatabasePriority.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { CiAuthority } from '../jobs/ciAuthority.js'
import { claimCiSlot } from './cloudSlots.js'
import { ticketStore } from './ciTicketStore.testSupport.js'
import { queuedTicket, readyStatus } from './dispatchFleet.testSupport.js'
import { HostCiService, type CiCommits, type HostCiComputer, type HostCiEndpoint } from './service.js'
import { deferred } from '../../../test/helpers/deferred.js'
import { ProductionHostCiEndpoint } from './endpoint.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const cloud: HostCiComputer = {
  key: 'cloud:0', label: 'Cloud executor', priority: 0,
  hostRef: { kind: 'cloud', mainId: 'main', provider: 'github', slot: 0 },
}

/** Fake only the PostgreSQL wire boundary; real pools own connection limits, queues and acquisition deadlines. */
function database(records: ReturnType<typeof queuedTicket>[], statementMs = 0) {
  const store = ticketStore(records)
  vi.spyOn(pg.Client.prototype, 'connect').mockImplementation(function (
    this: pg.Client, callback: Parameters<pg.Client['connect']>[0],
  ) {
    queueMicrotask(() => Reflect.apply(callback, this, [null, this]))
  })
  const query = function (text: string, values?: unknown[] | ((...args: unknown[]) => void),
    callback?: (...args: unknown[]) => void) {
    const perform = async () => {
      if (statementMs) await new Promise(resolve => setTimeout(resolve, statementMs))
      return store.pool.query(text, Array.isArray(values) ? values : [])
    }
    const result = perform()
    const done = typeof values === 'function' ? values : callback
    if (!done) return result
    void result.then(value => done(null, value), error => done(error))
  }
  vi.spyOn(pg.Client.prototype, 'query').mockImplementation(query as pg.Client['query'])
  const db = createDatabase({
    connectionString: 'postgresql://test:test@127.0.0.1:5432/test',
    maxConnections: 4, connectionTimeoutMs: 1000, queryTimeoutMs: 1000,
  })
  return { ...db, read: store.read }
}

function startRequest(run: ReturnType<typeof queuedTicket>) {
  return { operation: 'start' as const, runId: run.id, repository: run.repository,
    commit: run.commit, suite: run.suite, ...(run.part ? { part: run.part } : {}), scope: run.scope, files: run.files }
}

function executor(slot: number): HostCiComputer {
  if (slot === 0) return { key: 'main', label: 'Main executor', priority: 0, hostRef: { kind: 'main', mainId: 'main' } }
  if (slot < 4) return { key: `device:${slot}`, label: `Device executor ${slot}`, priority: 0,
    hostRef: { kind: 'device', mainId: 'main', deviceId: `device-${slot}` } }
  return { ...cloud, key: `cloud:${slot}`, hostRef: { ...cloud.hostRef, slot } }
}

it('claims 110 queued parts without starving the two-connection dispatch pool while admission holds a lease', async () => {
  vi.useFakeTimers()
  const records = Array.from({ length: 110 }, () => queuedTicket({ suite: 'integration' }))
  // Five statements at 260 ms reproduce the observed 1.3-second slot transactions, below each SQL deadline.
  const db = database(records, 260)
  const admission = await withCiDatabasePriority(() => db.pool.connect())
  try {
    const claims = withCiDatabasePriority(() => Promise.allSettled(records.map((run, slot) =>
      claimCiSlot(db.pool, run, executor(slot), startRequest(run)))))
    await vi.advanceTimersByTimeAsync(150_000)
    const results = await claims
    expect(results.filter(result => result.status === 'rejected')).toEqual([])
    expect(results).toHaveLength(110)
    for (const [index, run] of records.entries()) {
      expect(results[index]).toMatchObject({ status: 'fulfilled', value: { id: run.id, state: 'starting' } })
      expect(db.read(run.id).record).toMatchObject({ state: 'starting', dispatchRequest: { runId: run.id } })
    }
  } finally {
    admission.release()
    await db.close()
  }
})

it('does not run expired queued claims or let them overtake a claim that still holds its connection', async () => {
  vi.useFakeTimers()
  const records = Array.from({ length: 4 }, () => queuedTicket())
  const db = database(records, 260)
  const controller = new AbortController()
  try {
    const first = withCiDatabasePriority(() => claimCiSlot(db.pool, records[0]!, cloud, startRequest(records[0]!)))
    await vi.advanceTimersByTimeAsync(1)
    const expired = withCiDatabasePriority(() => Promise.allSettled(records.slice(1, 3).map(run =>
      claimCiSlot(db.pool, run, executor(records.indexOf(run) + 4), startRequest(run)))), controller.signal)
    await vi.advanceTimersByTimeAsync(1)
    controller.abort(new Error('dispatch expired'))
    const next = withCiDatabasePriority(() => claimCiSlot(db.pool, records[3]!, executor(7), startRequest(records[3]!)))
    const settled = Promise.allSettled([first, next])
    await vi.advanceTimersByTimeAsync(6000)
    expect(await expired).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ message: 'dispatch expired' }) },
      { status: 'rejected', reason: expect.objectContaining({ message: 'dispatch expired' }) },
    ])
    expect((await settled).map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(db.read(records[1]!.id).record.state).toBe('queued')
    expect(db.read(records[2]!.id).record.state).toBe('queued')
    expect(db.read(records[3]!.id).record.state).toBe('starting')
  } finally {
    await db.close()
  }
})

it('dispatches and saves an executor reply while both reserved connections are occupied by admission', async () => {
  vi.useFakeTimers()
  const run = queuedTicket()
  const db = database([run])
  const starts: string[] = []
  const endpoint: HostCiEndpoint = {
    computers: async () => [executor(0)],
    request: async (_computer, request) => {
      if (request.operation === 'status') return readyStatus()
      if (request.operation !== 'start') throw new Error('Unexpected executor request')
      const held = await withCiDatabasePriority(() => Promise.all([db.pool.connect(), db.pool.connect()]))
      try {
        const executor = await db.pool.connect()
        executor.release()
        starts.push(request.runId)
        return { operation: 'start', run: { runId: request.runId, state: 'running', step: 'build',
          startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, message: null, logBytes: 0 } }
      } finally {
        for (const client of held) client.release()
      }
    },
  }
  const service = new HostCiService(db.pool, {} as PostgresCommandCoordinator,
    {} as CiAuthority, {} as CiCommits, endpoint)
  try {
    const dispatch = service.dispatch()
    await vi.advanceTimersByTimeAsync(2500)
    await dispatch
    await service.drain()
    expect(starts).toEqual([run.id])
    expect(db.read(run.id).record.state).toBe('running')
    expect(db.read(run.id).record.dispatchRequest).toBeUndefined()
  } finally {
    await service.close()
    await db.close()
  }
})

it('keeps the dispatch deadline and refuses a late executor acknowledgement after changing its database pool', async () => {
  vi.useFakeTimers()
  const run = queuedTicket()
  const db = database([run])
  const entered = deferred()
  const reply = deferred()
  const endpoint: HostCiEndpoint = {
    computers: async () => [executor(0)],
    request: async (_computer, request) => {
      if (request.operation === 'status') return readyStatus()
      if (request.operation !== 'start') throw new Error('Unexpected executor request')
      entered.resolve()
      await reply.promise
      return { operation: 'start', run: { runId: request.runId, state: 'running', step: 'build',
        startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, message: null, logBytes: 0 } }
    },
  }
  const service = new HostCiService(db.pool, {} as PostgresCommandCoordinator,
    {} as CiAuthority, {} as CiCommits, endpoint)
  try {
    const dispatch = service.dispatch()
    await vi.advanceTimersByTimeAsync(0)
    await entered.promise
    await vi.advanceTimersByTimeAsync(3001)
    await dispatch
    const claimed = db.read(run.id).record
    expect(claimed).toMatchObject({ state: 'starting', message: null, dispatchRequest: { runId: run.id } })
    reply.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(db.read(run.id).record).toEqual(claimed)
  } finally {
    reply.resolve()
    await service.close()
    await db.close()
  }
})

it('delivers tickets with every shared connection held and releases reserved connections before executor I/O', async () => {
  vi.useFakeTimers()
  const records = [queuedTicket(), queuedTicket()]
  const db = database(records)
  const held = await Promise.all(Array.from({ length: 4 }, () => db.pool.connect()))
  const release = deferred()
  const starts: string[] = []
  const computers = [executor(0), executor(1)]
  const endpoint: HostCiEndpoint = {
    computers: async () => computers,
    request: async (_computer, request) => {
      if (request.operation === 'status') return readyStatus()
      if (request.operation !== 'start') throw new Error('Unexpected executor request')
      starts.push(request.runId)
      await release.promise
      return { operation: 'start', run: { runId: request.runId, state: 'running', step: 'build',
        startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, message: null, logBytes: 0 } }
    },
  }
  const service = new HostCiService(db.pool, {} as PostgresCommandCoordinator,
    {} as CiAuthority, {} as CiCommits, endpoint)
  try {
    const dispatch = service.dispatch()
    await vi.advanceTimersByTimeAsync(2500)
    expect(starts.sort()).toEqual(records.map(run => run.id).sort())
    const reserved = await withCiDatabasePriority(() => Promise.all([db.pool.connect(), db.pool.connect()]))
    for (const client of reserved) client.release()
    release.resolve()
    await vi.advanceTimersByTimeAsync(0)
    await dispatch
    for (const run of records) expect(db.read(run.id).record.state).toBe('running')
  } finally {
    release.resolve()
    for (const client of held) client.release()
    await vi.advanceTimersByTimeAsync(3001)
    await service.close()
    await db.close()
  }
})

it('keeps persisted build validation independent of shared-pool saturation', async () => {
  vi.useFakeTimers()
  const run = queuedTicket()
  const db = database([run])
  const held = await Promise.all(Array.from({ length: 4 }, () => db.pool.connect()))
  const endpoint = new ProductionHostCiEndpoint(db.pool, 'main', () => undefined, {
    handle: async () => { throw new Error('Disabled computers cannot enter the executor') },
  })
  try {
    const reply = Promise.allSettled([withCiDatabasePriority(() => withoutCiDatabaseReservation(() =>
      endpoint.request(executor(0), startRequest(run))))])
    await vi.advanceTimersByTimeAsync(1100)
    expect(await reply).toEqual([{ status: 'rejected', reason: expect.objectContaining({
      code: 'BUILD_COMPUTER_DISABLED',
    }) }])
  } finally {
    for (const client of held) client.release()
    await db.close()
  }
})

it('drains a late cloud acknowledgement after the pass expires while preserving the remaining queue', async () => {
  vi.useFakeTimers()
  const records = [queuedTicket(), queuedTicket({ queuedAt: '2026-10-12T00:00:01.000Z' })]
  const db = database(records)
  const release = deferred()
  const starts: string[] = []
  const endpoint: HostCiEndpoint = { computers: async () => [cloud], request: async (_computer, request) => {
    if (request.operation === 'status') return readyStatus()
    if (request.operation !== 'start') throw new Error('Unexpected fixture executor request')
    starts.push(request.runId)
    await release.promise
    return { operation: 'start', run: { runId: request.runId, state: 'running', step: 'lint',
      startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, message: null, logBytes: 0 } }
  } }
  const service = new HostCiService(db.pool, {} as PostgresCommandCoordinator,
    {} as CiAuthority, {} as CiCommits, endpoint)
  let drained = false
  try {
    const dispatch = service.dispatch()
    await vi.waitFor(() => expect(starts, JSON.stringify(records.map(run => db.read(run.id).record)))
      .toEqual([records[0]!.id]))
    await vi.advanceTimersByTimeAsync(3001)
    await dispatch
    const draining = service.drain().then(() => { drained = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(drained).toBe(false)
    release.resolve()
    await vi.advanceTimersByTimeAsync(0)
    await draining
    expect(db.read(records[0]!.id).record).toMatchObject({ state: 'running' })
    expect(db.read(records[1]!.id).record.state).toBe('queued')
    expect(starts).toEqual([records[0]!.id])
  } finally {
    release.resolve()
    await vi.advanceTimersByTimeAsync(0)
    await service.close()
    await db.close()
  }
})

it.each(['before submission', 'during provider I/O'] as const)(
  'persists claimed cloud delivery with the shared pool saturated %s', async saturation => {
    vi.useFakeTimers()
    const run = queuedTicket()
    const db = database([run])
    const held: pg.PoolClient[] = []
    const occupySharedPool = async () => {
      held.push(...await withoutCiDatabasePriority(() =>
        Promise.all(Array.from({ length: 4 }, () => db.pool.connect()))))
    }
    const release = deferred()
    const starts: string[] = []
    let providerPoolError: unknown
    const endpoint: HostCiEndpoint = { computers: async () => [cloud], request: async (_computer, request) => {
      if (request.operation === 'status') return readyStatus()
      if (request.operation !== 'start') throw new Error('Unexpected fixture executor request')
      starts.push(request.runId)
      if (saturation === 'during provider I/O') await occupySharedPool()
      const reserved = await withCiDatabasePriority(() => Promise.all([db.pool.connect(), db.pool.connect()]))
      for (const client of reserved) client.release()
      providerPoolError = await db.pool.connect().then(client => {
        client.release()
        return null
      }, error => error)
      await release.promise
      return { operation: 'start', run: { runId: request.runId, state: 'running', step: 'build',
        startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, message: null, logBytes: 0 } }
    } }
    const service = new HostCiService(db.pool, {} as PostgresCommandCoordinator,
      {} as CiAuthority, {} as CiCommits, endpoint)
    try {
      if (saturation === 'before submission') await occupySharedPool()
      const dispatch = service.dispatch()
      await vi.advanceTimersByTimeAsync(1500)
      expect(starts).toEqual([run.id])
      expect(db.read(run.id).record.dispatchAttempts).toBe(1)
      expect(providerPoolError).toMatchObject({ message: 'timeout exceeded when trying to connect' })
      expect(held).toHaveLength(4)
      await vi.advanceTimersByTimeAsync(3001)
      await dispatch
      const reserved = await withCiDatabasePriority(() => Promise.all([db.pool.connect(), db.pool.connect()]))
      for (const client of reserved) client.release()
      release.resolve()
      await vi.advanceTimersByTimeAsync(1001)
      await service.drain()
      expect(db.read(run.id).record).toMatchObject({ state: 'running' })
      expect(db.read(run.id).record.dispatchRequest).toBeUndefined()
      expect(starts).toEqual([run.id])
    } finally {
      release.resolve()
      for (const client of held) client.release()
      await vi.advanceTimersByTimeAsync(1001)
      await service.close()
      await db.close()
    }
  },
)
