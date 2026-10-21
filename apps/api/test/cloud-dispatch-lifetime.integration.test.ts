import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { CiRunRecordSchema, type CiHostRun } from '@foreman-code/contracts'
import { createDatabase } from '../src/infrastructure/database.js'
import { withCiDatabasePriority } from '../src/infrastructure/ciDatabasePriority.js'
import { sendCiDispatch } from '../src/modules/ci-host/dispatchRecovery.js'
import { CiDispatchDeadlineError, withCiDispatchDeadline } from '../src/modules/ci-host/dispatchDeadline.js'
import type { HostCiComputer, HostCiEndpoint } from '../src/modules/ci-host/serviceTypes.js'
import { deferred } from './helpers/deferred.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

let fixture: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { fixture = await migratedDatabase() }, 60_000)
afterAll(async () => { await fixture?.close() }, 60_000)

it.each(['start', 'discover', 'cancel'] as const)(
  'settles a claimed cloud %s after its scheduling pass expires without admitting a duplicate', async phase => {
    const database = createDatabase({ connectionString: fixture.databaseUrl, maxConnections: 4, connectionTimeoutMs: 1000 })
    const computer: HostCiComputer = { key: 'fixture-main:cloud:circleci@fixture-org:0', label: 'Fixture CircleCI',
      priority: 30, hostRef: { kind: 'cloud', mainId: 'fixture-main', provider: 'circleci', account: 'fixture-org', slot: 0 } }
    const id = randomUUID()
    const at = new Date(Date.now() - (phase === 'cancel' ? 225_100 : 0)).toISOString()
    const run = CiRunRecordSchema.parse({ id, workspaceId: id, groupId: randomUUID(), suite: 'lint',
      scope: 'full', files: [], partition: null, repository: 'fixture/source', ciMirror: 'fixture-org/ci-mirror',
      commit: 'a'.repeat(40), state: 'starting', computer: { hostRef: computer.hostRef, label: computer.label },
      step: 'dispatch', exitCode: null, message: null, queuedAt: at, startedAt: null, finishedAt: null,
      dispatchedAt: at, dispatchAttempts: phase === 'start' ? 0 : 1,
      dispatchRequest: { operation: 'start', runId: id, repository: 'fixture/source', ciMirror: 'fixture-org/ci-mirror',
        commit: 'a'.repeat(40), suite: 'lint', scope: 'full' },
      initiator: { principalId: 'fixture-operator', executionId: null },
    })
    const entered = deferred()
    const release = deferred()
    const requests: string[] = []
    const observed: CiHostRun = { runId: id, state: 'starting', step: 'dispatch', startedAt: at,
      finishedAt: null, exitCode: null, message: null, logBytes: 0 }
    const endpoint: HostCiEndpoint = { computers: async () => [computer], request: async (_computer, request) => {
      requests.push(request.operation)
      if (request.operation === 'start' || request.operation === 'cancel' || phase === 'discover') {
        entered.resolve()
        await release.promise
      }
      if (request.operation === 'start') return { operation: 'start', run: { ...observed, state: 'running' } }
      if (request.operation === 'read') return { operation: 'read', text: '', nextOffset: 0,
        run: phase === 'discover' ? { ...observed, state: 'running' } : observed }
      if (request.operation === 'cancel') return { operation: 'cancel',
        run: { ...observed, state: 'canceled', finishedAt: new Date().toISOString() } }
      throw new Error(`Unexpected fixture operation: ${request.operation}`)
    } }
    const services: Parameters<typeof sendCiDispatch>[0] = { pool: database.pool, endpoint,
      read: async (_id, _workspaceId, sql) => {
        const row = (await sql.query('select record from ci_runs where id=$1', [id])).rows[0]!
        return CiRunRecordSchema.parse(row.record)
      },
      settle: async (current, _computer, reply, { client }) => client.transaction(async sql => {
        const next = CiRunRecordSchema.parse({ ...current, state: reply.state, step: reply.step,
          startedAt: reply.startedAt, finishedAt: reply.finishedAt, exitCode: reply.exitCode, message: reply.message,
          dispatchRequest: undefined,
          computer: reply.state === 'queued' ? null : current.computer })
        const saved = await sql.query('update ci_runs set state=$2,host_key=$3,record=$4 where id=$1',
          [id, next.state, next.state === 'running' ? computer.key : null, JSON.stringify(next)])
        return saved.rowCount === 1
      }),
    }
    let delivery: Promise<PromiseSettledResult<Awaited<ReturnType<typeof sendCiDispatch>>>> | undefined
    try {
      await database.pool.query('insert into workspaces(id,record) values($1,$2)', [id, '{}'])
      await database.pool.query('insert into ci_runs(id,workspace_id,group_id,state,host_key,record) values($1,$2,$3,$4,$5,$6)',
        [id, id, run.groupId, run.state, computer.key, JSON.stringify(run)])
      const pass = withCiDispatchDeadline(async () => {
        const pending = sendCiDispatch(services, run, computer)
        delivery = Promise.allSettled([pending]).then(results => results[0]!)
        await pending
      })
      const expired = expect(pass).rejects.toBeInstanceOf(CiDispatchDeadlineError)
      await entered.promise
      await expired
      expect((await database.pool.query('select state,host_key from ci_runs where id=$1', [id])).rows[0])
        .toEqual({ state: 'starting', host_key: computer.key })
      expect(await sendCiDispatch(services, run, computer)).toBe('pending')
      const held = await database.pool.query('select ticket_id from ci_dispatch_claims where ticket_id=$1', [id])
      expect(held.rows).toHaveLength(1)
      release.resolve()
      expect(await delivery).toEqual({ status: 'fulfilled', value: 'settled' })
      const saved = (await database.pool.query('select state,host_key,record from ci_runs where id=$1', [id])).rows[0]!
      expect(saved.state).toBe(phase === 'cancel' ? 'queued' : 'running')
      expect(saved.host_key).toBe(phase === 'cancel' ? null : computer.key)
      expect(CiRunRecordSchema.parse(saved.record).dispatchRequest).toBeUndefined()
      expect(requests).toEqual(phase === 'cancel' ? ['read', 'cancel'] : [phase === 'start' ? 'start' : 'read'])
      expect((await database.pool.query('select ticket_id from ci_dispatch_claims where ticket_id=$1', [id])).rows)
        .toEqual([])

      const aborted = new AbortController()
      aborted.abort(new Error('Fixture scheduling pass expired'))
      await expect(withCiDatabasePriority(() => sendCiDispatch(services, run, computer), aborted.signal))
        .rejects.toThrow('Fixture scheduling pass expired')
      expect(requests).toHaveLength(phase === 'cancel' ? 2 : 1)
    } finally {
      release.resolve()
      await delivery
      await database.close()
    }
  },
)
