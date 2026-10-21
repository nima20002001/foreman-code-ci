import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { nextOccurrences, scheduleOccurrenceId } from '@foreman-code/contracts/schedules'
import { WorkflowScheduleService } from '../src/modules/schedules/service.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkflowScheduleDispatcher } from '../src/modules/schedules/dispatcher.js'
import { PostgresScheduleDispatcher } from '../src/modules/schedules/postgresDispatcher.js'
import type { ScheduleDispatchContext } from '../src/modules/schedules/dispatchErrors.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { sch11ClockCases, sch11Minute, sch11Once, sch11Settings } from './helpers/sch11ClockCases.js'
import { sch11DomainState, sch11Fixture, sch11Pool, type Sch11Database, type Sch11Fixture } from './helpers/sch11Fixture.js'
import { sch11Child } from './helpers/sch11Process.js'
import { rejectableDeferred } from './helpers/deferred.js'

/** No `.fails`/skip markers hide product regressions. Except for the established
 * TEST_DATABASE_URL gate, every assertion is a normal failing regression test.
 * OS children use the repo's existing node --import tsx runtime, not a new tool. */
describe.skipIf(!postgresEnabled)('SCH-11 PostgreSQL clock parity / crash recovery', () => {
  let database: Sch11Database
  let f: Sch11Fixture
  beforeAll(async () => { database = await agent3Database() }, 60_000)
  afterAll(async () => { await database?.close() })
  beforeEach(async () => {
    if (f) {
      const previous = await f.current()
      if (previous?.enabled) {
        await f.service.disable(f.writer.principal, 'http', f.command(previous.revision))
      }
    }
    f = await sch11Fixture(database)
  }, 60_000)

  it('a fresh schedule service reads the fixture database and rechecks revoked readers', async () => {
    const saved = await f.save()
    const reader = await f.issue(['workflows:read'])
    const other = sch11Pool(database)
    try {
      const service = new WorkflowScheduleService(other.pool, new PostgresCommandCoordinator(other.pool), f.clock)
      expect(await service.get(reader.principal, f.scope)).toEqual({ schedule: saved })
      expect(await f.access.revoke(reader.principal.id)).toBe(true)
      await expect(service.get(reader.principal, f.scope)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
      expect(await f.service.get(f.writer.principal, f.scope)).toEqual({ schedule: saved })
    } finally {
      await other.pool.end()
    }
  }, 60_000)

  it('a child dispatcher accepts the schedule in the fixture database', async () => {
    const saved = await f.save()
    f.time.now = saved.nextOccurrenceAt!
    const child = sch11Child(f, saved, 'prepared')
    try {
      await child.waitFor('prepared')
      await child.release()
      await child.waitFor('done')
      expect(await child.exited).toEqual({ code: 0, signal: null })
      expect(await f.history()).toEqual([expect.objectContaining({
        id: scheduleOccurrenceId(f.scope.workflowId, saved.nextOccurrenceAt!),
        status: 'accepted',
        workflowVersionId: f.fixture.version.id,
      })])
      expect(await f.countRuns()).toBe(1)
      expect((await f.current())?.nextOccurrenceAt).toBeNull()
    } finally {
      await child.close()
    }
  }, 60_000)

  it.each(sch11ClockCases)('$name: preview equals the persisted acceptance and cursor', async ({ schedule, from, expected }) => {
    f.time.now = from
    const saved = await f.save(schedule)
    expect(saved.nextOccurrenceAt).toBe(expected[0])
    f.time.now = new Date(Date.parse(expected[0]!) - 1).toISOString()
    await f.dispatcher().dispatch(saved)
    expect(await f.countRuns()).toBe(0); expect(await f.history()).toEqual([])
    f.time.now = expected[0]!
    await f.dispatcher().dispatch(saved)
    expect(await f.history()).toEqual([expect.objectContaining({
      id: scheduleOccurrenceId(f.scope.workflowId, expected[0]!), dueAt: expected[0], status: 'accepted',
      reason: null, scheduleRevision: 1, workflowVersionId: f.fixture.version.id,
    })])
    expect(await f.countRuns()).toBe(1)
    expect((await f.current())?.nextOccurrenceAt).toBe(nextOccurrences(schedule, expected[0]!, 1)[0] ?? null)
    // An unchanged stale candidate and a fresh dispatcher never re-admit.
    const state = await sch11DomainState(f)
    await f.dispatcher().dispatch(saved)
    expect(await sch11DomainState(f)).toEqual(state)
    if (schedule.mode !== 'interval' && schedule.timezone === 'America/New_York' && schedule.time === '01:30') {
      f.time.now = '2024-11-03T06:30:00.000Z' // second fold instance, NOT another wall-time occurrence
      await f.dispatcher().dispatch(saved)
      expect(await sch11DomainState(f)).toEqual(state)
    }
  }, 60_000)

  it.each([{ every: 1, unit: 'minute' as const }, { every: 7, unit: 'hour' as const }])(
    'retains the $every-$unit anchor through a fresh service and restarted dispatcher process', async ({ every, unit }) => {
      const configuration = { ...sch11Settings, mode: 'interval' as const, every, unit,
        anchorAt: '2030-01-07T08:59:17.250Z', timezone: 'America/New_York' }
      const saved = await f.save(configuration)
      const other = sch11Pool(database)
      try {
        const restarted = new WorkflowScheduleService(other.pool, new PostgresCommandCoordinator(other.pool), f.clock)
        const readback = (await restarted.get(f.reader.principal, f.scope)).schedule!
        expect(readback).toEqual(saved)
        expect(readback).toMatchObject({ anchorAt: configuration.anchorAt })
        f.time.now = saved.nextOccurrenceAt!
        const child = sch11Child(f, readback, 'prepared')
        try {
          await child.waitFor('prepared'); await child.release(); await child.waitFor('done')
          expect(await child.exited).toEqual({ code: 0, signal: null })
        } finally { await child.close() }
        const after = (await restarted.get(f.reader.principal, f.scope)).schedule!
        expect(after).toMatchObject({ anchorAt: configuration.anchorAt, revision: 1 })
        const duration = every * (unit === 'minute' ? 60_000 : 3_600_000)
        expect(Date.parse(after.nextOccurrenceAt!) - Date.parse(saved.nextOccurrenceAt!)).toBe(duration)
        expect((Date.parse(after.nextOccurrenceAt!) - Date.parse(configuration.anchorAt)) % duration).toBe(0)
        expect((await f.history())[0]?.status).toBe('accepted')
      } finally { await other.pool.end() }
    }, 60_000,
  )

  it('replays an elapsed Once and preserves its pending cursor while rejecting past recurrence edits', async () => {
    const input = { ...f.command(0), schedule: sch11Once }
    const saved = await f.service.save(f.writer.principal, 'http', input)
    f.time.now = '2030-01-07T10:00:00.000Z'
    expect(await f.service.save(f.writer.principal, 'mcp', input)).toEqual({ value: saved.value, replayed: true })
    const unchanged = await f.service.save(f.writer.principal, 'http', { ...f.command(1), schedule: sch11Once })
    expect(unchanged).toEqual({ value: { ...saved.value, revision: 2 }, replayed: false })
    const before = await sch11DomainState(f)
    for (const enabled of [true, false]) {
      await expect(f.service.save(f.writer.principal, 'http', {
        ...f.command(2), schedule: { ...sch11Once, time: '08:59', enabled },
      }))
        .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    }
    expect(await sch11DomainState(f)).toEqual(before)
    expect(await f.current()).toEqual(unchanged.value)
    expect(await f.history()).toEqual([])
    expect(await f.countRuns()).toBe(0)
  }, 60_000)

  it('two real dispatcher processes race the same prepared occurrence; one durable Run and receipt win', async () => {
    const saved = await f.save(); f.time.now = saved.nextOccurrenceAt!
    const first = sch11Child(f, saved, 'prepared'), second = sch11Child(f, saved, 'prepared')
    try {
      await Promise.all([first.waitFor('prepared'), second.waitFor('prepared')])
      await Promise.all([first.release(), second.release()])
      await Promise.all([first.waitFor('done'), second.waitFor('done')])
      expect(await first.exited).toEqual({ code: 0, signal: null })
      expect(await second.exited).toEqual({ code: 0, signal: null })
      const state = await sch11DomainState(f)
      for (const key of ['runs', 'snapshots', 'occurrences', 'runAuthority', 'graphHeads'] as const) expect(state[key]).toHaveLength(1)
      const receipts = await database.pool.query(`select result from management_command_receipts
        where operation='run.start' and result->>'workflowId'=$1`, [f.scope.workflowId])
      expect(receipts.rows).toHaveLength(1)
      expect((await f.history())[0]).toMatchObject({ status: 'accepted', runId: receipts.rows[0]!.result.id })
    } finally { await Promise.all([first.close(), second.close()]) }
  }, 60_000)

  it('SIGKILL mid-claim releases DB locks and rolls back every speculative artifact before restart', async () => {
    const saved = await f.save(); f.time.now = saved.nextOccurrenceAt!
    const before = await sch11DomainState(f)
    const child = sch11Child(f, saved, 'mid-claim')
    let stagedRunId: string, stagedAuthorityId: string
    try {
      const staged = await child.waitFor('mid-claim')
      expect(staged.pid).toEqual(expect.any(Number))
      stagedRunId = staged.runId!; stagedAuthorityId = staged.authorityId!
      expect(stagedRunId).toBeTruthy(); expect(stagedAuthorityId).toBeTruthy()
      // Independent session cannot see uncommitted Run/receipt/cursor changes.
      expect(await sch11DomainState(f)).toEqual(before)
      expect(await child.kill()).toEqual({ code: null, signal: 'SIGKILL' })
    } finally { await child.close() }
    expect(await sch11DomainState(f)).toEqual(before)
    const restarted = sch11Child(f, saved, 'prepared')
    try {
      await restarted.waitFor('prepared'); await restarted.release(); await restarted.waitFor('done')
      expect(await restarted.exited).toEqual({ code: 0, signal: null })
    } finally { await restarted.close() }
    const facts = await f.history()
    expect(facts).toHaveLength(1); expect(facts[0]?.status).toBe('accepted')
    expect(await f.countRuns()).toBe(1)
    if (facts[0]?.status !== 'accepted') throw new Error('Restart did not accept the occurrence')
    expect(facts[0].runId).not.toBe(stagedRunId)
    expect((await database.pool.query('select 1 from management_principals where id=$1', [stagedAuthorityId])).rows).toEqual([])
    for (const table of ['runs', 'run_board_snapshots', 'run_graph_heads', 'run_authority_principals'] as const) {
      const column = table === 'runs' ? 'id' : 'run_id'
      expect((await database.pool.query(`select 1 from ${table} where ${column}=$1`, [stagedRunId])).rows).toEqual([])
    }
    expect((await f.current())?.nextOccurrenceAt).toBeNull()
  }, 60_000)

  it('kills the caller after Start COMMIT but before its acknowledgement; restart does not create or republish', async () => {
    const saved = await f.save(); f.time.now = saved.nextOccurrenceAt!
    const child = sch11Child(f, saved, 'lost-start-ack')
    try {
      const committed = await child.waitFor('committed')
      const facts = await f.history()
      expect(facts).toHaveLength(1)
      expect(facts[0]).toMatchObject({ status: 'accepted', runId: committed.runId })
      const committedState = await sch11DomainState(f)
      expect(await child.kill()).toEqual({ code: null, signal: 'SIGKILL' })
      // The recovered process receives only the stale scan candidate, not a
      // successful Start result. It must consult durable state, not retry a launch.
      const restarted = sch11Child(f, saved, 'prepared')
      try {
        await restarted.waitFor('done')
        expect(await restarted.exited).toEqual({ code: 0, signal: null })
      } finally { await restarted.close() }
      expect(await sch11DomainState(f)).toEqual(committedState)
      expect(await f.countRuns()).toBe(1)
    } finally { await child.close() }
  }, 60_000)

  it('catches up after 25 hours in one dispatch, never backfills an earlier Run', async () => {
    await f.save(sch11Minute)
    f.time.now = '2030-01-08T10:01:30.000Z' // 1,501 due instants; well beyond one 100-row batch.
    await f.dispatcher().dispatch((await f.current())!)
    const facts = await f.history()
    expect(facts).toHaveLength(1_501)
    expect(new Set(facts.map((fact) => fact.id)).size).toBe(1_501)
    expect(facts[0]).toMatchObject({ status: 'accepted', dueAt: '2030-01-08T10:01:00.000Z' })
    expect(facts.slice(1).every((fact) => fact.status === 'missed')).toBe(true)
    expect(facts.filter((fact) => fact.reason === 'superseded')).toHaveLength(4)
    expect(facts.filter((fact) => fact.reason === 'outside_grace')).toHaveLength(1_496)
    expect(await f.countRuns()).toBe(1)
    expect(await f.current()).toMatchObject({ revision: 1, anchorAt: sch11Minute.anchorAt,
      nextOccurrenceAt: '2030-01-08T10:02:00.000Z' })
  }, 90_000)

  it('considers a day-old seconds cursor during the first poll while the clock advances', async () => {
    const saved = await f.save({ ...sch11Minute, unit: 'second' })
    const resumedAt = Date.parse(saved.nextOccurrenceAt!) + 86_400_000
    let clockReads = 0
    const clock = () => new Date(resumedAt + clockReads++ * 2)
    const considered = rejectableDeferred()
    let attemptedDue: string | undefined
    const port = new PostgresScheduleDispatcher(database.pool, async (_principal, input) => {
      attemptedDue = input.commandId
      considered.resolve()
      throw new Error('Temporary admission unavailability')
    }, clock)
    let scans = 0
    const failures: Array<{ error: unknown; context: ScheduleDispatchContext | undefined }> = []
    const loop = new WorkflowScheduleDispatcher({
      listDueSchedules: async (input) => {
        scans++
        return port.listDueSchedules(input)
      },
      dispatch: (...args) => port.dispatch(...args),
    }, { clock, reportError: (error, context) => { failures.push({ error, context }) }, pollIntervalMs: 60_000 })
    loop.start()
    try {
      await considered.promise
      await loop.stop()
      expect(scans).toBe(1)
      expect(attemptedDue).toBeTruthy()
      const cursor = (await f.current())!.nextOccurrenceAt!
      expect(failures).toEqual([expect.objectContaining({ context: {
        workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId, dueAt: cursor,
      } })])
      expect(Date.parse(cursor)).toBeGreaterThanOrEqual(resumedAt)
      expect(Date.parse(clock().toISOString()) - Date.parse(cursor)).toBeLessThan(1_000)
      const counts = (await database.pool.query<{ count: string; latest: Date }>(
        `select count(*)::text as count,max(due_at) as latest from workflow_schedule_occurrences where workflow_id=$1`,
        [f.scope.workflowId])).rows[0]!
      expect(Number(counts.count)).toBeGreaterThanOrEqual(86_400)
      expect(counts.latest.toISOString()).toBe(new Date(Date.parse(cursor) - 1_000).toISOString())
      expect(await f.countRuns()).toBe(0)
    } finally { await loop.stop() }
  }, 30_000)

  it('clean shutdown drains an open real Start transaction and never admits the next queued candidate', async () => {
    const saved = await f.save(); f.time.now = saved.nextOccurrenceAt!
    const others = await Promise.all(Array.from({ length: 4 }, () => sch11Fixture(database)))
    const otherSaved = await Promise.all(others.map(async (fixture) => {
      const schedule = await fixture.save()
      fixture.time.now = f.time.now
      return schedule
    }))
    const entered = rejectableDeferred(), release = rejectableDeferred()
    const dispatcher = f.dispatcher(async (principal, input, guard) => {
      await f.startUsing()(principal, input, { ...guard, afterAcceptance: async (sql, run) => {
        await guard.afterAcceptance(sql, run); entered.resolve(); await release.promise
      } })
    })
    let scans = 0
    const loop = new WorkflowScheduleDispatcher({
      // Candidate isolation only: admission, common Start, locks and writes below are real SQL.
      listDueSchedules: async () => { scans++; return { items: [saved, ...otherSaved], pageInfo: { nextCursor: null } } },
      dispatch: (candidate, signal) => {
        if (candidate.workflowId === f.scope.workflowId) return dispatcher.dispatch(candidate, signal)
        const fixture = others.find((other) => other.scope.workflowId === candidate.workflowId)!
        return fixture.dispatcher(async (principal, input, guard) => {
          await release.promise
          await fixture.startUsing()(principal, input, guard)
        }).dispatch(candidate, signal)
      },
    }, { clock: f.clock, reportError: (error) => { throw error } })
    const work = loop.tick()
    let stopped = false
    let closing: Promise<void> | undefined
    try {
      await entered.promise
      closing = loop.stop().then(() => { stopped = true })
      expect(stopped).toBe(false)
      expect(await f.countRuns()).toBe(0)
      release.resolve(); await Promise.all([work, closing])
      expect(stopped).toBe(true)
      expect(await f.countRuns()).toBe(1)
      expect(await Promise.all(others.map((fixture) => fixture.countRuns()))).toEqual([1, 1, 1, 0])
      await loop.stop(); loop.start(); await loop.tick()
      expect(scans).toBe(1)
      expect(await others[3]!.current()).toEqual(otherSaved[3])
    } finally { release.resolve(); await work.catch(() => undefined); await closing; await loop.stop() }
  }, 60_000)
})
