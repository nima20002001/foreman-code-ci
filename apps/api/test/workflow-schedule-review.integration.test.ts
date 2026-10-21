import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { RunStartV3Input } from '@foreman-code/contracts/wave25'
import { DomainError } from '../src/modules/errors.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { sch11Minute, sch11Once } from './helpers/sch11ClockCases.js'
import { sch11Fixture, type Sch11Database, type Sch11Fixture } from './helpers/sch11Fixture.js'
import { rejectableDeferred } from './helpers/deferred.js'

async function reached<T>(signal: Promise<T>, work: Promise<void>): Promise<T> {
  return Promise.race([signal, work.then(() => { throw new Error('Dispatch completed before the expected barrier') })])
}

describe.skipIf(!postgresEnabled)('SCH-01/02 occurrence identity and final eligibility regressions', () => {
  let database: Sch11Database
  let f: Sch11Fixture
  beforeAll(async () => { database = await agent3Database() }, 60_000)
  afterAll(async () => { await database?.close() })
  beforeEach(async () => { f = await sch11Fixture(database, '2030-01-07T09:59:00.000Z') }, 60_000)

  async function saveNewVersion() {
    const row = (await database.pool.query<{ revision: string }>(
      'select revision::text from workflows where id=$1', [f.scope.workflowId])).rows[0]!
    const policy = f.fixture.version.definition.executionPolicy
    if (!policy || typeof policy.maxNodeExecutions !== 'number') throw new Error('Expected the executable SCH-11 fixture policy')
    return (await f.workflows.current.save(f.writer.principal, 'http', {
      ...f.scope, commandId: randomUUID(), executionSemanticsVersion: 3,
      expectedRevision: Number(row.revision), expectedWorkflowVersionId: f.fixture.version.id,
      expectedAgentConfigurationVersionIds: f.fixture.version.agentConfigurationVersionIds,
      graph: { ...f.fixture.version.definition,
        executionPolicy: { ...policy, maxNodeExecutions: policy.maxNodeExecutions + 1 } },
    })).value
  }

  it.each([false, true])('SCH-01: a delayed failure cannot reject the next occurrence (peer advanced cursor: %s)', async (peerAdvances) => {
    const saved = await f.save(sch11Minute)
    expect(saved.nextOccurrenceAt).toBe('2030-01-07T10:00:00.000Z')
    f.time.now = saved.nextOccurrenceAt!
    const failed = rejectableDeferred(), releaseFailure = rejectableDeferred()
    const peerPrepared = rejectableDeferred(), releasePeer = rejectableDeferred()
    const starts: RunStartV3Input[] = []
    let peer: Promise<void> | undefined
    const work = f.dispatcher(async (principal, input, guard) => {
      starts.push(input)
      if (starts.length === 1) {
        // Inject the classified Start failure, not a SQL/COMMIT failure. Its
        // delayed delivery must not carry this occurrence's reason forward.
        failed.resolve(); await releaseFailure.promise
        throw new DomainError('WORKFLOW_CONFIGURATION_STALE', 'Injected stale configuration', 409)
      }
      await f.startUsing()(principal, input, guard)
    }).dispatch(saved)
    void work.catch(() => {
      // ignore: attach while the dispatcher is paused; the original work is awaited below.
    })
    try {
      await reached(failed.promise, work)
      const newer = await saveNewVersion()
      expect(newer.version.id).not.toBe(f.fixture.version.id)
      f.time.now = '2030-01-07T10:01:00.000Z'
      if (peerAdvances) {
        // The peer really commits the missed 10:00 fact and advances the SQL
        // cursor, then pauses before admitting 10:01. No cursor is forged.
        peer = f.dispatcher(async (...args) => {
          peerPrepared.resolve(); await releasePeer.promise
          await f.startUsing()(...args)
        }).dispatch(saved)
        void peer.catch(() => {
          // ignore: attach while the peer is paused; the original peer work is awaited below.
        })
        await reached(peerPrepared.promise, peer)
        expect((await f.current())?.nextOccurrenceAt).toBe('2030-01-07T10:01:00.000Z')
      }
      releaseFailure.resolve(); await work
      expect(starts.map((input) => input.workflowVersionId)).toEqual([f.fixture.version.id, newer.version.id])
      releasePeer.resolve(); await peer
      expect(await f.countRuns()).toBe(1)
      expect(await f.history()).toEqual([
        expect.objectContaining({ dueAt: '2030-01-07T10:01:00.000Z', status: 'accepted', workflowVersionId: newer.version.id }),
        expect.objectContaining({ dueAt: '2030-01-07T10:00:00.000Z', status: 'missed', reason: 'superseded' }),
      ])
      expect((await f.current())?.nextOccurrenceAt).toBe('2030-01-07T10:02:00.000Z')
      const rows = await database.pool.query(`select r.workflow_version_id,s.workflow_version_id as snapshot_version,
        c.result->>'workflowVersionId' as receipt_version from runs r join run_board_snapshots s on s.run_id=r.id
        join management_command_receipts c on c.operation='run.start' and c.result->>'id'=r.id where r.workflow_id=$1`,
      [f.scope.workflowId])
      expect(rows.rows).toEqual([{ workflow_version_id: newer.version.id,
        snapshot_version: newer.version.id, receipt_version: newer.version.id }])
    } finally {
      releaseFailure.resolve(); releasePeer.resolve()
      await work.catch(() => {
        // ignore: cleanup joins the dispatcher without replacing an earlier test failure.
      })
      await peer?.catch(() => {
        // ignore: cleanup joins the peer without replacing an earlier test failure.
      })
    }
  }, 60_000)

  it('SCH-01: an eligible failed occurrence still records its own rejection exactly once', async () => {
    const saved = await f.save(); f.time.now = saved.nextOccurrenceAt!
    let starts = 0
    const dispatcher = f.dispatcher(async () => {
      starts++
      throw new DomainError('WORKFLOW_CONFIGURATION_STALE', 'Injected stale configuration', 409)
    })
    await dispatcher.dispatch(saved)
    await dispatcher.dispatch(saved)
    expect(starts).toBe(1)
    expect(await f.countRuns()).toBe(0)
    expect(await f.history()).toEqual([expect.objectContaining({ dueAt: saved.nextOccurrenceAt,
      status: 'rejected', reason: 'workflow_not_executable' })])
    expect((await f.current())?.nextOccurrenceAt).toBeNull()
  }, 60_000)

  it.each([
    { name: 'Once exceeds grace by 1 ms', schedule: sch11Once, before: 300_000, after: 300_001, reason: 'outside_grace' },
    { name: 'minute interval reaches its next due instant', schedule: sch11Minute, before: 59_999, after: 60_000, reason: 'superseded' },
  ])('SCH-02: final overlap read cannot admit after $name', async ({ schedule, before, after, reason }) => {
    const saved = await f.save(schedule)
    const dueAt = saved.nextOccurrenceAt!
    f.time.now = new Date(Date.parse(dueAt) + before).toISOString()
    interface Artifacts extends pg.QueryResultRow {
      runs: number; snapshots: number; receipts: number; authorities: number; accepted: number
    }
    const overlapRead = rejectableDeferred<Artifacts>(), releaseOverlap = rejectableDeferred()
    const nextPrepared = rejectableDeferred(), releaseNext = rejectableDeferred()
    let failedRunId: string | undefined, failedAuthorityId: string | undefined
    let calls = 0
    const work = f.dispatcher(async (principal, input, guard) => {
      if (++calls > 1) {
        nextPrepared.resolve(); await releaseNext.promise
        await f.startUsing()(principal, input, guard)
        return
      }
      await f.startUsing()(principal, input, { ...guard, afterAcceptance: async (sql, run) => {
        await guard.afterAcceptance(sql, run)
        failedRunId = run.id; failedAuthorityId = run.authorizationPrincipalId
        const query = sql.query
        // Delay only the real overlap query in beforeGraphCommit, after its SQL
        // result but before its promise reaches validate(). Keep the SAME branded
        // transaction and real query results; no alternate transaction or clock.
        sql.query = async <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]) => {
          const result = await query<R>(text, values)
          if (text.includes('join runs run on run.id=occurrence.run_id') && values?.[2] === run.id) {
            const artifacts = (await query<Artifacts>(`select
              (select count(*) from runs where id=$1)::int as runs,
              (select count(*) from run_board_snapshots where run_id=$1)::int as snapshots,
              (select count(*) from management_command_receipts where operation='run.start' and result->>'id'=$1)::int as receipts,
              (select count(*) from run_authority_principals where run_id=$1)::int as authorities,
              (select count(*) from workflow_schedule_occurrences where run_id=$1 and status='accepted')::int as accepted`,
            [run.id])).rows[0]!
            overlapRead.resolve(artifacts); await releaseOverlap.promise
          }
          return result
        }
      } })
    }).dispatch(saved)
    void work.catch(() => {
      // ignore: attach while the dispatcher is paused; the original work is awaited below.
    })
    try {
      const artifacts = await reached(overlapRead.promise, work)
      expect(artifacts).toMatchObject({ runs: 1, snapshots: 1, receipts: 1, accepted: 1 })
      expect(artifacts.authorities).toBeGreaterThan(0)
      expect(failedAuthorityId).toBeTypeOf('string')
      expect(await f.countRuns()).toBe(0) // speculative rows are not publicly committed
      f.time.now = new Date(Date.parse(dueAt) + after).toISOString()
      releaseOverlap.resolve()
      if (schedule.mode === 'interval') await reached(nextPrepared.promise, work)
      else await work

      // Assert by the captured IDs, not by joining surviving Runs (which would
      // hide leaked authority/snapshot rows after a partial rollback).
      for (const statement of [
        'select 1 from runs where id=$1',
        'select 1 from run_board_snapshots where run_id=$1',
        'select 1 from run_authority_principals where run_id=$1',
        'select 1 from run_graph_heads where run_id=$1',
        "select 1 from management_command_receipts where operation='run.start' and result->>'id'=$1",
        'select 1 from workflow_schedule_occurrences where run_id=$1',
      ]) expect((await database.pool.query(statement, [failedRunId])).rows).toEqual([])
      expect((await database.pool.query('select 1 from management_principals where id=$1', [failedAuthorityId])).rows).toEqual([])
      expect(await f.history()).toEqual([expect.objectContaining({ dueAt, status: 'missed', reason })])
      expect(await f.countRuns()).toBe(0)
      expect((await f.current())?.nextOccurrenceAt).toBe(schedule.mode === 'interval'
        ? new Date(Date.parse(dueAt) + 60_000).toISOString() : null)

      releaseNext.resolve(); await work
      if (schedule.mode === 'interval') {
        const facts = await f.history()
        expect(facts).toEqual([
          expect.objectContaining({ dueAt: '2030-01-07T10:01:00.000Z', status: 'accepted' }),
          expect.objectContaining({ dueAt, status: 'missed', reason }),
        ])
        const accepted = facts[0]
        if (accepted?.status !== 'accepted') throw new Error('Expected the independently accepted next occurrence')
        expect(accepted.runId).not.toBe(failedRunId)
        expect(await f.countRuns()).toBe(1)
      }
    } finally {
      releaseOverlap.resolve(); releaseNext.resolve()
      await work.catch(() => {
        // ignore: cleanup joins the dispatcher without replacing an earlier test failure.
      })
    }
  }, 60_000)
})
