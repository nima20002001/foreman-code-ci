import { randomUUID } from 'node:crypto'
import {
  CiComputersOutputSchema, CiGetOutputSchema, CiRunOutputSchema, CiRunRecordSchema, integrationPartition,
} from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expect, it, vi } from 'vitest'
import { CI_GET_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { fixture } from './helpers/hostCiMcpFixture.js'
import { ciRunReadback } from './helpers/ciRunReadback.js'

it.each(['github', 'circleci'] as const)('runs user-systemd slices on capable %s slots through authenticated MCP', async provider => {
  const f = await fixture({ cloud: { github: provider === 'github' ? 2 : 0, circleci: provider === 'circleci' ? 2 : 0 },
    cloudSystemd: true })
  f.computers.splice(0, 2)
  const systemd = 'apps/api/test/native-service-restart.integration.test.ts'
  const ordinary = 'apps/api/test/agent-chat.integration.test.ts'
  try {
    const reader = await f.connect(CI_GET_ACTIONS)
    const input = { suite: 'integration', scope: 'affected', files: [systemd, ordinary], commit: 'a'.repeat(40),
      commandId: 'cloud-systemd' }
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    expect(f.started).toHaveLength(0)
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(started)
    await f.ci.dispatch()
    const read = await f.waitFor(reader, started.ticketId, output => output.partitions!.every(run =>
      run.state === 'running' && run.observation?.status === 'available'))
    expect(read.partitions).toHaveLength(2)
    for (const run of read.partitions!) {
      expect(run).toMatchObject({ state: 'running', computer: { hostRef: { kind: 'cloud', provider } } })
      expect((await f.pool.query('select record from ci_runs where id=$1', [run.id])).rows[0].record).toEqual(run)
    }
    const slices = read.partitions!.map(run => integrationPartition(run.files, {}, run.partition!))
    expect(slices).toContainEqual([systemd])
    expect(slices).toContainEqual([ordinary])
    const listed = CiComputersOutputSchema.parse(await f.value(reader, 'ci_computers_list', {}))
    expect(listed.computers.every(computer => computer.userSystemd?.supported)).toBe(true)
    for (const run of read.partitions!) f.finish(run.id, 0, 'Systemd cloud slice completed.\n')
    const completed = await ciRunReadback(input => f.value(reader, 'ci_get', input), started.ticketId, 'passed')
    expect(completed.partitions!.every(run => run.state === 'passed')).toBe(true)
  } finally { await f.close() }
})

it.each(['mcp', 'http'] as const)('reads queued user-systemd slices through %s while ordinary files run on cloud, then clears the wait on start', async transport => {
  const readiness = { laptop: true }
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  const f = await fixture({ github: readiness, cloud: true })
  f.computers.splice(1, 1)
  const systemd = [
    'apps/api/test/workflow-systemd-active-recovery.integration.test.ts',
    'apps/api/test/native-service-restart.integration.test.ts',
  ]
  const ordinary = [
    'apps/api/test/agent-chat.integration.test.ts',
    'apps/api/test/remote-review-production-main-crash.integration.test.ts',
    'apps/api/test/workflow-systemd-restart.integration.test.ts',
  ]
  try {
    const reader = await f.connect(CI_GET_ACTIONS)
    const older = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'integration', commandId: 'older-integration',
    }))
    await f.ci.dispatch()
    const slices = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'integration', scope: 'affected', files: [...systemd, ...ordinary], commit: 'a'.repeat(40),
      commandId: 'waiting-integration',
    }))
    expect(slices.partitions).toHaveLength(2)
    await f.ci.dispatch()
    await f.ci.dispatch()
    const credential = await f.credential(CI_GET_ACTIONS)
    const read = async () => {
      if (transport === 'http') {
        const response = await f.app.inject({ method: 'GET',
          url: `/api/management/workspaces/${f.workspaceId}/ci/${slices.ticketId}`,
          headers: { authorization: `Bearer ${credential.token}` } })
        expect(response.statusCode).toBe(200)
        return CiGetOutputSchema.parse(response.json())
      }
      const result = await reader.callTool({ name: 'ci_get', arguments: {
        workspaceId: f.workspaceId, ticketId: slices.ticketId,
      } })
      expect(result.isError).not.toBe(true)
      return CiGetOutputSchema.parse(decodeMcpToolResult(result))
    }
    await expect.poll(async () => (await read()).partitions!.map(run => run.state).sort())
      .toEqual(['queued', 'running'])
    const waiting = await read()
    const selectedSlices = waiting.partitions!.map(run => integrationPartition(run.files, {}, run.partition!))
    expect(selectedSlices.every(slice => slice.length > 0)).toBe(true)
    expect(selectedSlices.flat().sort()).toEqual([...systemd, ...ordinary].sort())
    const host = waiting.partitions!.find(run => run.partition!.hostIndexes!.includes(run.partition!.index))!
    const sibling = waiting.partitions!.find(run => run.id !== host.id)!
    expect(host).toMatchObject({ state: 'queued', computer: null,
      message: expect.stringContaining('all CI slots in use (1/1)') })
    expect(sibling).toMatchObject({ state: 'running', computer: { hostRef: { kind: 'cloud' } } })
    // Systemd files stay on the host; ordinary files still balance across every slice.
    expect(integrationPartition(host.files, {}, host.partition!).sort()).toEqual([...systemd, ordinary[0]!].sort())
    expect(integrationPartition(sibling.files, {}, sibling.partition!).sort()).toEqual(ordinary.slice(1).sort())
    expect((await f.pool.query('select record from ci_runs where id=$1', [host.id])).rows[0].record).toEqual(host)
    const computers = CiComputersOutputSchema.parse(await f.value(reader, 'ci_computers_list', {}))
    expect(computers.computers.find(computer => computer.hostRef.kind === 'cloud')?.userSystemd)
      .toEqual({ supported: false, reason: 'Executor has no systemd user manager' })
    expect(computers.computers.find(computer => computer.label === 'laptop'))
      .toMatchObject({ ready: true, running: [older.ticketId], slotsUsed: 1, slotsTotal: 1 })
    expect(computers.queue).toContainEqual({ ticketId: host.id, priority: 'normal', priorityReason: 'normal',
      position: 1, reason: host.message })

    f.finish(sibling.id, 0, 'Cloud slice completed.\n')
    await f.ci.dispatch()
    expect((await read()).partitions!.find(run => run.id === host.id)).toEqual(host)
    readiness.laptop = false
    clock.mockReturnValue(now + 5001)
    f.finish(older.ticketId, 0, 'Older integration completed.\n')
    await f.ci.dispatch()
    const unavailable = await f.waitFor(reader, slices.ticketId, output => output.partitions!.some(run =>
      run.id === host.id && run.message?.includes('gh auth login')))
    const unready = unavailable.partitions!.find(run => run.id === host.id)!
    expect(unready).toMatchObject({ state: 'queued',
      message: 'Waiting for a build computer: this integration slice needs one; laptop: Log in to GitHub on this computer (gh auth login).' })
    expect((await f.pool.query('select record from ci_runs where id=$1', [host.id])).rows[0].record).toEqual(unready)
    await f.ci.dispatch()
    expect((await read()).partitions!.find(run => run.id === host.id)).toEqual(unready)

    readiness.laptop = true
    clock.mockReturnValue(now + 10_002)
    await f.ci.dispatch()
    const startedHost = await f.waitFor(reader, slices.ticketId, output =>
      output.partitions!.some(run => run.id === host.id && run.state === 'running'
        && run.observation?.status === 'available'))
    const running = startedHost.partitions!.find(run => run.id === host.id)!
    expect(running).toMatchObject({ state: 'running', computer: { label: 'laptop' }, message: null,
      observation: { status: 'available', consecutiveFailures: 0, lastError: null,
        lastSuccessAt: expect.any(String), nextAttemptAt: null } })
    expect((await f.pool.query('select record from ci_runs where id=$1', [host.id])).rows[0].record).toEqual(running)
  } finally {
    await f.close()
    clock.mockRestore()
  }
})

it('uses every cloud slot for ordinary integration files and persists throughput weights through authenticated MCP', async () => {
  let releaseGithub!: () => void
  const githubReady = new Promise<void>(resolve => { releaseGithub = resolve })
  let githubStatusRequested!: () => void
  const githubStatus = new Promise<void>(resolve => { githubStatusRequested = resolve })
  const f = await fixture({ cloud: { github: 4, circleci: 4 }, beforeStatus: async computer => {
    if (computer.hostRef.provider === 'github') {
      githubStatusRequested()
      await githubReady
    }
  } })
  f.computers.splice(0, 2)
  const files = [
    ...Array.from({ length: 256 }, (_, index) => `apps/api/test/ordinary-${index}.integration.test.ts`),
    'apps/api/test/remote-review-production-main-crash.integration.test.ts',
    'apps/api/test/workflow-systemd-restart.integration.test.ts',
  ]
  const durations = Object.fromEntries(files.map(file => [file, 1000]))
  try {
    const circle = f.computers.filter(computer => computer.hostRef.provider === 'circleci')
    const github = f.computers.find(computer => computer.hostRef.provider === 'github')!
    const historyFile = 'apps/api/test/history.integration.test.ts'
    for (const [computer, seconds] of [[circle[0]!, 200], [github, 400]] as const) {
      const finishedAt = new Date(Date.now() - 60_000).toISOString()
      const startedAt = new Date(Date.parse(finishedAt) - seconds * 1000).toISOString()
      const history = CiRunRecordSchema.parse({ id: randomUUID(), workspaceId: f.workspaceId,
        suite: 'integration', commit: 'b'.repeat(40), repository: 'octo/site',
        gate: true, scope: 'full', files: [historyFile], partition: null,
        groupId: randomUUID(), state: 'passed', step: 'integration', exitCode: 0, message: null,
        computer: { hostRef: computer.hostRef, label: computer.label }, queuedAt: startedAt, startedAt, finishedAt,
        initiator: { principalId: 'principal-history', executionId: null } })
      await f.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record,durations)
        values($1,$2,$3,'passed',$4::jsonb,$5::jsonb)`,
        [history.id, f.workspaceId, history.groupId, JSON.stringify(history), JSON.stringify({ [historyFile]: 400_000 })])
    }
    for (const file of files) {
      await f.pool.query('insert into ci_file_durations(repository,file,duration_ms) values($1,$2,$3)',
        ['octo/site', file, durations[file]])
    }
    const input = { suite: 'integration', scope: 'affected', files, commit: 'a'.repeat(40),
      partitions: 8, commandId: 'cloud-integration' }
    const reader = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    expect(f.published).toHaveLength(0)
    // Weights describe the fleet ready at planning time, so finish every status probe before admission.
    const listing = f.value(reader, 'ci_computers_list', {})
    await githubStatus
    releaseGithub()
    const ready = CiComputersOutputSchema.parse(await listing)
    expect(ready.computers).toHaveLength(8)
    expect(ready.computers.every(computer => computer.ready && computer.slotsUsed === 0)).toBe(true)
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    await f.ci.dispatch()
    expect(f.started).toHaveLength(8)
    expect(new Set(f.started.map(value => value.computer)).size).toBe(8)
    expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(started)
    const slices = f.started.map(({ request }) => {
      if (request.operation !== 'start') throw new Error('Expected a start request')
      expect(request.partition?.hostIndexes).toBeUndefined()
      return integrationPartition(request.files!, request.durations!, request.partition!)
    })
    expect(slices.flat().sort()).toEqual([...files].sort())
    const read = await f.waitFor(reader, started.ticketId, output => output.partitions!.every(run =>
      run.state === 'running' && run.observation?.status === 'available'))
    expect(read.partitions).toHaveLength(8)
    const faster = read.partitions!.find(run => run.computer?.label === circle[0]!.label)!
    const slower = read.partitions!.find(run => run.computer?.label === github.label)!
    const weights = faster.partition!.weights!
    expect(weights[faster.partition!.index]! / weights[slower.partition!.index]!).toBeCloseTo(2, 1)
    for (const run of read.partitions!.filter(run => run.computer?.hostRef.provider === 'circleci')) {
      expect(weights[run.partition!.index]).toBe(weights[faster.partition!.index])
    }
    const work = (run: typeof faster) => integrationPartition(run.files, durations, run.partition!).length
    expect(work(faster) / work(slower)).toBeGreaterThan(1.7)
    expect(work(faster) / work(slower)).toBeLessThan(2.3)
    for (const run of read.partitions!) {
      expect(run).toMatchObject({ state: 'running', computer: { hostRef: { kind: 'cloud' } } })
      expect(run.partition?.weights).toEqual(weights)
      expect((await f.pool.query('select record from ci_runs where id=$1', [run.id])).rows[0].record).toEqual(run)
      f.finish(run.id, 0, 'Cloud integration completed.\n')
    }
    await f.ci.dispatch()
    const finished = await ciRunReadback(input => f.value(reader, 'ci_get', input), started.ticketId, 'passed')
    expect(finished.partitions!.every(run => run.state === 'passed')).toBe(true)
  } finally {
    releaseGithub()
    await f.close()
  }
})

it('runs an ordinary unpartitioned integration selection on cloud without a build computer', async () => {
  const f = await fixture({ cloud: true })
  f.computers.splice(0, 2)
  try {
    const files = ['apps/api/test/agent-chat.integration.test.ts']
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'integration', scope: 'affected', files, commit: 'a'.repeat(40), commandId: 'ordinary-integration',
    }))
    await f.ci.dispatch()
    const read = await f.waitFor(f.operator, started.ticketId, output => output.run.state === 'running')
    expect(read.run).toMatchObject({ state: 'running', files, partition: null,
      computer: { hostRef: { kind: 'cloud' } } })
  } finally { await f.close() }
})

it('keeps every selected file in a nonempty slice when most files require user systemd', async () => {
  const f = await fixture({ cloud: { github: 1, circleci: 1 } })
  f.computers.splice(0, 2)
  const systemd = [
    'apps/api/test/native-service-restart.integration.test.ts',
    'apps/api/test/workflow-systemd-active-recovery.integration.test.ts',
  ]
  const ordinary = 'apps/api/test/agent-chat.integration.test.ts'
  try {
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'integration', scope: 'affected', files: [...systemd, ordinary], commit: 'a'.repeat(40),
      partitions: 3, commandId: 'mostly-systemd',
    }))
    await f.ci.dispatch()
    const read = await f.waitFor(f.operator, started.ticketId, output => output.partitions!.every(run =>
      run.state === 'queued' || run.state === 'running' && run.observation?.status === 'available')
      && output.partitions!.filter(run => run.state === 'running').length === 1)
    const slices = read.partitions!.map(run => integrationPartition(run.files, {}, run.partition!))
    expect(slices.every(slice => slice.length === 1)).toBe(true)
    expect(slices.flat().sort()).toEqual([...systemd, ordinary].sort())
    for (const run of read.partitions!) {
      expect((await f.pool.query('select record from ci_runs where id=$1', [run.id])).rows[0].record).toEqual(run)
    }
    expect(read.partitions!.filter(run => run.state === 'queued')).toHaveLength(2)
    expect(read.partitions!.filter(run => run.state === 'running')).toHaveLength(1)
    expect(f.started[0]).toMatchObject({ computer: 'CircleCI 1',
      request: { partition: { index: 2, hostIndexes: [0, 1] } } })
  } finally { await f.close() }
})
