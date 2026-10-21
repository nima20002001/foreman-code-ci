import { randomUUID } from 'node:crypto'
import {
  CiGetOutputSchema, CiRunOutputSchema, CiRunRecordSchema, integrationPartition, type CiHostReply, type CiHostRun,
} from '@foreman-code/contracts'
import { afterEach, expect, it, vi } from 'vitest'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { ciReadWhen } from './helpers/ciReadWhen.js'
import { deferred } from './helpers/deferred.js'
import { fixture } from './helpers/hostCiMcpFixture.js'

afterEach(() => { vi.restoreAllMocks() })

it('denies callers without CI grants and asks for a GitHub repository first', async () => {
  const f = await fixture({ repository: false })
  try {
    const reader = await f.connect(CI_GET_ACTIONS)
    const denied = await f.call(reader, 'ci_run', { suite: 'unit', commandId: 'denied' })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    const other = await f.connect([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS], { workspaceIds: ['workspace-other'] })
    expect((await f.call(other, 'ci_run', { suite: 'unit', commandId: 'foreign' })).isError).toBe(true)
    const missing = await f.call(f.operator, 'ci_run', { suite: 'unit', commandId: 'no-repository' })
    expect(missing.isError).toBe(true)
    expect(JSON.stringify(missing.content)).toContain('SOURCE_REPOSITORY_REQUIRED')
    expect((await f.call(f.operator, 'ci_run', { suite: 'unit', commandId: 'split-unit', partitions: 2 })).isError).toBe(true)
    expect((await f.pool.query('select count(*)::int as count from ci_runs')).rows[0].count).toBe(0)
  } finally { await f.close() }
})

it.each([0, 1])('persists a finished integration report through MCP for exit code %s', async exitCode => {
  const f = await fixture()
  try {
    const reader = await f.connect(CI_GET_ACTIONS)
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'integration', commandId: 'finished-report',
    }))
    await f.ci.dispatch()
    f.finish(started.ticketId, exitCode, 'finished\n', { 'apps/api/test/example.integration.test.ts': 1000 })
    await f.ci.dispatch()
    const read = CiGetOutputSchema.parse(await f.value(reader, 'ci_get', {
      ticketId: started.ticketId, testStatus: ['passed', 'failed', 'skipped'],
      waitUntil: 'group-terminal', waitSeconds: 10,
    }))
    expect(read.tests).toEqual({ summary: { passed: 0, failed: 0, skipped: 0 }, files: [], truncated: false })
    expect(read.run).toMatchObject({ state: exitCode === 0 ? 'passed' : 'failed', collection: 'complete' })
    expect((await f.pool.query<{ test_results: unknown }>('select test_results from ci_runs where id=$1',
      [started.ticketId])).rows[0]!.test_results).toEqual(read.tests)
  } finally { await f.close() }
})

it('learns integration file durations from finished runs and hands every partition of the next run the same ones', async () => {
  const f = await fixture()
  const file = (name: string) => `apps/api/test/${name}.integration.test.ts`
  const startedDurations = () => f.started.map(value => value.request.operation === 'start' ? value.request.durations : 'none')
  try {
    const first = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'integration', commandId: 'learn-1',
      partitions: 2 }))
    await f.ci.dispatch()
    // Nothing learned yet: the build computers use the commit's committed durations.
    expect(startedDurations()).toEqual([undefined, undefined])
    f.finish(first.partitions![0]!.ticketId, 0, 'ok\n', { [file('a')]: 1000, [file('b')]: 2000 })
    f.finish(first.partitions![1]!.ticketId, 1, 'FAIL\n', { [file('c')]: 3000 })
    const completed = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', {
      ticketId: first.ticketId, waitUntil: 'group-terminal', waitSeconds: 10,
    }))
    expect(completed.group!.state).toBe('failed')
    expect(completed.partitions!.every(run => run.collection === 'complete')).toBe(true)
    expect((await f.pool.query<{ record: unknown }>('select record from ci_runs where group_id=$1',
      [completed.run.groupId])).rows.map(row => row.record)).toEqual(expect.arrayContaining(completed.partitions!))
    const learned = { [file('a')]: 1000, [file('b')]: 2000, [file('c')]: 3000 }
    const second = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'integration', commandId: 'learn-2',
      partitions: 2 }))
    await f.ci.dispatch()
    expect(startedDurations().slice(2)).toEqual([learned, learned])
    // A slower measurement moves the expectation halfway.
    f.finish(second.partitions![0]!.ticketId, 0, 'ok\n', { [file('a')]: 3000 })
    f.finish(second.partitions![1]!.ticketId, 0, 'ok\n')
    const secondCompleted = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', {
      ticketId: second.ticketId, waitUntil: 'group-terminal', waitSeconds: 10,
    }))
    expect(secondCompleted.group!.state).toBe('passed')
    expect(secondCompleted.partitions!.every(run => run.collection === 'complete')).toBe(true)
    expect((await f.pool.query(`select file,duration_ms,samples from ci_file_durations where repository='octo/site'
      order by file`)).rows).toEqual([{ file: file('a'), duration_ms: 2000, samples: 2 },
      { file: file('b'), duration_ms: 2000, samples: 1 }, { file: file('c'), duration_ms: 3000, samples: 1 }])
    CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'integration', commandId: 'learn-3' }))
    CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'unit', commandId: 'learn-unit' }))
    // ci_run starts a dispatch of its own, which may predate the second run.
    await f.ci.dispatch()
    await f.ci.dispatch()
    expect(f.started.slice(4).map(value => value.request.operation === 'start' && value.request.suite)).toEqual(['integration', 'unit'])
    expect(startedDurations().slice(4)).toEqual([{ ...learned, [file('a')]: 2000 }, undefined])
  } finally { await f.close() }
})

it('counts a finished run\'s durations once when two observations collect it at the same time', async () => {
  const f = await fixture()
  const host = f.computers[0]!
  const file = 'apps/api/test/a.integration.test.ts'
  const startedAt = new Date(Date.now() - 4 * 60 * 60_000).toISOString()
  const finishedAt = new Date().toISOString()
  const release = deferred()
  const bothCollecting = deferred()
  let collecting = 0
  try {
    // A ticket past its running deadline whose executor has already finished it with one measurement.
    const record = CiRunRecordSchema.parse({ id: randomUUID(), groupId: randomUUID(), workspaceId: f.workspaceId,
      suite: 'integration', scope: 'full', files: [], part: null, partition: null, repository: 'fixture/project',
      commit: 'a'.repeat(40), state: 'running', computer: { hostRef: host.hostRef, label: host.label },
      step: 'integration', exitCode: null, message: null, queuedAt: startedAt, startedAt, finishedAt: null,
      initiator: { principalId: 'operator', executionId: null } })
    await f.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,host_key,record,log_tail)
      values($1,$2,$3,$4,$5,$6::jsonb,$7)`, [record.id, record.workspaceId, record.groupId, record.state,
      host.key, JSON.stringify(record), ''])
    const request = f.endpoint.request.bind(f.endpoint)
    vi.spyOn(f.endpoint, 'request').mockImplementation(async (computer, input, options): Promise<CiHostReply> => {
      if (input.operation !== 'read') return request(computer, input, options)
      const run: CiHostRun = { runId: input.runId, state: 'passed', step: 'integration', startedAt, finishedAt,
        exitCode: 0, message: null, logBytes: 0 }
      const durations = { [file]: 3000 }
      if (!input.testResults) return { operation: 'read', run, text: '', nextOffset: 0, durations }
      // Hold result collection until both observations of the finished ticket are collecting it.
      if (++collecting === 2) bothCollecting.resolve()
      await release.promise
      return { operation: 'read', run: { ...run, collection: 'complete' }, text: '', nextOffset: 0, durations,
        testResults: { summary: { passed: 0, failed: 0, skipped: 0 }, files: [], truncated: false } }
    })

    // The deadline sweep reconciles the ticket; settling its outcome wakes dispatch, which observes it as well.
    const expiring = f.ci.expireOverdueRuns()
    await bothCollecting.promise
    release.resolve()
    expect(await expiring).toBe(0)
    await f.ci.drain()

    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: record.id }))
    expect(read.run).toMatchObject({ state: 'passed', collection: 'complete' })
    expect((await f.pool.query(`select file,duration_ms,samples from ci_file_durations
      where repository='fixture/project'`)).rows).toEqual([{ file, duration_ms: 3000, samples: 1 }])
  } finally {
    release.resolve()
    await f.close()
  }
})

it.each(['full', 'affected'] as const)('automatically sizes %s integration via MCP with estimates and persisted readback', async scope => {
  const files = Array.from({ length: 20 }, (_, index) => `apps/api/test/timed-${index}.integration.test.ts`)
  const durations = Object.fromEntries(files.map(file => [file, 120_000]))
  const f = await fixture({ integrationInventory: { files, durations }, cloud: { github: 16, circleci: 28 } })
  f.computers.splice(0, 2)
  try {
    const reader = await f.connect(CI_GET_ACTIONS)
    const input = { suite: 'integration', scope, commit: 'a'.repeat(40), commandId: `automatic-${scope}`,
      ...(scope === 'affected' ? { files: files.slice(0, 6) } : {}) }
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    expect((await f.pool.query('select count(*)::int as count from ci_runs')).rows[0].count).toBe(0)
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    // Idle slots split the work until each part keeps one setup time of tests: one file per part.
    expect(started.partitions).toHaveLength(scope === 'full' ? 20 : 6)
    expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(started)
    // Background observation stamps each running partition on its own schedule; read once all of them have it.
    const read = await ciReadWhen(f.pool, async () => CiGetOutputSchema.parse(await f.value(reader, 'ci_get',
      { ticketId: started.ticketId })), output => output.partitions!.every(run => run.observation?.status === 'available'))
    expect(read.partitions!.every(run => run.expectedDurationMs === 210_000)).toBe(true)
    expect(read.partitions!.every(run => run.state === 'running')).toBe(true)
    expect(read.partitions!.every(run => run.computer?.hostRef.kind === 'cloud')).toBe(true)
    const selected = scope === 'full' ? files : files.slice(0, 6)
    const slices = read.partitions!.map(run => integrationPartition(selected, durations, run.partition!))
    expect(slices.flat().sort()).toEqual([...selected].sort())
    const stored = (await f.pool.query<{ record: unknown }>('select record from ci_runs where group_id=$1',
      [read.run.groupId])).rows.map(row => row.record)
    expect(stored).toEqual(expect.arrayContaining(read.partitions!))
    for (const run of read.partitions!) f.finish(run.id, 0, 'passed')
    await f.ci.dispatch()
    expect(CiGetOutputSchema.parse(await f.value(reader, 'ci_get', {
      ticketId: started.ticketId, waitUntil: 'group-terminal', waitSeconds: 10,
    })).group?.state)
      .toBe('passed')
  } finally { await f.close() }
})
