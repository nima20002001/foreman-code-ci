import { CiComputersOutputSchema, CiGetOutputSchema, CiLogsOutputSchema, CiRunOutputSchema,
  integrationPartition } from '@foreman-code/contracts'
import { expect, it } from 'vitest'
import { CI_GET_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { buildComputerIntegrationShards } from '../src/modules/ci-host/capacity.js'
import { readExecutorSpeeds } from '../src/modules/ci-host/executorSpeed.js'
import { fixture } from './helpers/hostCiMcpFixture.js'
import { ciRunReadback } from './helpers/ciRunReadback.js'

it('waits for computer capacity before saving an immutable partition plan', async () => {
  const f = await fixture()
  let release!: () => void
  const pendingStatus = new Promise<void>(resolve => { release = resolve })
  const request = f.endpoint.request.bind(f.endpoint)
  f.endpoint.request = async (computer, input) => {
    if (input.operation === 'status') await pendingStatus
    return request(computer, input)
  }
  try {
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'integration', scope: 'full', partitions: 2,
    }))
    await f.ci.dispatch()
    const pending = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
    expect(pending.partitions).toHaveLength(2)
    for (const run of pending.partitions!) {
      expect(run).toMatchObject({ state: 'queued', computer: null })
      expect(run.partition?.weights).toBeUndefined()
      expect((await f.pool.query('select record from ci_runs where id=$1', [run.id])).rows[0].record).toEqual(run)
    }
    expect(f.started).toEqual([])
    release()
    await f.value(f.operator, 'ci_computers_list', {})
    await f.ci.dispatch()
    const ready = await f.waitFor(f.operator, started.ticketId, output => output.partitions!.every(run =>
      run.state === 'running' && run.observation?.status === 'available'))
    const shards = buildComputerIntegrationShards({ cpuCount: 16, memoryBytes: 14 * 2 ** 30 })
    for (const run of ready.partitions!) {
      expect(run).toMatchObject({ state: 'running', partition: { weights: [shards, shards] } })
      expect((await f.pool.query('select record from ci_runs where id=$1', [run.id])).rows[0].record).toEqual(run)
    }
  } finally {
    release()
    await f.close()
  }
})

it('splits integration over two build computers, reports progress and logs, and replays a retried command', async () => {
  const f = await fixture()
  try {
    const input = { suite: 'integration', commandId: 'split-integration', partitions: 2 }
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    expect(started.partitions).toHaveLength(2)
    expect(f.published).toHaveLength(1)
    await f.ci.dispatch()
    expect(f.started.map(value => value.computer).sort()).toEqual(['builder', 'laptop'])
    expect(f.started.map(value => value.request.operation === 'start' && value.request.partition?.index).sort())
      .toEqual([0, 1])
    const running = await f.waitFor(f.operator, started.ticketId, output =>
      output.partitions!.every(run => run.state === 'running'))
    expect(running.run).toMatchObject({ state: 'running', suite: 'integration', repository: 'octo/site',
      partition: { index: 0, count: 2 }, computer: { label: expect.any(String) } })
    expect(running.partitions).toHaveLength(2)
    expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(started)
    await f.ci.dispatch()
    expect(f.started).toHaveLength(2)
    for (const [index, partition] of started.partitions!.entries()) {
      f.finish(partition.ticketId, index, index ? 'FAIL apps/api/test/b.integration.test.ts\n' : 'all passed\n')
    }
    // A finished integration ticket settles first; its log and results are collected by the pass that follows.
    await f.ci.dispatch()
    await f.ci.drain()
    const passed = await ciRunReadback(input => f.value(f.operator, 'ci_get', input),
      started.partitions![0]!.ticketId, 'passed')
    expect(passed.run).toMatchObject({ state: 'passed', exitCode: 0 })
    expect(passed.logTail).toBe('all passed\n')
    const failed = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.partitions![1]!.ticketId }))
    expect(failed.run).toMatchObject({ state: 'failed', exitCode: 1 })
    expect(CiLogsOutputSchema.parse(await f.value(f.operator, 'ci_logs_read', { ticketId: started.partitions![1]!.ticketId,
      afterOffset: 5 }))).toEqual({ text: 'apps/api/test/b.integration.test.ts\n', nextOffset: 41, logBytes: 41, maxBytes: 65_536 })
  } finally { await f.close() }
})

it.each([false, true])('sizes each partition by measured computer speed with staggered readiness=%s', async staggered => {
  const f = await fixture()
  let releaseStatus!: () => void
  const pendingStatus = new Promise<void>(resolve => { releaseStatus = resolve })
  let markStatusRequested!: () => void
  const statusRequested = new Promise<void>(resolve => { markStatusRequested = resolve })
  const request = f.endpoint.request.bind(f.endpoint)
  f.endpoint.request = async (computer, input) => {
    if (staggered && input.operation === 'status' && computer.key === f.computers[1]!.key) {
      markStatusRequested()
      await pendingStatus
    }
    return request(computer, input)
  }
  try {
    const historyFile = 'apps/api/test/history.integration.test.ts'
    const historyDurations = { [historyFile]: 400_000 }
    for (const [computer, seconds] of [[f.computers[0]!, 200], [f.computers[1]!, 400]] as const) {
      const finishedAt = new Date(Date.now() - 60_000), startedAt = new Date(finishedAt.getTime() - seconds * 1000)
      const run = { id: crypto.randomUUID(), workspaceId: f.workspaceId, suite: 'integration', commit: 'b'.repeat(40),
        repository: 'octo/site', gate: true, scope: 'full', files: [historyFile], partition: null,
        groupId: crypto.randomUUID(), state: 'passed',
        computer: { hostRef: computer.hostRef, label: computer.label }, step: 'integration', exitCode: 0, message: null,
        queuedAt: startedAt.toISOString(), startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(),
        initiator: { principalId: 'principal-history', executionId: null } }
      await f.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record,durations)
        values($1,$2,$3,'passed',$4::jsonb,$5::jsonb)`,
        [run.id, f.workspaceId, run.groupId, JSON.stringify(run), JSON.stringify(historyDurations)])
    }
    const speeds = await readExecutorSpeeds(f.pool, f.endpoint)
    expect(speeds.get(f.computers[0]!.key)).toMatchObject({ throughput: 2 })
    expect(speeds.get(f.computers[1]!.key)).toMatchObject({ throughput: 1 })
    // The immutable plan uses the ready fleet; both measured computers must be ready before admission.
    const readiness = f.value(f.operator, 'ci_computers_list', {})
    if (staggered) await statusRequested
    expect(f.started).toEqual([])
    releaseStatus()
    const computers = CiComputersOutputSchema.parse(await readiness).computers
    expect(computers).toHaveLength(2)
    expect(computers.map(computer => computer.ready)).toEqual([true, true])
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'integration', commandId: 'weighted',
      partitions: 2 }))
    await f.ci.dispatch()
    const requests = f.started.map(value => ({ computer: value.computer,
      partition: value.request.operation === 'start' ? value.request.partition : undefined }))
    expect(requests).toHaveLength(2)
    const weights = requests[0]!.partition!.weights!
    expect(requests.every(value => JSON.stringify(value.partition!.weights) === JSON.stringify(weights))).toBe(true)
    const byComputer = Object.fromEntries(requests.map(value => [value.computer, weights[value.partition!.index]!]))
    expect(byComputer.laptop! / byComputer.builder!).toBeCloseTo(2, 1)
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
    expect(read.run.partition?.weights).toEqual(weights)
  } finally {
    releaseStatus()
    await f.close()
  }
})

it('persists the heavy-file partition plan through authenticated MCP and denies a read-only caller', async () => {
  const f = await fixture()
  const heavy = [
    'apps/api/test/remote-review-production-main-crash.integration.test.ts',
    'apps/api/test/local-human-native.integration.test.ts',
  ]
  const files = [...heavy, 'apps/api/test/first.integration.test.ts', 'apps/api/test/second.integration.test.ts']
  const expectedFiles = [...files].sort()
  const durations = { [heavy[0]!]: 168_000, [heavy[1]!]: 100_000,
    [files[2]!]: 1_000_000, [files[3]!]: 200_000 }
  try {
    for (const [file, duration] of Object.entries(durations)) {
      await f.pool.query('insert into ci_file_durations(repository,file,duration_ms) values($1,$2,$3)',
        ['octo/site', file, duration])
    }
    const input = { suite: 'integration', scope: 'affected', files, commit: 'a'.repeat(40),
      commandId: 'heavy-partitions', partitions: 2 }
    const reader = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    expect(f.published).toHaveLength(0)
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    await f.ci.dispatch()
    expect(f.started).toHaveLength(2)
    const slices = f.started.map(({ request }) => {
      expect(request.operation).toBe('start')
      if (request.operation !== 'start') throw new Error('Expected a start request')
      expect(request.files).toEqual(expectedFiles)
      expect(request.durations).toEqual(durations)
      return integrationPartition(request.files!, request.durations!, request.partition!)
    })
    expect(slices.flat().sort()).toEqual([...files].sort())
    expect(slices.map(slice => slice.filter(file => heavy.includes(file)).length)).toEqual([1, 1])
    const read = await f.waitFor(reader, started.ticketId, output => output.partitions!.every(run =>
      run.state === 'running' && run.observation?.status === 'available'))
    expect(read.partitions).toHaveLength(2)
    const shards = buildComputerIntegrationShards({ cpuCount: 16, memoryBytes: 14 * 2 ** 30 })
    for (const run of read.partitions!) {
      expect(run).toMatchObject({ scope: 'affected', files: expectedFiles,
        partition: { count: 2, weights: [shards, shards] } })
      const stored = await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1', [run.id])
      expect(stored.rows[0]!.record).toEqual(run)
    }
  } finally { await f.close() }
})

it('queues a run while every computer is busy and starts it on the first one that frees up', async () => {
  const f = await fixture()
  try {
    const first = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'install', commandId: 'one' }))
    const second = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'install', commandId: 'two' }))
    const third = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'install', commandId: 'three' }))
    await f.ci.dispatch()
    const waiting = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: third.ticketId }))
    expect(waiting.run).toMatchObject({ state: 'queued', priority: 'normal',
      message: expect.stringContaining('all CI slots in use (1/1)') })
    expect(waiting.queue).toEqual({ position: 1, reason: waiting.run.message })
    f.finish(first.ticketId, 0, 'ok\n')
    // The pass that notices the finished run settles it in the background; only the pass after it sees the freed slot.
    await f.ci.dispatch()
    await f.ci.drain()
    await f.ci.dispatch()
    await f.ci.drain()
    const moved = await f.waitFor(f.operator, third.ticketId, output => output.run.state === 'running')
    expect(moved.run).toMatchObject({ state: 'running', computer: { label: f.started[0]!.computer }, message: null })
    expect((await f.call(f.operator, 'ci_logs_read', { ticketId: second.ticketId })).isError).not.toBe(true)
  } finally { await f.close() }
})
