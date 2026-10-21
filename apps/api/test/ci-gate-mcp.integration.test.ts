import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { CiGetOutputSchema, CiRunOutputSchema, CiRunRecordSchema, exclusiveIntegrationFiles, userSystemdIntegrationFiles,
  type CiHostRun, type CiHostRequest, type CiHostReply } from '@foreman-code/contracts'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import pg from 'pg'
import { buildApp } from '../src/app.js'
import { createPool } from '../src/infrastructure/pool.js'
import { createTestPool } from './helpers/testPool.mjs'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { buildComputerIntegrationShards, gateIntegrationShards } from '../src/modules/ci-host/capacity.js'
import { HostCiService, type HostCiComputer } from '../src/modules/ci-host/service.js'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS, RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { cloudCiLookupFixture } from './helpers/cloudCiLookupFixture.js'
import { ciExecutionRunId } from '../src/modules/ci-host/executionAttempt.js'
import { ciRunReadback } from './helpers/ciRunReadback.js'

/** Dispatch passes hand observations and follow-up passes to background work; settle waits for all of it. */
async function settle(service: { dispatch(): Promise<void>; drain(): Promise<void> }) {
  await service.dispatch()
  await service.drain()
}

let database: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { database = await migratedDatabase() }, 60_000)
afterAll(async () => { await database?.close() }, 60_000)
beforeEach(async () => {
  await database.pool.query('truncate ci_runs, ci_file_durations, management_command_receipts, management_audit')
})

it.each(['runner', 'persisted'] as const)('plans a gate away from a builder occupied by a %s non-gate run', async source => {
  const occupiedKeys = new Set(source === 'runner' ? ['builder-main'] : [])
  const f = await fixture({ occupiedKeys })
  try {
    if (source === 'persisted') {
      const affected = CiRunOutputSchema.parse(await f.value('ci_run', {
        suite: 'unit', scope: 'affected', files: ['apps/api/src/site.test.ts'],
        smokeComputer: f.computers[0]!.hostRef, commit: 'b'.repeat(40),
      }))
      await settle(f.ci)
      expect(CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: affected.ticketId })).run)
        .toMatchObject({ state: 'running', computer: { hostRef: f.computers[0]!.hostRef } })
    }
    const input = { suite: 'integration', scope: 'full', gate: true, commit: 'a'.repeat(40) }
    const reader = await f.connect(true)
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    const admitted = CiRunOutputSchema.parse(await f.value('ci_run', input))
    await f.ci.close()
    const read = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: admitted.ticketId }))
    expect(read.partitions!.some(run => run.plannedHostKey === 'builder-main')).toBe(false)
    expect(read.partitions!.some(run => run.plannedHostKey === 'builder-paired')).toBe(true)
    expect(read.partitions!.filter(run => run.suite === 'integration').flatMap(run => run.files).sort())
      .toEqual([...f.files].sort())
    for (const run of read.partitions!) {
      const stored = (await database.pool.query('select record from ci_runs where id=$1', [run.id])).rows[0].record
      expect(stored).toMatchObject({ plannedHostKey: run.plannedHostKey, files: run.files })
    }
  } finally { await f.close() }
})

it('plans all gate integration on cloud when every builder is occupied', async () => {
  const f = await fixture({ occupiedKeys: new Set(['builder-main', 'builder-paired']) })
  try {
    const admitted = CiRunOutputSchema.parse(await f.value('ci_run', {
      suite: 'integration', scope: 'full', gate: true, commit: 'a'.repeat(40),
    }))
    const read = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: admitted.ticketId }))
    expect(read.partitions!.every(run => run.plannedHostKey?.startsWith('cloud-'))).toBe(true)
    expect(read.partitions!.filter(run => run.suite === 'integration').flatMap(run => run.files).sort())
      .toEqual([...f.files].sort())
  } finally { await f.close() }
})

it('persists a throughput-sized gate through MCP and rejects a read-only caller', async () => {
  const files = Array.from({ length: 700 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
  const f = await fixture({ files })
  try {
    const builder = f.computers[0]!
    const historyFiles = files.slice(0, 148)
    for (const wallMs of [800_000, 800_000, 800_000, 100_000]) {
      const started = Date.now() - 3_600_000
      const record = CiRunRecordSchema.parse({ id: randomUUID(), workspaceId: f.workspaceId, groupId: randomUUID(),
        suite: 'integration', scope: 'full', gate: true, part: null, partition: null, files: historyFiles,
        repository: 'octo/site', commit: 'b'.repeat(40), state: 'passed',
        computer: { hostRef: builder.hostRef, label: builder.label }, step: 'integration', exitCode: 0, message: null,
        queuedAt: new Date(started).toISOString(), startedAt: new Date(started).toISOString(),
        finishedAt: new Date(started + wallMs).toISOString(), initiator: { principalId: 'operator', executionId: null },
        plannedHostKey: builder.key, expectedDurationMs: 272_000, speedFactor: 0.5, integrationShards: 12 })
      const results = { summary: { passed: 148, failed: 0, skipped: 0 }, truncated: false,
        files: historyFiles.map(file => ({ file, status: 'passed', durationMs: 20_000, tests: [] })) }
      await database.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record,test_results)
        values($1,$2,$3,'passed',$4::jsonb,$5::jsonb)`,
      [record.id, f.workspaceId, record.groupId, JSON.stringify(record), JSON.stringify(results)])
    }
    const input = { suite: 'integration', scope: 'full', gate: true, commit: 'a'.repeat(40), commandId: randomUUID() }
    const reader = await f.connect(true)
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    expect((await database.pool.query('select count(*)::int as count from ci_runs')).rows[0].count).toBe(4)
    const admitted = CiRunOutputSchema.parse(await f.value('ci_run', input))
    expect(CiRunOutputSchema.parse(await f.value('ci_run', input))).toEqual(admitted)
    const read = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: admitted.ticketId }))
    const host = read.partitions!.find(run => run.plannedHostKey === builder.key)!
    const cloudEnd = Math.max(...read.partitions!.filter(run => run.plannedHostKey?.startsWith('cloud-'))
      .map(run => run.expectedDurationMs!))
    const measuredEnd = host.files.length * 120_000 / (148 * 20_000 / 800_000)
    expect(measuredEnd).toBeLessThanOrEqual(cloudEnd)
    expect(host.expectedDurationMs).toBeGreaterThanOrEqual(measuredEnd)
    expect(read.partitions!.filter(run => run.suite === 'integration').flatMap(run => run.files).sort())
      .toEqual([...files].sort())
    const stored = (await database.pool.query('select record from ci_runs where id=$1', [host.id])).rows[0].record
    // The background dispatch may advance the lifecycle after the read; the persisted plan must match it.
    expect(stored).toMatchObject({ id: host.id, plannedHostKey: host.plannedHostKey, files: host.files,
      expectedDurationMs: host.expectedDurationMs, integrationShards: host.integrationShards })
  } finally { await f.close() }
})

it('reports how often each failed test failed in recent gate runs, through MCP and only to CI readers', async () => {
  const f = await fixture()
  try {
    const flaky = 'apps/api/test/flaky.integration.test.ts', hung = 'apps/api/test/hung.integration.test.ts'
    const insert = async (gate: boolean, state: 'passed' | 'failed', minutesAgo: number,
      files: { file: string; status: 'passed' | 'failed'; tests: { name: string; status: 'passed' | 'failed' }[] }[]) => {
      const at = new Date(Date.now() - minutesAgo * 60_000).toISOString()
      const record = CiRunRecordSchema.parse({ id: randomUUID(), workspaceId: f.workspaceId, groupId: randomUUID(),
        suite: 'integration', scope: gate ? 'full' : 'affected', gate, part: null, partition: null, files: files.map(item => item.file),
        repository: 'octo/site', commit: 'c'.repeat(40), state, computer: null, step: 'integration',
        exitCode: state === 'passed' ? 0 : 1, message: null, queuedAt: at, startedAt: at, finishedAt: at,
        initiator: { principalId: 'operator', executionId: null } })
      const failed = files.flatMap(item => item.tests).filter(test => test.status === 'failed').length
      const results = { truncated: false, summary: { passed: files.flatMap(item => item.tests).length - failed, failed, skipped: 0 },
        files: files.map(item => ({ ...item, durationMs: 10, tests: item.tests.map(test => ({ ...test, durationMs: 10 })) })) }
      await database.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record,test_results,created_at)
        values($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
      [record.id, f.workspaceId, record.groupId, state, JSON.stringify(record), JSON.stringify(results), at])
      return record.id
    }
    const flakyRun = (status: 'passed' | 'failed') => ({ file: flaky, status, tests: [{ name: 'retries', status }] })
    await insert(true, 'failed', 30, [flakyRun('failed'), { file: hung, status: 'failed', tests: [] }])
    await insert(true, 'passed', 20, [flakyRun('passed'), { file: hung, status: 'passed', tests: [] }])
    await insert(true, 'failed', 10, [flakyRun('failed')])
    // Non-gate runs are not history: Agents' own failing work would read as flakiness.
    await insert(false, 'failed', 5, [flakyRun('failed')])
    const ticket = await insert(false, 'failed', 1, [flakyRun('failed'), { file: hung, status: 'failed', tests: [] }])

    const read = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: ticket }))
    expect(read.failureHistory).toEqual([{ file: flaky, test: 'retries', failedRuns: 2, runs: 3 },
      { file: hung, test: null, failedRuns: 1, runs: 2 }])
    const denied = await f.call(await f.connect('ungranted'), 'ci_get', { ticketId: ticket })
    expect(denied.isError).toBe(true)
  } finally { await f.close() }
})

async function fixture(options: { cloudSlots?: number; files?: string[]; offlineKey?: string; pool?: pg.Pool;
  occupiedKeys?: Set<string>; unavailableKeys?: Set<string>; allowance?: number; hostCpuCount?: number;
  cloudProvider?: 'github' | 'circleci';
  readCloud?: (computer: HostCiComputer, request: Extract<CiHostRequest, { operation: 'read' }>)
    => Promise<CiHostReply | undefined> } = {}) {
  // Observation concurrency is half the pool, so a fleet of this size needs a pool that observes it in one pass.
  const ownedPool = options.pool ? undefined : createTestPool({ connectionString: database.databaseUrl, max: 64,
    options: '-c search_path=public -c statement_timeout=10000 -c lock_timeout=5000' })
  const pool = options.pool ?? ownedPool!
  const workspaceId = randomUUID()
  await database.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [workspaceId,
    JSON.stringify({ id: workspaceId, name: 'Gate workspace', repository: {
      provider: 'github', owner: 'octo', name: 'site', defaultBranch: 'main',
    }, ciMirror: { provider: 'github', owner: 'octo', name: 'site-ci' } })])
  const computers: HostCiComputer[] = [
    { key: 'builder-main', label: 'Main builder', priority: 60, ...{ buildAllowancePercent: options.allowance ?? 100 }, hostRef: { kind: 'main', mainId: 'main' } },
    { key: 'builder-paired', label: 'Paired builder', priority: 50, ...{ buildAllowancePercent: options.allowance ?? 100 },
      hostRef: { kind: 'device', mainId: 'main', deviceId: 'paired' } },
    ...Array.from({ length: options.cloudSlots ?? 24 }, (_, slot) => ({ key: `cloud-${slot}`, label: `Cloud ${slot}`, priority: 30,
      // CircleCI cannot run unit-other, so CircleCI fixtures keep GitHub slots for it.
      hostRef: { kind: 'cloud' as const, mainId: 'main',
        provider: options.cloudProvider === 'circleci' && slot % 2 === 0 ? 'circleci' as const : 'github' as const, slot },
      userSystemd: { supported: true, reason: null } })),
  ]
  const files = options.files ?? [...userSystemdIntegrationFiles,
    ...Array.from({ length: 48 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)]
  const runs = new Map<string, CiHostRun>()
  const startedAt = new Date().toISOString()
  const started: { key: string; request: CiHostRequest }[] = []
  const commands = new PostgresCommandCoordinator(pool)
  const ci = new HostCiService(pool, commands, new RunCiAuthority(pool), {
    resolve: async (_repository, _branch, commit) => commit ?? 'a'.repeat(40),
    capabilities: async () => ({ parts: true, integrationPartitions: true, affected: true }),
    integrationInventory: async () => ({ files, durations: Object.fromEntries(files.map(file => [file, 120_000])) }),
    unitInventory: async () => ({ files: ['apps/api/src/site.test.ts', 'apps/web/src/site.test.tsx'],
      durations: {}, heavy: [] }),
  }, {
    computers: async () => computers,
    request: async (computer, request) => {
      if (computer.key === options.offlineKey) throw new Error('Computer disconnected')
      if (request.operation === 'status') return { operation: 'status', ready: !options.unavailableKeys?.has(computer.key),
        reasons: options.unavailableKeys?.has(computer.key) ? ['Worker draining'] : [],
        cpuCount: computer.hostRef.kind === 'cloud' ? 4 : options.hostCpuCount ?? 16, memoryBytes: 16 * 2 ** 30,
        slotsTotal: computer.hostRef.kind === 'cloud' ? 1 : 2,
        slotsUsed: options.occupiedKeys?.has(computer.key) ? 1 : 0, runs: [] }
      if (request.operation === 'start') {
        started.push({ key: computer.key, request })
        const run: CiHostRun = { runId: request.runId, state: 'running', step: request.suite,
          exitCode: null, message: null, startedAt, finishedAt: null, logBytes: 0 }
        runs.set(request.runId, run)
        return { operation: 'start', run }
      }
      const run = runs.get(request.runId)!
      if (request.operation === 'cancel') return { operation: 'cancel', run: { ...run, state: 'canceled' } }
      const cloudReply = await options.readCloud?.(computer, request)
      if (cloudReply) return cloudReply
      return { operation: 'read', run: request.testResults ? { ...run, collection: 'unsupported' } : run,
        text: '', nextOffset: 0 }
    },
  })
  const access = new PostgresAccessService(pool)
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, ci } as unknown as OperatorServices } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  const connect = async (readOnly: boolean | 'ungranted' = false) => {
    let actions = [...CI_RUN_ACTIONS, ...CI_GET_ACTIONS]
    if (readOnly === 'ungranted') actions = ['workflows:read']
    else if (readOnly) actions = CI_GET_ACTIONS
    const issued = await access.issue({ name: 'Gate caller', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{
        actions, scope: { workspaceIds: [workspaceId] },
      }] })
    const client = new Client({ name: 'gate-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      requestInit: { headers: { authorization: `Bearer ${issued.token}` } },
    }))
    return client
  }
  const operator = await connect()
  const call = (client: Client, name: string, input: Record<string, unknown>) =>
    client.callTool({ name, arguments: { workspaceId, ...input } })
  const value = async (name: string, input: Record<string, unknown>) => {
    const result = await call(operator, name, input)
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    return decodeMcpToolResult(result)
  }
  const finishGate = async (ticketId: string) => {
    const initial = CiGetOutputSchema.parse(await value('ci_get', { ticketId }))
    const ids = new Set(initial.partitions!.map(ciExecutionRunId))
    for (let wave = 0; wave < initial.partitions!.length; wave++) {
      for (const [id, run] of runs) {
        if (ids.has(id)) runs.set(id, { ...run, state: 'passed', exitCode: 0,
          finishedAt: new Date(Date.parse(run.startedAt) + 1000).toISOString() })
      }
      await settle(ci)
      const read = CiGetOutputSchema.parse(await value('ci_get', { ticketId }))
      if (read.group?.state === 'passed') {
        await ciRunReadback(input => value('ci_get', input), ticketId, 'passed')
        return
      }
    }
    throw new Error('The gate did not finish every assigned job')
  }
  return { ci, started, runs, files, computers, workspaceId, connect, call, value, operator, finishGate, close: async () => {
    await Promise.all(clients.map(client => client.close()))
    await ci.close()
    await app.close()
    await ownedPool?.end()
  } }
}

it.each(['cloud', 'build'] as const)(
  'recovers an invisible CircleCI gate part on another %s computer through MCP', async destination => {
    const cloud = await cloudCiLookupFixture('running')
    let invisibleId: string | undefined
    const f = await fixture({ cloudProvider: 'circleci', readCloud: async (computer, request) => {
      if (request.runId !== invisibleId || computer.hostRef.provider !== 'circleci') return undefined
      const reply = await cloud.reopen().handle({ ...request, runId: cloud.run.runId })
      if (reply.operation !== 'read') throw new Error('Expected a cloud read')
      return { ...reply, run: { ...reply.run, runId: request.runId } }
    } })
    try {
      const admitted = CiRunOutputSchema.parse(await f.value('ci_run', {
        suite: 'integration', scope: 'full', gate: true, commit: 'a'.repeat(40),
      }))
      await settle(f.ci)
      const initial = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: admitted.ticketId }))
      const part = initial.partitions!.find(run => run.state === 'running' && run.suite === 'integration'
        && run.computer?.hostRef.provider === 'circleci')!
      expect(part).toBeDefined()
      invisibleId = part.id
      cloud.control.operation = 'run'
      cloud.control.error = 'run.not_found'
      await settle(f.ci)
      const computers = [...f.computers]
      if (destination === 'cloud') {
        const spare: HostCiComputer = { key: 'cloud-spare', label: 'Spare cloud', priority: 30,
          hostRef: { kind: 'cloud', mainId: 'main', provider: 'github', slot: 24 },
          userSystemd: { supported: true, reason: null } }
        f.computers.push(spare)
        computers.push(spare)
      } else {
        for (const run of initial.partitions!.filter(run => run.computer?.hostRef.kind !== 'cloud')) {
          const attempt = f.runs.get(run.id)
          if (attempt) f.runs.set(run.id, { ...attempt, state: 'passed', exitCode: 0,
            finishedAt: new Date().toISOString() })
        }
      }
      f.computers.splice(0, f.computers.length, ...f.computers.filter(computer =>
        computer.hostRef.provider === 'circleci' || (destination === 'cloud'
          ? computer.key === 'cloud-spare' : computer.hostRef.kind !== 'cloud')))
      cloud.advance(75_000)
      await settle(f.ci)
      const pending = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: part.id }))
      expect(pending.run).toMatchObject({ id: part.id, state: 'running', finishedAt: null,
        computer: { hostRef: part.computer!.hostRef } })
      expect(pending.run.unstartedProviders).toBeUndefined()
      expect(cloud.control.canceled).toEqual(['pipeline-1'])
      expect((await database.pool.query('select record,host_key from ci_runs where id=$1', [part.id])).rows[0])
        .toMatchObject({ record: { state: 'running', computer: { hostRef: part.computer!.hostRef } },
          host_key: expect.any(String) })
      cloud.control.error = ''
      cloud.control.outcome = 'canceled'
      cloud.advance(4_001)
      await settle(f.ci)
      const recovered = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: part.id }))
      expect(recovered.run).toMatchObject({ id: part.id, groupId: part.groupId, state: 'running',
        commit: part.commit, files: part.files, unstartedProviders: ['circleci'],
        messageHistory: expect.arrayContaining([expect.stringContaining('queued for another computer')]) })
      if (destination === 'cloud') expect(recovered.run.computer!.hostRef.provider).toBe('github')
      else expect(recovered.run.computer!.hostRef.kind).not.toBe('cloud')
      expect(recovered.run.computer!.hostRef).not.toEqual(part.computer!.hostRef)
      expect(cloud.control.canceled).toEqual(['pipeline-1'])
      expect(recovered.run.executionRunId).toEqual(expect.any(String))
      expect(recovered.run.executionRunId).not.toBe(part.id)
      expect(f.started.filter(value => value.request.operation === 'start' && value.request.runId === part.id))
        .toHaveLength(1)
      expect(f.started.filter(value => value.request.operation === 'start'
        && value.request.runId === recovered.run.executionRunId)).toHaveLength(1)
      expect((await database.pool.query('select record,host_key from ci_runs where id=$1', [part.id])).rows[0])
        .toMatchObject({ record: recovered.run, host_key: expect.any(String) })
      const denied = await f.connect('ungranted')
      expect((await f.call(denied, 'ci_get', { ticketId: part.id })).isError).toBe(true)
      f.computers.splice(0, f.computers.length, ...computers)
      await f.finishGate(admitted.ticketId)
      const completed = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: part.id }))
      expect(completed.run).toMatchObject({ id: part.id, state: 'passed', unstartedProviders: ['circleci'] })
      expect(completed.group?.state).toBe('passed')
    } finally {
      await f.close()
      await cloud.close()
    }
  },
)

it.each(['cloud', 'build'] as const)('requeues a cloud setup failure once on another %s slot and completes the gate', async destination => {
  const f = await fixture()
  try {
    const computers = [...f.computers]
    const started = CiRunOutputSchema.parse(await f.value('ci_run', {
      suite: 'integration', scope: 'full', gate: true, commandId: randomUUID(), commit: 'a'.repeat(40),
    }))
    await settle(f.ci)
    const initial = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: started.ticketId }))
    const part = initial.partitions!.find(run => run.state === 'running' && run.suite === 'unit'
      && run.computer?.hostRef.kind === 'cloud')!
    expect(part).toBeDefined()
    const attempt = f.runs.get(part.id)!
    const reason = 'CI hang watchdog: no test progress for 180000 ms; running: no test started (setup or command)'
    const failed = { ...attempt, state: 'failed' as const, exitCode: 1,
      finishedAt: new Date().toISOString(), message: reason, testsStarted: false }
    f.runs.set(part.id, failed)
    if (destination === 'build') {
      for (const host of initial.partitions!.filter(run => run.computer?.hostRef.kind !== 'cloud')) {
        if (host.computer?.hostRef.kind === 'main') continue
        const running = f.runs.get(host.id)
        if (running) f.runs.set(host.id, { ...running, state: 'passed', exitCode: 0,
          finishedAt: new Date().toISOString() })
      }
    } else {
      // Add spare capacity after planning so it cannot receive an original gate part.
      const spare: HostCiComputer = { key: 'cloud-spare', label: 'Spare cloud', priority: 30,
        hostRef: { kind: 'cloud', mainId: 'main', provider: 'github', slot: 24 },
        userSystemd: { supported: true, reason: null } }
      f.computers.push(spare)
      computers.push(spare)
    }
    // Keep the failed slot available so the retry must explicitly exclude it.
    // The build case asserts Main placement, so only Main can accept its retry.
    f.computers.splice(0, f.computers.length, ...f.computers.filter(computer =>
      computer.key === part.plannedHostKey || (destination === 'cloud'
        ? computer.hostRef.kind === 'cloud' : computer.hostRef.kind === 'main')))
    await settle(f.ci)
    if (destination === 'build') {
      const waiting = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: part.id }))
      expect(waiting.run).toMatchObject({ state: 'queued', setupRetry: { reason } })
      for (const host of initial.partitions!.filter(run => run.computer?.hostRef.kind === 'main')) {
        f.runs.set(host.id, { ...f.runs.get(host.id)!, state: 'passed', exitCode: 0,
          finishedAt: new Date().toISOString() })
      }
      await settle(f.ci)
    }
    const read = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: part.id }))
    expect(read.run).toMatchObject({ state: 'running', id: part.id, groupId: part.groupId,
      setupRetry: { reason, failedComputer: part.computer!.hostRef } })
    expect(read.run.computer!.hostRef).not.toEqual(part.computer!.hostRef)
    expect(read.run.computer!.hostRef.kind).toBe(destination === 'cloud' ? 'cloud' : 'main')
    expect(read.group?.state).not.toBe('failed')
    expect(f.started.filter(value => value.request.operation === 'start'
      && value.request.runId === read.run.setupRetry!.runId)).toHaveLength(1)
    const attempts = f.started.filter(value => value.request.operation === 'start'
      && value.request.runId === part.id)
    expect(attempts).toHaveLength(1)
    expect(f.started.some(value => value.request.operation === 'start'
      && value.request.runId !== part.id && value.request.suite === part.suite && value.key !== part.plannedHostKey)).toBe(true)
    expect((await database.pool.query('select record from ci_runs where id=$1', [part.id])).rows[0].record)
      .toEqual(read.run)
    const denied = await f.connect('ungranted')
    expect((await f.call(denied, 'ci_get', { ticketId: part.id })).isError).toBe(true)
    const retry = f.started.findLast(value => value.request.operation === 'start'
      && value.request.suite === part.suite && value.request.part === part.part)!.request
    if (retry.operation !== 'start') throw new Error('Expected a retry start')
    f.runs.set(retry.runId, { ...f.runs.get(retry.runId)!, state: 'passed', exitCode: 0,
      finishedAt: new Date().toISOString() })
    f.computers.splice(0, f.computers.length, ...computers)
    await settle(f.ci)
    await f.finishGate(started.ticketId)
    const completed = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: part.id }))
    expect(completed.run).toMatchObject({ state: 'passed', setupRetry: { reason } })
    expect(completed.group?.state).toBe('passed')
  } finally { await f.close() }
})

it('fails the gate on a second setup failure and does not retry a failure after tests start', async () => {
  const f = await fixture()
  try {
    const started = CiRunOutputSchema.parse(await f.value('ci_run', {
      suite: 'integration', scope: 'full', gate: true, commandId: randomUUID(), commit: 'a'.repeat(40),
    }))
    await settle(f.ci)
    const initial = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: started.ticketId }))
    const parts = initial.partitions!.filter(run => run.state === 'running' && run.suite === 'unit'
      && run.computer?.hostRef.kind === 'cloud')
    const part = parts[0]!
    const other = parts[1]!
    const reason = 'Setup failed before the first test started'
    for (const [run, testsStarted] of [[part, false], [other, true]] as const) {
      const failed = { ...f.runs.get(run.id)!, state: 'failed' as const, exitCode: 1,
        finishedAt: new Date().toISOString(), message: reason, testsStarted }
      f.runs.set(run.id, failed)
    }
    await settle(f.ci)
    const retried = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: part.id }))
    expect(retried.run).toMatchObject({ state: 'running', setupRetry: { reason } })
    expect(CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: other.id })).run)
      .toMatchObject({ state: 'failed' })
    const request = f.started.findLast(value => value.request.operation === 'start'
      && value.request.suite === part.suite && value.request.part === part.part)!.request
    if (request.operation !== 'start') throw new Error('Expected a retry start')
    expect(request.runId).not.toBe(part.id)
    // No test started, so the executor has no results to report.
    const failed = { ...f.runs.get(request.runId)!, state: 'failed' as const, exitCode: 2,
      finishedAt: new Date().toISOString(), message: 'Second setup failure', testsStarted: false,
      collection: 'unsupported' as const }
    f.runs.set(request.runId, failed)
    const attempts = f.started.length
    await settle(f.ci)
    const finished = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: part.id }))
    expect(finished.run).toMatchObject({ state: 'failed', exitCode: 2,
      message: 'Second setup failure', setupRetry: { reason } })
    expect(finished.group?.state).toBe('failed')
    expect(f.started).toHaveLength(attempts)
  } finally { await f.close() }
})

it('observes a setup retry only where it runs when a dispatch listing predates the requeue', async () => {
  const pool = createTestPool({ connectionString: database.databaseUrl, max: 64,
    options: '-c search_path=public -c statement_timeout=10000 -c lock_timeout=5000' })
  // Every result reaches the service through this hook, so the test can hold a pass between its listing and its
  // observations without reading the statements.
  let afterResult: ((values: unknown[] | undefined, rows: Record<string, unknown>[]) => Promise<void>) | undefined
  const query = pool.query.bind(pool) as unknown as
    (text: unknown, values?: unknown[]) => Promise<pg.QueryResult<Record<string, unknown>>>
  pool.query = (async (text: unknown, values?: unknown[]) => {
    const result = await query(text, values)
    await afterResult?.(values, result.rows)
    return result
  }) as unknown as typeof pool.query
  const reads: { key: string; runId: string }[] = []
  let heldRead: { runId: string; reached: () => void; release: Promise<void> } | undefined
  // Nine cloud slots each take one of the gate's nine checks, so a setup retry waits until a check finishes.
  const f = await fixture({ pool, cloudSlots: 9, readCloud: async (computer, request) => {
    reads.push({ key: computer.key, runId: request.runId })
    const held = heldRead
    if (held?.runId === request.runId) {
      heldRead = undefined
      held.reached()
      await held.release
    }
    return undefined
  } })
  try {
    const started = CiRunOutputSchema.parse(await f.value('ci_run', {
      suite: 'integration', scope: 'full', gate: true, commandId: randomUUID(), commit: 'a'.repeat(40),
    }))
    await settle(f.ci)
    const initial = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: started.ticketId }))
    const [part, other] = initial.partitions!.filter(run => run.state === 'running' && run.suite === 'unit'
      && run.computer?.hostRef.kind === 'cloud')
    const failedKey = (await database.pool.query<{ host_key: string }>('select host_key from ci_runs where id=$1',
      [part!.id])).rows[0]!.host_key
    const firstRunId = ciExecutionRunId(part!)
    const reason = 'Setup failed before the first test started'
    f.runs.set(firstRunId, { ...f.runs.get(firstRunId)!, state: 'failed', exitCode: 1,
      finishedAt: new Date().toISOString(), message: reason, testsStarted: false })
    // A pass starts observing the setup failure; the executor answers once the next pass has listed the ticket.
    let release!: () => void
    const reached = new Promise<void>(resolve => {
      heldRead = { runId: firstRunId, reached: resolve, release: new Promise<void>(done => { release = done }) }
    })
    const firstPass = f.ci.dispatch()
    await reached
    await firstPass
    let requeued!: () => void
    const retryQueued = new Promise<void>(resolve => { requeued = resolve })
    let listed = false
    afterResult = async (values, rows) => {
      const state = (rows[0]?.record as { state?: string } | undefined)?.state
      if (values?.[0] === part!.id && state === 'queued') requeued()
      if (listed || !rows.some(row => row.id === part!.id && row.host_key === failedKey)) return
      listed = true
      // This pass still lists the failed attempt on its executor; the held observation now queues the setup retry.
      release()
      await retryQueued
      // Reading the requeued ticket back is that observation's last I/O.
      await new Promise(resolve => setImmediate(resolve))
    }
    await f.ci.dispatch()
    afterResult = undefined
    // Every other slot is still busy, so the setup retry stays queued while the stale listing is observed.
    await settle(f.ci)
    expect(CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: part!.id })).run)
      .toMatchObject({ state: 'queued', setupRetry: { reason } })
    const otherRunId = ciExecutionRunId(other!)
    f.runs.set(otherRunId, { ...f.runs.get(otherRunId)!, state: 'passed', exitCode: 0,
      finishedAt: new Date().toISOString() })
    await settle(f.ci)
    const retried = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: part!.id }))
    expect(retried.run).toMatchObject({ state: 'running', setupRetry: { reason } })
    const retryRunId = ciExecutionRunId(retried.run)
    expect(retryRunId).not.toBe(firstRunId)
    // The failed executor never holds the retry, so nothing asks it about the retry.
    expect(reads.filter(read => read.runId === retryRunId && read.key === failedKey)).toEqual([])
    expect(retried.run.observation?.status).not.toBe('unavailable')
    f.runs.set(retryRunId, { ...f.runs.get(retryRunId)!, state: 'failed', exitCode: 2,
      finishedAt: new Date().toISOString(), message: 'Second setup failure', testsStarted: false,
      collection: 'unsupported' })
    await settle(f.ci)
    expect(CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: part!.id })).run)
      .toMatchObject({ state: 'failed', exitCode: 2, message: 'Second setup failure', setupRetry: { reason } })
  } finally {
    await f.close()
    await pool.end()
  }
})

it('keeps a draining build gate off cloud until the grace expires, then persists and completes its cloud parts through MCP', async () => {
  const files = Array.from({ length: 80 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
  const durations = Object.fromEntries(files.map((file, index) => [file, index < 24 ? 60_000 : 5_000]))
  const f = await fixture({ cloudSlots: 4, files,
    unavailableKeys: new Set(['builder-main', 'builder-paired']) })
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  try {
    const reader = await f.connect(true)
    expect((await f.call(reader, 'ci_run', { suite: 'integration', scope: 'full', gate: true,
      commandId: randomUUID() })).isError).toBe(true)
    expect((await database.pool.query('select count(*)::int as count from ci_runs')).rows[0].count).toBe(0)
    const hostShards = buildComputerIntegrationShards({ cpuCount: 16, memoryBytes: 16 * 2 ** 30 })
    const root = CiRunRecordSchema.parse({ id: randomUUID(), workspaceId: f.workspaceId, groupId: randomUUID(),
      suite: 'integration', part: null, partition: null, scope: 'full', files,
      repository: 'octo/site', ciMirror: 'octo/site-ci', commit: 'a'.repeat(40), gate: true, noSupersede: true,
      plannedHostKey: 'builder-main', integrationShards: hostShards, expectedDurationMs: 300_000,
      priority: 'high', priorityReason: 'gate', state: 'queued', computer: null, step: null,
      exitCode: null, message: null, queuedAt: new Date(now).toISOString(), startedAt: null, finishedAt: null,
      initiator: { principalId: 'operator', executionId: null }, requiresBuildComputer: false })
    await database.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record,durations)
      values($1,$2,$3,'queued',$4::jsonb,$5::jsonb)`,
    [root.id, root.workspaceId, root.groupId, JSON.stringify(root), JSON.stringify(durations)])
    clock.mockReturnValue(now + 90_000)
    await settle(f.ci)
    expect(f.started).toEqual([])
    expect(CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: root.id })).run)
      .toMatchObject({ state: 'queued', files, plannedHostKey: 'builder-main', integrationShards: hostShards })
    clock.mockReturnValue(now + 90_001)
    await settle(f.ci)
    const read = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: root.id }))
    expect(read.partitions!.length).toBeGreaterThan(4)
    expect(read.partitions!.flatMap(run => run.files).sort()).toEqual([...files].sort())
    expect(f.started).toHaveLength(4)
    for (const run of read.partitions!) {
      expect(run).toMatchObject({ gate: true, groupId: root.groupId, integrationShards: 4,
        plannedHostKey: expect.stringMatching(/^cloud-/), partition: null })
      const stored = (await database.pool.query('select record from ci_runs where id=$1', [run.id])).rows[0].record
      expect(stored).toEqual(run)
    }
    await f.finishGate(root.id)
    const finished = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: root.id }))
    expect(finished.group?.state).toBe('passed')
    const executed = f.started.flatMap(item => item.request.operation === 'start' ? item.request.files ?? [] : [])
    expect(executed.sort()).toEqual([...files].sort())
  } finally {
    clock.mockRestore()
    await f.close()
  }
})

it('persists gate check reassignment to an idle build computer through MCP when cloud slots are busy', async () => {
  const occupiedKeys = new Set(['cloud-0', 'cloud-1'])
  const f = await fixture({ cloudSlots: 2, occupiedKeys, files: ['apps/api/test/feature.integration.test.ts'] })
  try {
    const input = { suite: 'integration', scope: 'full', gate: true, commit: 'a'.repeat(40), commandId: randomUUID() }
    const reader = await f.connect(true)
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    expect((await database.pool.query('select count(*)::int as count from ci_runs')).rows[0].count).toBe(0)
    const admitted = CiRunOutputSchema.parse(await f.value('ci_run', input))
    expect(CiRunOutputSchema.parse(await f.value('ci_run', input))).toEqual(admitted)
    await settle(f.ci)
    const read = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: admitted.ticketId }))
    const check = read.partitions!.find(run => run.suite !== 'integration' && run.state === 'running')!
    expect(check).toMatchObject({ state: 'running', plannedHostKey: expect.stringMatching(/^cloud-/),
      expectedDurationMs: expect.any(Number),
      computer: { hostRef: { kind: 'device', mainId: 'main', deviceId: 'paired' } } })
    expect(f.started.find(item => item.request.operation === 'start' && item.request.runId === check.id)?.key)
      .toBe('builder-paired')
    expect(read.gate?.computers.find(computer => computer.key === check.plannedHostKey)?.ticketIds).toContain(check.id)
    expect(read.gate?.criticalPath.expectedDurationMs).toBeGreaterThan(0)
    const stored = (await database.pool.query('select record from ci_runs where id=$1', [check.id])).rows[0].record
    expect(stored).toEqual(check)
  } finally { await f.close() }
})

it.each([false, true])('admits consecutive gates on different connections after a lost lock reply: %s', async lostReply => {
  const pool = createPool({ connectionString: database.databaseUrl, maxConnections: 32,
    connectionTimeoutMs: 1_000, queryTimeoutMs: 1_000 }, 'gate-lock-test')
  const f = await fixture({ pool })
  let loseReply = lostReply
  const query = pg.Client.prototype.query
  // Admission uses a dedicated pool, so inject the driver fault on every client.
  const queryFault = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (
    this: pg.Client, ...args: unknown[]
  ) {
    const result = Reflect.apply(query, this, args)
    const values = args[1]
    if (!loseReply || !Array.isArray(values) || typeof values[0] !== 'string'
      || !values[0].startsWith('ci-admission:')) return result
    loseReply = false
    // The server acquired the lock, but the driver did not deliver its acknowledgment.
    return (result as Promise<unknown>).then(() => { throw new Error('Query read timeout') })
  } as typeof pg.Client.prototype.query)
  const held: pg.PoolClient[] = []
  try {
    const gate = { suite: 'integration', scope: 'full', gate: true, commit: 'a'.repeat(40) }
    const firstInput = { ...gate, commandId: randomUUID() }
    if (lostReply) {
      const failed = await f.call(f.operator, 'ci_run', firstInput)
      expect(failed.isError).toBe(true)
      expect(decodeMcpToolResult(failed)).toMatchObject({ error: { code: 'COMMAND_DATABASE_TIMEOUT' } })
      expect((await database.pool.query('select count(*)::int as count from ci_runs')).rows[0].count).toBe(0)
    }
    const first = CiRunOutputSchema.parse(await f.value('ci_run', firstInput))
    expect(CiRunOutputSchema.parse(await f.value('ci_run', firstInput))).toEqual(first)
    await settle(f.ci)
    // Retain every existing connection so the second command cannot reenter a leaked session lock.
    while (pool.idleCount) held.push(await pool.connect())
    const second = CiRunOutputSchema.parse(await f.value('ci_run', { ...gate, commandId: randomUUID() }))
    expect(second.ticketId).not.toBe(first.ticketId)
    await settle(f.ci)
    for (const ticketId of [first.ticketId, second.ticketId]) {
      const read = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId }))
      expect(read.run).toMatchObject({ id: ticketId, gate: true })
      expect(read.partitions!.length).toBeGreaterThan(1)
      const stored = (await database.pool.query('select record from ci_runs where id=$1', [ticketId])).rows[0].record
      expect(stored).toEqual(read.run)
    }
  } finally {
    queryFault.mockRestore()
    for (const client of held) client.release()
    await f.close()
    await pool.end()
  }
})

it('admits one complete gate, denies a reader, and persists the plan and measured critical path through MCP', async () => {
  const f = await fixture()
  try {
    const input = { suite: 'integration', scope: 'full', gate: true, commit: 'a'.repeat(40), commandId: randomUUID() }
    const reader = await f.connect(true)
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    expect((await database.pool.query('select count(*)::int as count from ci_runs')).rows[0].count).toBe(0)
    const admitted = CiRunOutputSchema.parse(await f.value('ci_run', input))
    expect(CiRunOutputSchema.parse(await f.value('ci_run', input))).toEqual(admitted)
    await settle(f.ci)
    const read = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: admitted.ticketId }))
    expect(new Set(read.partitions!.map(run => run.suite))).toEqual(new Set(['typecheck', 'lint', 'unit', 'integration']))
    expect(read.partitions!.every(run => run.scope === 'full')).toBe(true)
    const hosts = f.started.filter(item => item.key.startsWith('builder-'))
    expect(hosts).toHaveLength(2)
    for (const host of hosts) expect(host.request).toMatchObject({ suite: 'integration', gate: true,
      integrationShards: gateIntegrationShards(16, Math.floor(16 * 2 ** 30 * 0.9)) })
    const integration = read.partitions!.filter(run => run.suite === 'integration')
    const assigned = integration.flatMap(run => run.files)
    expect(assigned.sort()).toEqual([...f.files].sort())
    expect(new Set(assigned).size).toBe(assigned.length)
    expect(integration.some(run => run.plannedHostKey?.startsWith('cloud-'))).toBe(true)
    expect(read).toMatchObject({ gate: { computers: expect.any(Array), criticalPath: {
      expectedDurationMs: expect.any(Number), actualDurationMs: null,
    } } })
    await f.finishGate(admitted.ticketId)
    const finished = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: admitted.ticketId }))
    expect(finished.group?.state).toBe('passed')
    const launched = f.started.flatMap(item => item.request.operation === 'start'
      && item.request.suite === 'integration' ? item.request.files ?? [] : [])
    expect(launched.sort()).toEqual([...f.files].sort())
    expect(finished).toMatchObject({ gate: { suites: expect.arrayContaining([
      expect.objectContaining({ suite: 'integration', actualDurationMs: 1000 }),
    ]), criticalPath: { actualDurationMs: expect.any(Number) } } })
    const stored = (await database.pool.query('select record from ci_runs where group_id=$1', [read.run.groupId])).rows
    expect(stored.map(row => row.record)).toEqual(expect.arrayContaining(finished.partitions!))
  } finally { await f.close() }
})

it('admits a gate on the ready fleet when another build computer is disconnected', async () => {
  const f = await fixture({ offlineKey: 'builder-paired' })
  try {
    const admitted = CiRunOutputSchema.parse(await f.value('ci_run', {
      suite: 'integration', scope: 'full', gate: true, commit: 'a'.repeat(40), commandId: randomUUID(),
    }))
    await settle(f.ci)
    const read = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: admitted.ticketId }))
    expect(read.gate!.computers.some(computer => computer.key === 'builder-paired')).toBe(false)
    expect(read.partitions!.filter(run => run.suite === 'integration').flatMap(run => run.files).sort())
      .toEqual([...f.files].sort())
  } finally { await f.close() }
})

it('runs cloud checks before systemd integration overflow even when checks move between slots', async () => {
  const occupiedKeys = new Set(['cloud-0', 'cloud-1', 'cloud-2', 'cloud-3'])
  const unavailableKeys = new Set<string>()
  const f = await fixture({ cloudSlots: 4, files: [...exclusiveIntegrationFiles], occupiedKeys, unavailableKeys })
  const dispatch = vi.spyOn(f.ci, 'dispatch').mockResolvedValue()
  vi.spyOn(f.ci, 'start').mockImplementation(() => {})
  const clock = vi.spyOn(Date, 'now')
  try {
    const input = {
      suite: 'integration', scope: 'full', gate: true, commit: 'a'.repeat(40), commandId: randomUUID(),
    }
    const reader = await f.connect(true)
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    const admitted = CiRunOutputSchema.parse(await f.value('ci_run', input))
    expect(CiRunOutputSchema.parse(await f.value('ci_run', input))).toEqual(admitted)
    // Overflow is created after build computers drain and their dispatch grace expires.
    unavailableKeys.add('builder-main')
    unavailableKeys.add('builder-paired')
    occupiedKeys.clear()
    dispatch.mockRestore()
    clock.mockReturnValue(Date.now() + 90_001)
    await settle(f.ci)
    const read = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: admitted.ticketId }))
    const overflow = read.partitions!.filter(run => run.suite === 'integration'
      && run.plannedHostKey?.startsWith('cloud-'))
    expect(overflow.length).toBeGreaterThan(0)
    for (const run of overflow) {
      const checks = read.partitions!.filter(check => check.suite !== 'integration'
        && check.plannedHostKey === run.plannedHostKey)
      expect(checks.length).toBeGreaterThan(0)
      expect(run.state).toBe('queued')
      expect((await database.pool.query('select record from ci_runs where id=$1', [run.id])).rows[0].record)
        .toEqual(run)
    }
    const runningCloud = read.partitions!.filter(run => run.state === 'running'
      && run.computer?.hostRef.kind === 'cloud')
    expect(runningCloud).toHaveLength(4)
    expect(runningCloud.every(run => run.suite !== 'integration')).toBe(true)
    const runningSlots = runningCloud.map(run => run.computer!.hostRef)
    expect(new Set(runningSlots.map(ref => JSON.stringify(ref))).size).toBe(4)
    await f.finishGate(admitted.ticketId)
    const finished = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: admitted.ticketId }))
    expect(finished.group?.state).toBe('passed')
    const launched = f.started.flatMap(item => item.request.operation === 'start'
      && item.request.suite === 'integration' ? item.request.files ?? [] : [])
    expect(launched.sort()).toEqual([...f.files].sort())
  } finally {
    dispatch.mockRestore()
    clock.mockRestore()
    await f.close()
  }
})

it('queues a second gate behind the first while full and affected requests keep using spare cloud slots', async () => {
  const f = await fixture({ cloudSlots: 40 })
  try {
    const gate = { suite: 'integration', scope: 'full', gate: true, commit: 'a'.repeat(40) }
    const first = CiRunOutputSchema.parse(await f.value('ci_run', { ...gate, commandId: randomUUID() }))
    const full = CiRunOutputSchema.parse(await f.value('ci_run', {
      suite: 'lint', scope: 'full', commandId: randomUUID(), commit: 'b'.repeat(40),
    }))
    const affected = CiRunOutputSchema.parse(await f.value('ci_run', {
      suite: 'lint', scope: 'affected', files: ['apps/web/src/site.tsx'], commandId: randomUUID(), commit: 'b'.repeat(40),
    }))
    const second = CiRunOutputSchema.parse(await f.value('ci_run', { ...gate, commandId: randomUUID() }))
    await settle(f.ci)
    expect(CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: first.ticketId })).group?.state).toBe('running')
    expect(CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: second.ticketId }))).toMatchObject({
      run: { state: 'queued', message: expect.stringContaining('gate') },
      queue: { reason: expect.stringContaining('gate') },
    })
    for (const ticketId of [full.ticketId, affected.ticketId]) {
      expect(CiGetOutputSchema.parse(await f.value('ci_get', { ticketId })).run.state).toBe('running')
    }
    await f.finishGate(first.ticketId)
    expect(CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: second.ticketId })).group?.state).toBe('running')
  } finally { await f.close() }
})

it.each([[50, 4], [10, 1]])('persists and dispatches a gate within a %i percent build allowance through MCP', async (allowance, shards) => {
  const f = await fixture({ allowance, cloudSlots: 2 })
  try {
    const input = { suite: 'integration', scope: 'full', gate: true, commit: 'a'.repeat(40), commandId: randomUUID() }
    const reader = await f.connect(true)
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    const admitted = CiRunOutputSchema.parse(await f.value('ci_run', input))
    await settle(f.ci)
    const read = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: admitted.ticketId }))
    const hosts = read.partitions!.filter(run => run.suite === 'integration' && run.plannedHostKey?.startsWith('builder-'))
    expect(hosts).toHaveLength(2)
    // 50%: 8 GiB minus 1 GiB host reserve and 1 GiB shared overhead allows four 1.5 GiB shards.
    // 10% leaves less than one shard after reserves, so the minimum is one.
    for (const host of hosts) {
      expect(host.integrationShards).toBe(shards)
      expect(f.started.find(item => item.request.operation === 'start' && item.request.runId === host.id)?.request)
        .toMatchObject({ integrationShards: shards })
      expect((await database.pool.query('select record from ci_runs where id=$1', [host.id])).rows[0].record)
        .toEqual(host)
    }
  } finally { await f.close() }
})

it('rechecks the build allowance when dispatching an already planned gate through MCP', async () => {
  const occupiedKeys = new Set<string>()
  // Exclusive files cannot share parallel lanes, so the plan uses both builders.
  const files = ['apps/api/test/dev-startup.integration.test.ts', 'apps/api/test/ci-postgres-setup.integration.test.ts']
  const f = await fixture({ occupiedKeys, cloudSlots: 2, files })
  const dispatch = vi.spyOn(f.ci, 'dispatch').mockResolvedValue()
  vi.spyOn(f.ci, 'start').mockImplementation(() => {})
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    const admitted = CiRunOutputSchema.parse(await f.value('ci_run', {
      suite: 'integration', scope: 'full', gate: true, commit: 'a'.repeat(40), commandId: randomUUID(),
    }))
    occupiedKeys.add('builder-main')
    occupiedKeys.add('builder-paired')
    dispatch.mockRestore()
    // Planning reuses a computer's readiness for a few seconds; let the admission snapshot expire.
    vi.setSystemTime(Date.now() + 10_000)
    await settle(f.ci)
    const queued = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: admitted.ticketId }))
    const planned = queued.partitions!.filter(run => run.suite === 'integration'
      && run.plannedHostKey?.startsWith('builder-'))
    expect(planned.map(run => run.plannedHostKey).sort()).toEqual(['builder-main', 'builder-paired'])
    expect(planned).toHaveLength(2)
    for (const host of planned) {
      expect(host.files).toHaveLength(1)
      expect(host).toMatchObject({ state: 'queued', integrationShards: 8 })
    }
    for (const computer of f.computers.filter(computer => computer.hostRef.kind !== 'cloud')) {
      Object.assign(computer, { buildAllowancePercent: 50 })
    }
    occupiedKeys.clear()
    vi.setSystemTime(Date.now() + 10_000)
    await settle(f.ci)
    const read = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: admitted.ticketId }))
    const hosts = read.partitions!.filter(run => run.suite === 'integration' && run.plannedHostKey?.startsWith('builder-'))
    expect(hosts).toHaveLength(2)
    expect(hosts.map(host => host.id).sort()).toEqual(planned.map(host => host.id).sort())
    for (const host of hosts) {
      expect(host).toMatchObject({ state: 'running', integrationShards: 8 })
      expect(f.started.find(item => item.request.operation === 'start' && item.request.runId === host.id)?.request)
        .toMatchObject({ integrationShards: 4 })
    }
  } finally {
    dispatch.mockRestore()
    vi.useRealTimers()
    await f.close()
  }
})

it('persists the heavy-file CPU budget before exclusive Worker recovery through authenticated MCP', async () => {
  const files = [
    'apps/api/test/harness-installation-update-rollback.integration.test.ts',
    'apps/api/test/remote-review-production-defaults.integration.test.ts',
    'apps/api/test/remote-review-production-worker-crash.integration.test.ts',
  ]
  const f = await fixture({ files, cloudSlots: 2, hostCpuCount: 2,
    unavailableKeys: new Set(['builder-paired']) })
  try {
    const input = { suite: 'integration', scope: 'full', gate: true, commit: 'a'.repeat(40), commandId: randomUUID() }
    const reader = await f.connect(true)
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    expect((await database.pool.query('select count(*)::int as count from ci_runs')).rows[0].count).toBe(0)
    const admitted = CiRunOutputSchema.parse(await f.value('ci_run', input))
    expect(CiRunOutputSchema.parse(await f.value('ci_run', input))).toEqual(admitted)
    // Drain background dispatch before comparing persisted records across readers.
    await f.ci.close()
    const read = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: admitted.ticketId }))
    const integration = read.partitions!.filter(run => run.suite === 'integration')
    expect(integration).toHaveLength(1)
    expect(integration[0]).toMatchObject({ plannedHostKey: 'builder-main', integrationShards: 2,
      expectedDurationMs: 450_000 })
    expect(integration[0]!.files.slice().sort()).toEqual(files.slice().sort())
    const stored = (await database.pool.query('select record from ci_runs where id=$1', [integration[0]!.id])).rows[0].record
    expect(stored).toEqual(integration[0])
    const readerResult = await f.call(reader, 'ci_get', { ticketId: admitted.ticketId })
    expect(readerResult.isError).not.toBe(true)
    expect(CiGetOutputSchema.parse(decodeMcpToolResult(readerResult)).partitions).toEqual(read.partitions)
  } finally {
    await f.close()
  }
})
