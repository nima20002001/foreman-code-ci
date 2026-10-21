import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { CiGetOutputSchema, CiRunOutputSchema, CiRunRecordSchema,
  type CiHostReply, type CiHostRequest, type CiHostRun, type CiRunRecord } from '@foreman-code/contracts'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { HostCiService, type CiCommits, type HostCiComputer } from '../src/modules/ci-host/service.js'
import { claimCiSlot } from '../src/modules/ci-host/cloudSlots.js'
import { ciReadWhen } from './helpers/ciReadWhen.js'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS, RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

let database: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { database = await migratedDatabase() }, 60_000)
afterAll(async () => { await database?.close() }, 60_000)
beforeEach(async () => {
  await database.pool.query('truncate ci_runs, ci_file_durations, management_command_receipts, management_audit')
})

const builders: HostCiComputer[] = [
  { key: 'builder-main', label: 'Main builder', priority: 60, hostRef: { kind: 'main', mainId: 'main' } },
  { key: 'builder-paired', label: 'Paired builder', priority: 50,
    hostRef: { kind: 'device', mainId: 'main', deviceId: 'paired' } },
]

function cloudSlots(count: number): HostCiComputer[] {
  return Array.from({ length: count }, (_, slot) => ({ key: `cloud-${slot}`, label: `Cloud ${slot}`, priority: 30,
    hostRef: { kind: 'cloud' as const, mainId: 'main', provider: 'github' as const, slot },
    userSystemd: { supported: true, reason: null } }))
}

const commits: CiCommits = {
  resolve: async (_repository, _branch, commit) => commit ?? 'a'.repeat(40),
  capabilities: async () => ({ parts: true, integrationPartitions: true, affected: true }),
  integrationInventory: async () => {
    const files = Array.from({ length: 24 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
    return { files, durations: Object.fromEntries(files.map(file => [file, 120_000])) }
  },
  unitInventory: async () => ({ files: ['apps/api/src/site.test.ts', 'apps/web/src/site.test.tsx'],
    durations: {}, heavy: [] }),
}

it('keeps an abandoned cloud slot reserved after its ticket moves to another executor', async () => {
  const pool = database.pool
  const workspaceId = randomUUID()
  const at = new Date().toISOString()
  const slots = cloudSlots(2)
  const retainedSlot = slots[0]!
  const freeSlot = slots[1]!
  await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
    [workspaceId, JSON.stringify({ id: workspaceId, name: 'Slot ownership' })])
  const ticket = () => CiRunRecordSchema.parse({ id: randomUUID(), workspaceId, groupId: randomUUID(),
    suite: 'unit', part: 'unit-api', partition: null, scope: 'affected', files: ['apps/api/src/example.test.ts'],
    repository: 'octo/site', ciMirror: 'octo/site-ci', commit: 'a'.repeat(40), state: 'queued', computer: null,
    step: null, exitCode: null, message: null, queuedAt: at, startedAt: null, finishedAt: null,
    initiator: { principalId: 'operator', executionId: null } })
  const owner = CiRunRecordSchema.parse({ ...ticket(), state: 'passed', exitCode: 0, startedAt: at, finishedAt: at,
    computer: { hostRef: builders[0]!.hostRef, label: builders[0]!.label },
    retainedExecutions: [{ runId: randomUUID(), hostKey: retainedSlot.key,
      computer: { hostRef: retainedSlot.hostRef, label: retainedSlot.label },
      executor: 'retained', nextAttemptAt: at }] })
  const waiting = ticket()
  const other = ticket()
  for (const run of [owner, waiting, other]) {
    await pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record)
      values($1,$2,$3,$4,$5::jsonb)`, [run.id, workspaceId, run.groupId, run.state, JSON.stringify(run)])
  }
  const request = (run: typeof waiting): Extract<CiHostRequest, { operation: 'start' }> => ({
    operation: 'start', runId: run.id, repository: run.repository, commit: run.commit, suite: run.suite,
    part: 'unit-api', scope: run.scope, files: run.files,
  })
  expect(await claimCiSlot(pool, waiting, retainedSlot, request(waiting))).toBe('busy')
  expect(await claimCiSlot(pool, other, freeSlot, request(other))).toMatchObject({ state: 'starting', id: other.id })
  expect((await pool.query('select state,host_key from ci_runs where id=$1', [waiting.id])).rows[0])
    .toEqual({ state: 'queued', host_key: null })
  await pool.query(`update ci_runs set record=jsonb_set(record,'{retainedExecutions,0,executor}','"released"')
    where id=$1`, [owner.id])
  expect(await claimCiSlot(pool, waiting, retainedSlot, request(waiting)))
    .toMatchObject({ state: 'starting', id: waiting.id, computer: { hostRef: retainedSlot.hostRef } })
})

/** A build computer or cloud slot that starts every assigned ticket at once and records which slot received it. */
function executor(options: { status?: (computer: HostCiComputer) => Promise<CiHostReply> } = {}) {
  const runs = new Map<string, CiHostRun>()
  const started: { key: string; runId: string }[] = []
  const request = async (computer: HostCiComputer, request: CiHostRequest): Promise<CiHostReply> => {
    if (request.operation === 'status') {
      if (options.status && computer.hostRef.kind !== 'cloud') return options.status(computer)
      return { operation: 'status', ready: true, reasons: [], cpuCount: computer.hostRef.kind === 'cloud' ? 4 : 16,
        memoryBytes: 16 * 2 ** 30, slotsTotal: computer.hostRef.kind === 'cloud' ? 1 : 2, slotsUsed: 0, runs: [] }
    }
    if (request.operation === 'start') {
      started.push({ key: computer.key, runId: request.runId })
      const run: CiHostRun = { runId: request.runId, state: 'running', step: request.suite, exitCode: null,
        message: null, startedAt: new Date().toISOString(), finishedAt: null, logBytes: 0 }
      runs.set(request.runId, run)
      return { operation: 'start', run }
    }
    const run = runs.get(request.runId)!
    if (request.operation === 'cancel') return { operation: 'cancel', run: { ...run, state: 'canceled' } }
    return { operation: 'read', run, text: '', nextOffset: 0 }
  }
  const finish = (runId: string, options: Pick<CiHostRun, 'executorCleanupPending' | 'collection'> = {}) => {
    const run = runs.get(runId)!
    runs.set(runId, { ...run, ...options, state: 'passed', exitCode: 0, finishedAt: new Date().toISOString() })
  }
  return { request, started, finish }
}

async function operatorApp(ci: HostCiService, commands: PostgresCommandCoordinator) {
  const workspaceId = randomUUID()
  await database.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [workspaceId,
    JSON.stringify({ id: workspaceId, name: 'Verification workspace', repository: {
      provider: 'github', owner: 'octo', name: 'site', defaultBranch: 'main',
    }, ciMirror: { provider: 'github', owner: 'octo', name: 'site-ci' } })])
  const access = new PostgresAccessService(database.pool)
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, ci } as unknown as OperatorServices } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const issued = await access.issue({ name: 'Verification caller', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000), grants: [{
      actions: [...CI_RUN_ACTIONS, ...CI_GET_ACTIONS], scope: { workspaceIds: [workspaceId] },
    }] })
  const client = new Client({ name: 'verification-slots-test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
    requestInit: { headers: { authorization: `Bearer ${issued.token}` } },
  }))
  const value = async (name: string, input: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: { workspaceId, ...input } })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    return decodeMcpToolResult(result)
  }
  return { value, workspaceId, close: async () => {
    await client.close()
    await ci.close()
    await app.close()
  } }
}

const verification = (commit: string, priority: 'high' | 'normal' = 'high') => ({ suite: 'lint', scope: 'affected',
  files: ['apps/web/src/site.tsx'], priority, noSupersede: true, commit, commandId: randomUUID() })

async function insertTicket(run: CiRunRecord, durations: Record<string, number> | null = null) {
  await database.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,host_key,record,durations)
    values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
  [run.id, run.workspaceId, run.groupId, run.state, null, JSON.stringify(run),
    durations ? JSON.stringify(durations) : null])
}

it.each(['github', 'circleci'] as const)('keeps an oversized gate check off %s after its builder disappears', async provider => {
  const clouds: HostCiComputer[] = cloudSlots(2).map(computer => ({ ...computer, hostRef: { ...computer.hostRef, provider } }))
  const computers: HostCiComputer[] = [...clouds]
  const fleet = executor()
  const commands = new PostgresCommandCoordinator(database.pool)
  const ci = new HostCiService(database.pool, commands, new RunCiAuthority(database.pool), commits,
    { computers: async () => computers, request: fleet.request })
  const f = await operatorApp(ci, commands)
  try {
    const groupId = randomUUID()
    const ticket = (part: 'unit-api' | 'unit-web', expectedDurationMs: number, plannedHostKey: string) =>
      CiRunRecordSchema.parse({ id: randomUUID(), workspaceId: f.workspaceId, groupId, suite: 'unit', part,
        expectedDurationMs, plannedHostKey, gate: true, noSupersede: true, scope: 'full', files: [],
        repository: 'octo/site', ciMirror: 'octo/site-ci', commit: 'a'.repeat(40), partition: null,
        state: 'queued', computer: null, step: null, message: null, exitCode: null,
        queuedAt: new Date().toISOString(), startedAt: null, finishedAt: null,
        initiator: { principalId: 'operator', executionId: null } })
    const oversized = ticket('unit-api', 4_000_000, builders[0]!.key)
    const safe = ticket('unit-web', 150_000, clouds[0]!.key)
    await insertTicket(oversized)
    await insertTicket(safe)
    await ci.dispatch()
    await ci.drain()
    const read = (id: string) => f.value('ci_get', { ticketId: id }).then(value => CiGetOutputSchema.parse(value).run)
    expect(await read(oversized.id)).toMatchObject({ state: 'queued', computer: null,
      plannedHostKey: builders[0]!.key })
    expect(fleet.started.some(started => started.runId === oversized.id)).toBe(false)
    expect(await read(safe.id)).toMatchObject({ state: 'running', computer: { hostRef: { kind: 'cloud', provider } } })
    // Restoring builder capacity must let the unchanged oversized check start there.
    computers.push(builders[0]!)
    await ci.dispatch()
    await ci.drain()
    expect(await read(oversized.id)).toMatchObject({ state: 'running', computer: { hostRef: builders[0]!.hostRef } })
  } finally { await f.close() }
})

it.each(['github', 'circleci'] as const)('budgets %s fallback with measured slowdown and preserves its factor', async provider => {
  const clouds: HostCiComputer[] = cloudSlots(2).map(computer => ({ ...computer, hostRef: { ...computer.hostRef, provider } }))
  const fleet = executor()
  const commands = new PostgresCommandCoordinator(database.pool)
  const ci = new HostCiService(database.pool, commands, new RunCiAuthority(database.pool), commits,
    { computers: async () => clouds, request: fleet.request })
  const f = await operatorApp(ci, commands)
  try {
    const groupId = randomUUID()
    const at = new Date(Date.now() - 91_000).toISOString()
    const ticket = (file: string, expectedDurationMs: number) => CiRunRecordSchema.parse({ id: randomUUID(),
      workspaceId: f.workspaceId, groupId, suite: 'integration', expectedDurationMs,
      plannedHostKey: builders[0]!.key, integrationShards: 4, gate: true, noSupersede: true,
      scope: 'full', files: [file], repository: 'octo/site', ciMirror: 'octo/site-ci', commit: 'a'.repeat(40),
      partition: null, state: 'queued', computer: null, step: null, message: null, exitCode: null,
      queuedAt: at, startedAt: null, finishedAt: null, initiator: { principalId: 'operator', executionId: null } })
    const longFile = 'apps/api/test/long.integration.test.ts'
    const shortFile = 'apps/api/test/short.integration.test.ts'
    const oversized = ticket(longFile, 1_890_000)
    const safe = ticket(shortFile, 690_000)
    const history = CiRunRecordSchema.parse({ ...ticket(shortFile, 100_000), files: [], state: 'passed', exitCode: 0,
      groupId: randomUUID(), plannedHostKey: clouds[0]!.key,
      computer: { hostRef: clouds[0]!.hostRef, label: clouds[0]!.label },
      startedAt: new Date(Date.parse(at) - 400_000).toISOString(),
      finishedAt: new Date(Date.parse(at) - 200_000).toISOString() })
    await insertTicket(history)
    await insertTicket(oversized, { [longFile]: 1_800_000 })
    await insertTicket(safe, { [shortFile]: 600_000 })
    await ci.dispatch()
    await ci.drain()
    const read = (id: string) => f.value('ci_get', { ticketId: id }).then(value => CiGetOutputSchema.parse(value).run)
    expect(await read(oversized.id)).toMatchObject({ state: 'queued', computer: null,
      plannedHostKey: builders[0]!.key, files: [longFile] })
    expect(fleet.started.some(started => started.runId === oversized.id)).toBe(false)
    const running = await read(safe.id)
    expect(running).toMatchObject({ state: 'running', expectedDurationMs: 1_380_000, speedFactor: 2,
      files: [shortFile], computer: { hostRef: { kind: 'cloud', provider } } })
    const saved = (await database.pool.query('select record from ci_runs where id=$1', [safe.id])).rows[0]!.record
    expect(saved).toEqual(running)
  } finally { await f.close() }
})

it.each(['github', 'circleci'] as const)('tries another provider when the first %s fallback exceeds the budget', async slow => {
  const fast = slow === 'github' ? 'circleci' : 'github'
  const clouds: HostCiComputer[] = ([slow, fast] as const).map((provider, index) => ({ ...cloudSlots(2)[index]!,
    hostRef: { kind: 'cloud', mainId: 'main', provider, slot: index } }))
  const fleet = executor()
  const commands = new PostgresCommandCoordinator(database.pool)
  const ci = new HostCiService(database.pool, commands, new RunCiAuthority(database.pool), commits,
    { computers: async () => clouds, request: fleet.request })
  const f = await operatorApp(ci, commands)
  try {
    const at = new Date(Date.now() - 91_000).toISOString()
    const file = 'apps/api/test/long.integration.test.ts'
    const run = CiRunRecordSchema.parse({ id: randomUUID(), groupId: randomUUID(), workspaceId: f.workspaceId,
      suite: 'integration', expectedDurationMs: 1_890_000, plannedHostKey: builders[0]!.key,
      integrationShards: 4, gate: true, noSupersede: true, scope: 'full', files: [file],
      repository: 'octo/site', ciMirror: 'octo/site-ci', commit: 'a'.repeat(40), partition: null,
      state: 'queued', computer: null, step: null, message: null, exitCode: null, queuedAt: at,
      startedAt: null, finishedAt: null, initiator: { principalId: 'operator', executionId: null } })
    for (const [index, computer] of clouds.entries()) {
      const history = CiRunRecordSchema.parse({ ...run, id: randomUUID(), groupId: randomUUID(),
        files: [], state: 'passed', exitCode: 0, expectedDurationMs: 100_000, plannedHostKey: computer.key,
        computer: { hostRef: computer.hostRef, label: computer.label },
        startedAt: new Date(Date.parse(at) - 400_000).toISOString(),
        finishedAt: new Date(Date.parse(at) - 400_000 + (index === 0 ? 200_000 : 100_000)).toISOString() })
      await insertTicket(history)
    }
    await insertTicket(run, { [file]: 1_800_000 })
    await ci.dispatch()
    await ci.drain()
    const running = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: run.id })).run
    expect(running).toMatchObject({ state: 'running', plannedHostKey: clouds[1]!.key,
      expectedDurationMs: 1_890_000, files: [file], computer: { hostRef: clouds[1]!.hostRef } })
    expect(fleet.started).toEqual([{ key: clouds[1]!.key, runId: run.id }])
    expect((await database.pool.query('select record from ci_runs where id=$1', [run.id])).rows[0]!.record)
      .toEqual(running)
  } finally { await f.close() }
})

it('starts cloud integration on a new ticket after the slot finishes its gate check', async () => {
  const clouds = cloudSlots(8)
  const fleet = executor()
  const commands = new PostgresCommandCoordinator(database.pool)
  const files = Array.from({ length: 96 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
  const ci = new HostCiService(database.pool, commands, new RunCiAuthority(database.pool), { ...commits,
    integrationInventory: async () => ({ files, durations: Object.fromEntries(files.map(file => [file, 120_000])) }),
  }, { computers: async () => [builders[0]!, ...clouds], request: fleet.request })
  const f = await operatorApp(ci, commands)
  try {
    const gate = CiRunOutputSchema.parse(await f.value('ci_run', { suite: 'integration', scope: 'full', gate: true,
      commit: 'a'.repeat(40), commandId: randomUUID() }))
    await ci.dispatch()
    await ci.drain()
    const read = async () => CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: gate.ticketId }))
    const initial = await read()
    const checks = initial.partitions!.filter(run => run.suite !== 'integration')
    const planned = initial.partitions!.filter(run => run.suite === 'integration'
      && run.plannedHostKey?.startsWith('cloud-'))
    expect(planned.length).toBeGreaterThan(1)
    expect(initial.partitions!.filter(run => run.suite === 'integration').flatMap(run => run.files).sort())
      .toEqual([...files].sort())
    const firstCloud = fleet.started.filter(run => run.key.startsWith('cloud-'))
    expect(firstCloud).toHaveLength(8)
    for (const started of firstCloud) expect(checks.some(run => run.id === started.runId)).toBe(true)
    expect(initial.partitions!.filter(run => run.suite === 'integration' && run.state === 'running')
      .every(run => run.computer!.hostRef.kind === 'main')).toBe(true)
    const finished = new Set<string>()
    for (let wave = 0; wave < checks.length; wave++) {
      const current = await read()
      for (const run of current.partitions!.filter(run => run.suite !== 'integration' && run.state === 'running')) {
        fleet.finish(run.id, { collection: 'unsupported' })
        finished.add(run.id)
      }
      await ci.dispatch()
      await ci.drain()
      const running = (await read()).partitions!.filter(run => run.suite === 'integration'
        && run.state === 'running' && run.computer?.hostRef.kind === 'cloud')
      if (running.length !== planned.length) continue
      for (const run of running) {
        const slot = `cloud-${run.computer!.hostRef.slot}`
        const first = firstCloud.find(started => started.key === slot)!
        expect(finished.has(first.runId)).toBe(true)
        expect(run.id).not.toBe(first.runId)
      }
      const active = (await database.pool.query<{ host_key: string; count: number }>(`select host_key,count(*)::int as count
        from ci_runs where state in ('starting','running') group by host_key`)).rows
      expect(active.filter(row => row.host_key.startsWith('cloud-') && row.count > 1)).toEqual([])
      return
    }
    throw new Error('The completed check slots did not start every integration part')
  } finally { await f.close() }
})

it('keeps reserved cloud slots out of a gate plan and starts a fix verification on one within a dispatch pass', async () => {
  const clouds = cloudSlots(6)
  const reserved = new Set(['cloud-4', 'cloud-5'])
  const fleet = executor()
  const commands = new PostgresCommandCoordinator(database.pool)
  const ci = new HostCiService(database.pool, commands, new RunCiAuthority(database.pool), commits,
    { computers: async () => [...builders, ...clouds], request: fleet.request }, undefined, { reservedCloudSlots: 2 })
  const f = await operatorApp(ci, commands)
  try {
    const gate = CiRunOutputSchema.parse(await f.value('ci_run', { suite: 'integration', scope: 'full', gate: true,
      commit: 'a'.repeat(40), commandId: randomUUID() }))
    await ci.dispatch()
    await expect.poll(async () => CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: gate.ticketId }))
      .partitions!.filter(run => run.state === 'running' && run.computer?.hostRef.kind === 'cloud').length).toBe(4)
    const planned = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: gate.ticketId }))
    const parts = planned.partitions!
    expect(parts.some(run => run.plannedHostKey?.startsWith('cloud-'))).toBe(true)
    expect(parts.filter(run => reserved.has(run.plannedHostKey ?? ''))).toEqual([])
    expect(planned.gate!.computers.filter(computer => reserved.has(computer.key))).toEqual([])
    const gateCloud = parts.filter(run => run.state === 'running' && run.computer?.hostRef.kind === 'cloud')
    expect(gateCloud).toHaveLength(4)
    expect(gateCloud.filter(run => reserved.has(`cloud-${run.computer!.hostRef.slot}`))).toEqual([])
    expect(parts.some(run => run.state === 'queued' && run.suite !== 'integration')).toBe(true)

    const fix = CiRunOutputSchema.parse(await f.value('ci_run', verification('b'.repeat(40))))
    await ci.dispatch()
    const read = await ciReadWhen(database.pool, async () => CiGetOutputSchema.parse(await f.value('ci_get', {
      ticketId: fix.ticketId,
    })), output => output.run.state === 'running' && output.run.observation?.status === 'available')
    expect(read.run).toMatchObject({ state: 'running', computer: { hostRef: { kind: 'cloud' } } })
    expect(reserved.has(`cloud-${read.run.computer!.hostRef.slot}`)).toBe(true)
    const stored = (await database.pool.query('select record,host_key from ci_runs where id=$1', [fix.ticketId])).rows[0]
    expect(stored.record).toEqual(read.run)
    expect(reserved.has(stored.host_key)).toBe(true)
    const active = (await database.pool.query<{ host_key: string; count: number }>(`select host_key,count(*)::int as count
      from ci_runs where state in ('starting','running') group by host_key`)).rows
    expect(active.filter(row => row.host_key.startsWith('cloud-') && row.count > 1)).toEqual([])
  } finally { await f.close() }
})

it('retains a completed ticket slot until its accepted cloud attempts are confirmed stopped', async () => {
  const slot = cloudSlots(1)[0]!
  const fleet = executor()
  const commands = new PostgresCommandCoordinator(database.pool)
  const ci = new HostCiService(database.pool, commands, new RunCiAuthority(database.pool), commits,
    { computers: async () => [slot], request: fleet.request })
  const f = await operatorApp(ci, commands)
  const read = async (ticketId: string) => CiGetOutputSchema.parse(await f.value('ci_get', { ticketId }))
  try {
    const first = CiRunOutputSchema.parse(await f.value('ci_run', verification('e'.repeat(40))))
    await ci.dispatch()
    await ci.drain()
    fleet.finish(first.ticketId, { executorCleanupPending: true })
    await ci.dispatch()
    await ci.drain()
    expect((await read(first.ticketId)).run).toMatchObject({ state: 'passed', executorCleanupPending: true })
    const saved = (await database.pool.query('select host_key from ci_runs where id=$1', [first.ticketId])).rows[0]
    expect(saved.host_key).toBe(slot.key)
    const second = CiRunOutputSchema.parse(await f.value('ci_run', verification('f'.repeat(40))))
    await ci.dispatch()
    await ci.drain()
    const queued = (await read(second.ticketId)).run
    expect(queued.state).toBe('queued')
    expect(await claimCiSlot(database.pool, queued, slot, { operation: 'start', runId: queued.id,
      repository: queued.repository, commit: queued.commit, suite: queued.suite, scope: queued.scope })).toBe('busy')
    expect(fleet.started).toHaveLength(1)
    fleet.finish(first.ticketId, { executorCleanupPending: false })
    await ci.dispatch()
    await ci.drain()
    await ci.dispatch()
    await ci.drain()
    expect((await read(first.ticketId)).run).toMatchObject({ state: 'passed', executorCleanupPending: false })
    expect((await read(second.ticketId)).run.state).toBe('running')
    expect(fleet.started).toHaveLength(2)
  } finally { await f.close() }
})

it('never dispatches a ticket to a cloud slot another Main dispatcher assigned meanwhile', async () => {
  const slot = cloudSlots(1)[0]!
  const fleet = executor()
  const commands = new PostgresCommandCoordinator(database.pool)
  const endpoint = { computers: async () => [slot], request: fleet.request }
  const primary = new HostCiService(database.pool, commands, new RunCiAuthority(database.pool), commits, endpoint)
  const secondary = new HostCiService(database.pool, commands, new RunCiAuthority(database.pool), commits, endpoint)
  // Hold automatic dispatch while both callers capture the same free-slot state.
  const start = vi.spyOn(primary, 'start').mockImplementation(() => {})
  const dispatch = vi.spyOn(primary, 'dispatch').mockResolvedValue(undefined)
  const f = await operatorApp(primary, commands)
  const read = async (ticketId: string) => CiGetOutputSchema.parse(await f.value('ci_get', { ticketId }))
  try {
    const waiting = CiRunOutputSchema.parse(await f.value('ci_run', verification('d'.repeat(40), 'normal')))
    const stale = (await read(waiting.ticketId)).run
    const urgent = CiRunOutputSchema.parse(await f.value('ci_run', verification('e'.repeat(40))))
    const latest = (await read(urgent.ticketId)).run
    const request = (run: typeof latest): Extract<CiHostRequest, { operation: 'start' }> => ({
      operation: 'start', runId: run.id, workspaceId: run.workspaceId, ciMirror: run.ciMirror ?? null,
      repository: run.repository, commit: run.commit, suite: run.suite, scope: run.scope, files: run.files,
    })
    const claimed = await claimCiSlot(database.pool, latest, slot, request(latest))
    expect(claimed).toMatchObject({ id: urgent.ticketId, state: 'starting', computer: { hostRef: slot.hostRef } })
    // A claim made from the earlier queue snapshot must recheck the persisted slot assignment.
    expect(await claimCiSlot(database.pool, stale, slot, request(stale))).toBe('busy')
    dispatch.mockRestore()
    start.mockRestore()
    await Promise.all([primary.dispatch(), secondary.dispatch()])
    const running = await ciReadWhen(database.pool, () => read(urgent.ticketId), output => output.run.state === 'running')
    expect(running.run).toMatchObject({ state: 'running', computer: { hostRef: slot.hostRef } })
    const queued = await ciReadWhen(database.pool, () => read(waiting.ticketId), output =>
      output.run.message?.includes('all CI slots in use') === true)
    expect(queued.run).toMatchObject({ state: 'queued', computer: null, startedAt: null,
      message: expect.stringContaining('Cloud 0: all CI slots in use (1/1)') })
    expect(fleet.started).toEqual([{ key: slot.key, runId: urgent.ticketId }])
    const active = (await database.pool.query<{ id: string }>(
      `select id from ci_runs where host_key=$1 and state in ('starting','running')`, [slot.key])).rows
    expect(active.map(row => row.id)).toEqual([urgent.ticketId])
  } finally {
    dispatch.mockRestore()
    start.mockRestore()
    await secondary.close()
    await f.close()
  }
})
