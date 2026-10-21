import {
  CiComputersOutputSchema, CiGetOutputSchema, CiRunOutputSchema, CiRunRecordSchema,
} from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expect, it } from 'vitest'
import { CI_GET_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { fixture } from './helpers/hostCiMcpFixture.js'
import { deferred } from './helpers/deferred.js'

/** Dispatch passes hand observations and follow-up passes to background work; settle waits for all of it. */
async function settle(service: { dispatch(): Promise<void>; drain(): Promise<void> }) {
  await service.dispatch()
  await service.drain()
}

it('prefers build computers and CircleCI over higher-priority GitHub slots for integration', async () => {
  const f = await fixture({ cloud: { github: 2, circleci: 2 } })
  try {
    for (const computer of f.computers) {
      if (computer.hostRef.kind === 'cloud' && computer.hostRef.provider === 'github') computer.priority = 100
    }
    // Preference applies to ready computers; learn the whole fleet before admission can dispatch parts.
    await settle(f.ci)
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'integration', commandId: 'integration-preference', partitions: 4,
    }))
    await settle(f.ci)
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
    expect(read.partitions).toHaveLength(4)
    expect(read.partitions!.filter(run => run.computer?.hostRef.kind === 'device')).toHaveLength(2)
    expect(read.partitions!.filter(run => run.computer?.hostRef.provider === 'circleci')).toHaveLength(2)
    expect(read.partitions!.every(run => run.state === 'running')).toBe(true)
    const fallback = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'integration', commandId: 'integration-fallback', partitions: 3,
    }))
    await settle(f.ci)
    const fallbackRead = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: fallback.ticketId }))
    const hostSlice = fallbackRead.partitions!.find(run => run.partition!.index === 0)!
    expect(hostSlice).toMatchObject({ state: 'queued', computer: null,
      message: expect.stringContaining('Waiting for a build computer') })
    expect(fallbackRead.partitions!.filter(run => run.id !== hostSlice.id).every(run => run.state === 'running'
      && run.computer?.hostRef.provider === 'github')).toBe(true)
    f.finish(read.partitions!.find(run => run.computer?.hostRef.kind === 'device')!.id, 0, 'Host slice completed.\n')
    // Observations rotate through running tickets, so the finished slice is noticed within a few passes.
    await f.ci.dispatch()
    await expect.poll(async () => {
      const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: fallback.ticketId }))
      return read.partitions!.every(run => run.state === 'running')
    }, { timeout: 10_000 }).toBe(true)
    const running = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: fallback.ticketId }))
    expect(running.partitions!.find(run => run.id === hostSlice.id))
      .toMatchObject({ computer: { hostRef: { kind: 'device' } }, message: null })
  } finally { await f.close() }
})

it('uses ready GitHub capacity while a preferred CircleCI status is still pending', async () => {
  const circleStatus = deferred()
  const f = await fixture({ cloud: { github: 2, circleci: 2 }, beforeStatus: async computer => {
    if (computer.hostRef.provider === 'circleci' && computer.hostRef.slot === 1) await circleStatus.promise
  } })
  try {
    // Learn the alternatives before introducing the computer whose initial status is held.
    const pendingComputer = f.computers.pop()!
    await settle(f.ci)
    f.computers.push(pendingComputer)
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'integration', commandId: 'pending-circle-status', partitions: 4,
    }))
    await f.ci.dispatch()
    const read = await f.waitFor(f.operator, started.ticketId, output =>
      output.partitions!.every(run => run.state === 'running'))
    expect(read.partitions).toHaveLength(4)
    expect(read.partitions!.filter(run => run.computer?.hostRef.kind === 'device')).toHaveLength(2)
    expect(read.partitions!.filter(run => run.computer?.hostRef.provider === 'circleci')).toHaveLength(1)
    expect(read.partitions!.filter(run => run.computer?.hostRef.provider === 'github')).toHaveLength(1)
    circleStatus.resolve()
    await settle(f.ci)
    const settled = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
    expect(settled.partitions!.map(run => run.computer)).toEqual(read.partitions!.map(run => run.computer))
  } finally {
    circleStatus.resolve()
    await f.close()
  }
})

it.each(['typecheck', 'lint', 'build', 'unit'] as const)(
  'reserves GitHub slots for queued %s parts behind a large integration run', async suite => {
    const f = await fixture({ cloud: { github: 20, circleci: 2 } })
    try {
      const available = f.computers.splice(0)
      const reader = await f.connect(CI_GET_ACTIONS)
      expect((await f.call(reader, 'ci_run', { suite, commandId: 'denied-dispatch' })).isError).toBe(true)
      expect((await f.pool.query('select count(*)::int as count from ci_runs')).rows[0].count).toBe(0)
      const integration = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
        suite: 'integration', commandId: 'integration-backlog', partitions: 32,
      }))
      await settle(f.ci)
      const checks = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
        suite, commandId: 'queued-checks',
      }))
      await settle(f.ci)
      expect(f.started).toHaveLength(0)
      f.computers.push(...available)
      await settle(f.ci)
      const checksRead = await f.waitFor(reader, checks.ticketId, output =>
        output.partitions!.filter(run => run.state === 'running').length === Math.min(4, output.partitions!.length))
      // Four slots stay reserved while checks wait; once every check part runs, integration may use the rest.
      const integrationLimit = checksRead.partitions!.some(run => run.state === 'queued') ? 16 : 18
      const integrationRead = await f.waitFor(reader, integration.ticketId, output =>
        output.partitions!.filter(run => run.computer?.hostRef.provider === 'github').length === integrationLimit
        && output.partitions!.filter(run => run.computer?.hostRef.provider === 'circleci').length === 2)
      const dispatched = (await f.pool.query<{ record: unknown }>(
        'select record from ci_runs where group_id=(select group_id from ci_runs where id=$1)',
        [integration.ticketId])).rows
        .map(row => CiRunRecordSchema.parse(row.record))
      expect(dispatched.filter(run => run.computer?.hostRef.provider === 'github')).toHaveLength(integrationLimit)
      expect(integrationRead.partitions!.filter(run => run.computer?.hostRef.provider === 'github'))
        .toHaveLength(integrationLimit)
      expect(integrationRead.partitions!.filter(run => run.computer?.hostRef.provider === 'circleci')).toHaveLength(2)
      expect(checksRead.partitions!.filter(run => run.state === 'running'))
        .toHaveLength(Math.min(4, checksRead.partitions!.length))
      expect(checksRead.partitions!.filter(run => run.state === 'running').every(run =>
        run.computer?.hostRef.kind === 'cloud' && run.computer.hostRef.provider === 'github')).toBe(true)
      expect(integrationRead.partitions!.some(run => run.state === 'queued')).toBe(true)
      const stored = (await f.pool.query<{ record: unknown }>('select record from ci_runs where group_id=$1',
        [checksRead.run.groupId])).rows
      expect(stored.map(row => row.record)).toEqual(expect.arrayContaining(checksRead.partitions!))
      await settle(f.ci)
      const next = CiGetOutputSchema.parse(await f.value(reader, 'ci_get', { ticketId: integration.ticketId }))
      expect(next.partitions!.filter(run => run.computer?.hostRef.provider === 'github')).toHaveLength(integrationLimit)
    } finally { await f.close() }
  },
)

it('dispatches queued typecheck parts beyond the first fifty integration partitions', async () => {
  const f = await fixture({ cloud: { github: 20, circleci: 2 } })
  try {
    const available = f.computers.splice(0)
    for (const commandId of ['integration-first', 'integration-second']) {
      await f.value(f.operator, 'ci_run', { suite: 'integration', commandId, partitions: 32 })
      await settle(f.ci)
    }
    const checks = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'typecheck', commandId: 'typecheck-after-backlog',
    }))
    await settle(f.ci)
    f.computers.push(...available)
    await settle(f.ci)
    // Observations rotate through running tickets; wait until the typecheck parts have been observed.
    await expect.poll(async () => {
      const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: checks.ticketId }))
      return read.partitions!.every(run => run.observation?.status === 'available')
    }, { timeout: 10_000 }).toBe(true)
    const stored = (await f.pool.query<{ record: unknown }>(
      'select record from ci_runs where group_id=(select group_id from ci_runs where id=$1)',
      [checks.ticketId])).rows.map(row => CiRunRecordSchema.parse(row.record))
    expect(stored).toHaveLength(2)
    expect(stored.every(run => run.state === 'running' && run.computer?.hostRef.provider === 'github')).toBe(true)
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: checks.ticketId }))
    expect(read.partitions).toEqual(expect.arrayContaining(stored.map(run => ({ ...run,
      observation: { status: 'available', lastSuccessAt: expect.any(String), lastError: null,
        consecutiveFailures: 0, nextAttemptAt: null } }))))
  } finally { await f.close() }
})

it('allows Agent high priority without a separate priority grant and rechecks CI revocation', async () => {
  const f = await fixture({ agent: true })
  try {
    f.computers.splice(0)
    const input = { suite: 'install', priority: 'high', commandId: 'agent-high-priority' }
    const result = await f.call(f.agent!, 'ci_run', input)
    expect(result.isError).not.toBe(true)
    const started = CiRunOutputSchema.parse(decodeMcpToolResult(result))
    expect(CiGetOutputSchema.parse(await f.value(f.agent!, 'ci_get', { ticketId: started.ticketId })).run)
      .toMatchObject({ priority: 'high', priorityReason: 'requested' })
    expect(CiRunOutputSchema.parse(await f.value(f.agent!, 'ci_run', input))).toEqual(started)
    expect((await f.pool.query("select details->>'priority' as priority from management_audit where action='ci.priority'"))
      .rows).toEqual([{ priority: 'high' }])
    await f.value(f.operator, 'ci_run', { suite: 'install', commandId: 'another-caller' })
    const listed = CiComputersOutputSchema.parse(await f.value(f.agent!, 'ci_computers_list', {}))
    expect(listed.queue).toEqual([{ ticketId: started.ticketId, priority: 'high', priorityReason: 'requested',
      position: 1, reason: expect.any(String) }])
    await f.pool.query(`update management_principals set grants=(select jsonb_agg(
      jsonb_set(grant_entry,'{actions}',(select jsonb_agg(action) from jsonb_array_elements(grant_entry->'actions') action
        where action <> '"ci"'::jsonb))) from jsonb_array_elements(grants) grant_entry) where id=$1`,
    [f.authorizationPrincipalId])
    expect((await f.call(f.agent!, 'ci_run', input)).isError).toBe(true)
  } finally { await f.close() }
})

it('starts and cancels CI with one workspace CI action while rejecting readers and foreign scopes', async () => {
  const f = await fixture()
  try {
    f.computers.splice(0)
    const caller = await f.connect(['ci', ...CI_GET_ACTIONS])
    const input = { suite: 'install', priority: 'high', commandId: 'single-ci-action' }
    const started = CiRunOutputSchema.parse(await f.value(caller, 'ci_run', input))
    expect(CiGetOutputSchema.parse(await f.value(caller, 'ci_get', { ticketId: started.ticketId })).run)
      .toMatchObject({ priority: 'high', state: 'queued' })
    expect(CiRunOutputSchema.parse(await f.value(caller, 'ci_run', input))).toEqual(started)
    await f.value(caller, 'ci_cancel', { ticketId: started.ticketId, commandId: 'cancel-single-ci' })
    expect(CiGetOutputSchema.parse(await f.value(caller, 'ci_get', { ticketId: started.ticketId })).run.state)
      .toBe('canceled')
    const reader = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(reader, 'ci_run', { ...input, commandId: 'reader-denied' })).isError).toBe(true)
    const foreign = await f.connect(['ci'], { workspaceIds: ['other-workspace'] })
    expect((await f.call(foreign, 'ci_run', { ...input, commandId: 'foreign-denied' })).isError).toBe(true)
  } finally { await f.close() }
})

it.each([
  { changedFiles: ['scripts/test-db.mjs'], priority: 'high', priorityReason: 'ci-infrastructure' },
  { changedFiles: ['scripts/test-db.mjs', 'apps/web/src/App.tsx'], priority: 'normal', priorityReason: 'normal' },
])('derives $priority priority from actual commit changes through Agent MCP', async expected => {
  const f = await fixture({ agent: true, changedFiles: expected.changedFiles })
  try {
    const started = CiRunOutputSchema.parse(await f.value(f.agent!, 'ci_run', {
      suite: 'lint', commandId: 'commit-priority', commit: 'b'.repeat(40), scope: 'affected',
      files: ['apps/api/src/modules/ci-host/service.ts', 'packages/contracts/src/ciHost.ts'],
    }))
    const read = CiGetOutputSchema.parse(await f.value(f.agent!, 'ci_get', { ticketId: started.ticketId }))
    expect(read.run).toMatchObject({ priority: expected.priority, priorityReason: expected.priorityReason })
    expect(read.partitions?.every(run => run.priority === expected.priority)).toBe(true)
    const stored = (await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1',
      [started.ticketId])).rows[0]!.record
    expect(CiRunRecordSchema.parse(stored)).toEqual(read.run)
    expect((await f.pool.query("select details from management_audit where action='ci.priority'")).rows)
      .toEqual([{ details: expect.objectContaining({ priority: expected.priority,
        priorityReason: expected.priorityReason, requestedPriority: 'normal' }) }])
  } finally { await f.close() }
})

it('shows priority and global queue position through MCP and admits high tickets beyond fifty older tickets', async () => {
  const f = await fixture({ cloud: { github: 1, circleci: 1 } })
  try {
    const available = f.computers.splice(0)
    const older: string[] = []
    for (let index = 0; index < 51; index++) {
      const ticket = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
        suite: 'install', commandId: `normal-backlog-${index}`,
      }))
      older.push(ticket.ticketId)
    }
    const input = { suite: 'install', commandId: 'operator-high', priority: 'high' }
    const high = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(high)
    expect((await f.call(f.operator, 'ci_run', { ...input, priority: 'normal' })).isError).toBe(true)
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: high.ticketId }))
    expect(read.run).toMatchObject({ state: 'queued', priority: 'high', priorityReason: 'requested' })
    expect(read.queue).toMatchObject({ position: 1, reason: expect.any(String) })
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: older[0] })).queue?.position).toBe(2)
    const computers = CiComputersOutputSchema.parse(await f.value(f.operator, 'ci_computers_list', {}))
    expect(computers.queue?.[0]).toEqual({ ticketId: high.ticketId, priority: 'high', priorityReason: 'requested',
      position: 1, reason: read.queue!.reason })
    expect(computers.queue).toHaveLength(52)
    expect(computers.queueTruncated).toBe(false)
    const denied = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(denied, 'ci_run', { suite: 'install', commandId: 'denied-high', priority: 'high' })).isError)
      .toBe(true)
    f.computers.push(available[0]!)
    await settle(f.ci)
    expect(f.started).toHaveLength(1)
    expect(f.started[0]?.request).toMatchObject({ runId: high.ticketId })
    const admitted = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: high.ticketId }))
    expect(admitted.run.state).toBe('running')
    expect(admitted.queue).toBeNull()
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: older[0] })).run.state)
      .toBe('queued')
  } finally { await f.close() }
})

it('lets high integration tickets use cloud slots reserved for normal checks', async () => {
  const f = await fixture({ cloud: { github: 2, circleci: 0 } })
  try {
    const available = f.computers.splice(0).filter(computer => computer.hostRef.kind === 'cloud')
    await f.value(f.operator, 'ci_run', { suite: 'lint', commandId: 'normal-checks' })
    const integration = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'integration', scope: 'affected', commit: 'a'.repeat(40), partitions: 2,
      files: ['apps/api/test/first.integration.test.ts', 'apps/api/test/second.integration.test.ts'],
      commandId: 'high-integration', priority: 'high',
    }))
    await settle(f.ci)
    f.computers.push(...available)
    await settle(f.ci)
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: integration.ticketId }))
    expect(read.partitions!.every(run => run.priority === 'high' && run.state === 'running')).toBe(true)
    expect(f.started).toHaveLength(2)
  } finally { await f.close() }
})
