import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { CiComputersOutputSchema, CiGetOutputSchema, CiRunRecordSchema,
  type CiHostRequest, type CiHostRun, type CiRunRecord } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { HostCiService, type CiCommits, type HostCiComputer, type HostCiEndpoint } from '../src/modules/ci-host/service.js'
import { DeviceApplicationError } from '../src/modules/devices/deviceApplicationError.js'
import { readServiceHealth } from '../src/modules/diagnostics/serviceHealth.js'
import { CI_GET_ACTIONS, RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { deferred } from './helpers/deferred.js'

let database: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { database = await migratedDatabase() }, 60_000)
afterAll(async () => { await database?.close() }, 60_000)
beforeEach(async () => {
  await database.pool.query('truncate ci_runs, ci_file_durations, management_command_receipts, management_audit')
  vi.useFakeTimers({ toFake: ['Date'] })
})
afterEach(() => vi.useRealTimers())

async function fixture(options: { state?: 'starting' | 'running'; expectedDurationMs?: number; gate?: boolean;
  executionRunId?: string } = {}) {
  const state = options.state ?? 'running'
  const expectedDurationMs = options.expectedDurationMs ?? 189_000
  const gate = options.gate ?? false
  const pool = database.pool
  const workspaceId = randomUUID()
  const at = new Date().toISOString()
  const computers: HostCiComputer[] = [0, 1].map(index => ({
    key: `fixture:executor:${index}`, label: `Executor ${index}`, priority: 2 - index,
    hostRef: { kind: 'device', mainId: 'fixture', deviceId: `executor-${index}` },
  }))
  const original = computers[0]!
  const replacement = computers[1]!
  const files = Array.from({ length: 49 }, (_, index) => `apps/api/test/example-${index}.integration.test.ts`)
  const durations = Object.fromEntries(files.map(file => [file, 189_000]))
  const selectedFile = files[14]!
  const record = CiRunRecordSchema.parse({
    id: randomUUID(), workspaceId, groupId: randomUUID(), suite: 'integration', part: null,
    ...(options.executionRunId ? { executionRunId: options.executionRunId } : {}),
    scope: 'full', files: gate ? [selectedFile] : [],
    partition: gate ? null : { index: 14, count: 49, weights: Array.from({ length: 49 }, () => 1),
      tier: 'slow', slowFiles: files },
    gate, ...(gate ? { integrationShards: 1 } : {}), plannedHostKey: original.key, expectedDurationMs,
    repository: 'fixture/site', commit: 'a'.repeat(40), state,
    computer: { hostRef: original.hostRef, label: original.label }, step: state === 'starting' ? 'dispatch' : 'integration',
    exitCode: null, message: null, queuedAt: at, dispatchedAt: at,
    startedAt: state === 'running' ? at : null, finishedAt: null,
    initiator: { principalId: 'operator', executionId: null },
  })
  await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [workspaceId,
    JSON.stringify({ id: workspaceId, name: 'CI recovery', repository: {
      provider: 'github', owner: 'fixture', name: 'site', defaultBranch: 'main',
    } })])
  const insert = async (run: CiRunRecord, hostKey: string | null = null) => {
    await pool.query(`insert into ci_runs(id,workspace_id,group_id,state,host_key,record,durations)
      values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
    [run.id, workspaceId, run.groupId, run.state, hostKey, JSON.stringify(run), JSON.stringify(durations)])
  }
  await insert(record, original.key)
  let offline = true
  let finished = false
  let cleanup: 'running' | 'pending' | 'stopped' = 'running'
  let replacementReady = true
  let readFailure: string | undefined
  let replacementReadFailure: string | undefined
  let statusExecutionId: string | undefined
  let statusState: CiHostRun['state'] = 'running'
  let heldStatus: { entered: ReturnType<typeof deferred<void>>; reply: ReturnType<typeof deferred<void>> } | undefined
  let heldRead: { entered: ReturnType<typeof deferred<void>>; reply: ReturnType<typeof deferred<void>> } | undefined
  const starts: { computer: string; runId: string }[] = []
  const startRequests: Extract<CiHostRequest, { operation: 'start' }>[] = []
  const oldReads: string[] = []
  const cancels: string[] = []
  const endpoint: HostCiEndpoint = {
    computers: async () => computers,
    request: async (computer, request) => {
      const old = computer.key === original.key
      if (old && offline) throw new DeviceApplicationError('transport')
      if (request.operation === 'status') {
        const runId = old ? statusExecutionId : undefined
        const state = statusState
        if (old && heldStatus) {
          const pending = heldStatus
          heldStatus = undefined
          pending.entered.resolve()
          await pending.reply.promise
        }
        return { operation: 'status', ready: old || replacementReady, reasons: [], cpuCount: 8,
          memoryBytes: 16 * 2 ** 30, slotsTotal: 1, slotsUsed: 0,
          runs: runId ? [{ runId, state, step: 'integration', startedAt: at,
            finishedAt: ['passed', 'failed'].includes(state) ? new Date().toISOString() : null,
            exitCode: ['passed', 'failed'].includes(state) ? Number(state === 'failed') : null,
            logBytes: 0, message: null }] : [] }
      }
      if (request.operation === 'start') {
        starts.push({ computer: computer.key, runId: request.runId })
        startRequests.push(request)
      }
      if (request.operation === 'cancel') cancels.push(request.runId)
      if (!old && request.operation === 'read' && replacementReadFailure) {
        throw new DeviceApplicationError(replacementReadFailure)
      }
      if (old && request.operation === 'read') {
        oldReads.push(request.runId)
        if (readFailure) throw new DeviceApplicationError(readFailure)
        if (heldRead) {
          const pending = heldRead
          heldRead = undefined
          pending.entered.resolve()
          await pending.reply.promise
        }
      }
      const terminal = old ? cleanup !== 'running' : finished
      const run: CiHostRun = { runId: request.runId, state: terminal ? 'passed' : 'running',
        step: 'integration', startedAt: at, finishedAt: terminal ? new Date().toISOString() : null,
        exitCode: terminal ? 0 : null, message: null, logBytes: 0,
        ...(old && cleanup === 'pending' ? { executorCleanupPending: true } : {}) }
      if (request.operation === 'cancel') return { operation: 'cancel', run }
      if (request.operation === 'start') return { operation: 'start', run }
      return { operation: 'read', run, text: old ? 'abandoned output' : 'replacement output', nextOffset: 0,
        ...(request.testResults && terminal ? { testResults: {
          summary: { passed: 1, failed: 0, skipped: 0 }, truncated: false,
          files: [{ file: selectedFile, status: 'passed', durationMs: 189_000,
            tests: [{ name: old ? 'abandoned result' : 'replacement result', status: 'passed', durationMs: 189_000 }] }],
        } } : {}) }
    },
  }
  const commands = new PostgresCommandCoordinator(pool)
  const create = () => new HostCiService(pool, commands, new RunCiAuthority(pool), {} as CiCommits, endpoint)
  let ci = create()
  const access = new PostgresAccessService(pool)
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, ci } as unknown as OperatorServices } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  const connect = async (allowedWorkspace: string) => {
    const issued = await access.issue({ name: 'CI reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 86_400_000),
      grants: [{ actions: CI_GET_ACTIONS, scope: { workspaceIds: [allowedWorkspace] } }] })
    const client = new Client({ name: 'ci-recovery-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      requestInit: { headers: { authorization: `Bearer ${issued.token}` } },
    }))
    return client
  }
  const operator = await connect(workspaceId)
  const denied = await connect(randomUUID())
  const input = { name: 'ci_get', arguments: { workspaceId, ticketId: record.id, testStatus: ['passed'] } }
  return { record, original, replacement, starts, startRequests, durations, oldReads, cancels, insert,
    setOffline(value: boolean) { offline = value },
    finish() { finished = true },
    setCleanup(value: typeof cleanup) { cleanup = value },
    setReplacementReady(value: boolean) { replacementReady = value },
    setReadFailure(value: string | undefined) { readFailure = value },
    setReplacementReadFailure(value: string | undefined) { replacementReadFailure = value },
    setStatusExecution(value: string | undefined, state: CiHostRun['state'] = 'running') {
      statusExecutionId = value
      statusState = state
    },
    holdOldStatus() {
      const pending = { entered: deferred<void>(), reply: deferred<void>() }
      heldStatus = pending
      return pending
    },
    holdOldRead() {
      const pending = { entered: deferred<void>(), reply: deferred<void>() }
      heldRead = pending
      return pending
    },
    anotherDispatcher: create,
    dispatch: async () => { await ci.dispatch(); await ci.drain() },
    dispatchUntilStarts: async (count: number, dispatcher = ci) => {
      // Cleanup can invalidate a queued claim; synchronize on Start rather than counting dispatch passes.
      await vi.waitFor(async () => {
        await dispatcher.dispatch()
        await dispatcher.drain()
        expect(starts).toHaveLength(count)
      })
    },
    restart: async () => { await ci.close(); ci = create() },
    read: async () => CiGetOutputSchema.parse(decodeMcpToolResult(await operator.callTool(input))),
    listComputers: async () => CiComputersOutputSchema.parse(decodeMcpToolResult(await operator.callTool({
      name: 'ci_computers_list', arguments: { workspaceId },
    }))),
    denied: async () => (await denied.callTool(input)).isError,
    stored: async () => (await pool.query('select record from ci_runs where id=$1', [record.id])).rows[0]!.record,
    diagnostic: async () => ({ run: (await pool.query('select record from ci_runs where id=$1', [record.id])).rows[0]!.record,
      services: readServiceHealth() }),
    close: async () => { await ci.close(); await Promise.all(clients.map(client => client.close())); await app.close() },
  }
}

it.each([
  { state: 'running' as const, expected: 189_000, threshold: 378_000 },
  { state: 'starting' as const, expected: 189_000, threshold: 378_000 },
  { state: 'running' as const, expected: 10_000, threshold: 300_000 },
  { state: 'running' as const, expected: 1_800_000, threshold: 900_000 },
  { state: 'running' as const, expected: 189_000, threshold: 378_000, gate: true },
])('finishes an unobservable $state selection elsewhere after $threshold ms, gate=$gate', async ({ state, expected, threshold, gate }) => {
  const f = await fixture({ state, expectedDurationMs: expected, gate: gate ?? false })
  const started = Date.now()
  try {
    await f.dispatch()
    vi.setSystemTime(started + threshold - 1)
    await f.dispatch()
    expect((await f.read()).run).toMatchObject({ state, computer: { hostRef: f.original.hostRef } })
    expect(f.starts).toEqual([])
    // The observation backoff stays at one minute; recovery happens on the next eligible observation.
    vi.setSystemTime(started + threshold + 60_000)
    await f.dispatchUntilStarts(1)
    expect(f.starts, JSON.stringify(await f.diagnostic())).toHaveLength(1)
    const attempt = f.starts[0]!
    expect(attempt.computer).toBe(f.replacement.key)
    expect(attempt.runId).not.toBe(f.record.id)
    expect(f.startRequests[0]!.durations).toEqual(f.durations)
    expect(f.startRequests[0]!.partition ?? null).toEqual(f.record.partition)
    if (gate) expect(f.startRequests[0]!.files).toEqual(f.record.files)
    const running = (await f.read()).run
    expect(running).toMatchObject({ id: f.record.id, groupId: f.record.groupId, state: 'running',
      files: f.record.files, partition: f.record.partition, executionRunId: attempt.runId,
      retainedExecutions: [{ runId: f.record.id, hostKey: f.original.key, executor: 'retained' }] })
    expect(await f.denied()).toBe(true)
    await f.restart()
    vi.setSystemTime(Date.now() + 189_000)
    f.finish()
    await f.dispatch()
    const complete = await f.read()
    expect(complete).toMatchObject({ group: { state: 'passed' }, run: { state: 'passed', collection: 'complete' },
      tests: { files: [{ tests: [{ name: 'replacement result' }] }] } })
    expect(complete.run).toEqual(await f.stored())
    expect(Date.now() - started).toBeLessThan(20 * 60_000)
    // Even a ready status claiming zero usage cannot release the abandoned executor's slot.
    f.setOffline(false)
    f.setReplacementReady(false)
    const queued = CiRunRecordSchema.parse({ ...f.record, id: randomUUID(), groupId: randomUUID(), gate: false,
      files: [], integrationShards: undefined,
      state: 'queued', computer: null, startedAt: null, dispatchedAt: undefined, plannedHostKey: undefined })
    await f.insert(queued)
    vi.setSystemTime(Date.now() + 60_000)
    await f.dispatch()
    expect(f.starts, JSON.stringify(await f.diagnostic())).toHaveLength(1)
    f.setCleanup('pending')
    vi.setSystemTime(Date.now() + 60_000)
    await f.dispatch()
    expect(f.starts, JSON.stringify(await f.diagnostic())).toHaveLength(1)
    expect((await f.read()).run).toMatchObject({ state: 'passed',
      retainedExecutions: [{ executor: 'retained' }] })
    f.setCleanup('stopped')
    vi.setSystemTime(Date.now() + 60_000)
    await f.dispatchUntilStarts(2)
    expect(f.starts).toHaveLength(2)
    expect(f.starts[1]).toEqual({ computer: f.original.key, runId: queued.id })
    expect(f.cancels).toContain(f.record.id)
    expect(f.oldReads).not.toContain(f.record.id)
    const preserved = await f.read()
    expect(preserved).toMatchObject({ run: { state: 'passed', executionRunId: attempt.runId,
      retainedExecutions: [{ executor: 'released' }] },
      tests: { files: [{ tests: [{ name: 'replacement result' }] }] } })
    expect(preserved.logTail).not.toContain('abandoned output')
    expect(preserved.run).toEqual(await f.stored())
  } finally { await f.close() }
})

it('keeps a slow observable executor and restarts the outage clock after it answers', async () => {
  const f = await fixture()
  const started = Date.now()
  try {
    f.setOffline(false)
    await f.dispatch()
    vi.setSystemTime(started + 30 * 60_000)
    await f.dispatch()
    expect((await f.read()).run).toMatchObject({ state: 'running', computer: { hostRef: f.original.hostRef } })
    f.setOffline(true)
    await f.dispatch()
    vi.setSystemTime(Date.now() + 300_000)
    f.setOffline(false)
    await f.dispatch()
    f.setOffline(true)
    await f.dispatch()
    vi.setSystemTime(Date.now() + 300_000)
    await f.dispatch()
    expect((await f.read()).run).toMatchObject({ state: 'running', computer: { hostRef: f.original.hostRef } })
    expect(f.starts).toEqual([])
  } finally { await f.close() }
})

it('keeps application observation failures on their assigned executor', async () => {
  const f = await fixture()
  try {
    f.setOffline(false)
    f.setReadFailure('CI_HOST_REPLY_INVALID')
    await f.dispatch()
    vi.setSystemTime(Date.now() + 30 * 60_000)
    await f.dispatch()
    expect((await f.read()).run).toMatchObject({ state: 'running', computer: { hostRef: f.original.hostRef } })
    expect(f.starts).toEqual([])
  } finally { await f.close() }
})

it('rejects an abandoned result arriving after another dispatcher completes the replacement', async () => {
  const f = await fixture()
  const other = f.anotherDispatcher()
  let pending: ReturnType<typeof f.holdOldRead> | undefined
  let observing: Promise<void> | undefined
  try {
    await f.dispatch()
    vi.setSystemTime(Date.now() + 438_000)
    f.setOffline(false)
    pending = f.holdOldRead()
    observing = f.dispatch()
    await pending.entered.promise
    f.setOffline(true)
    await f.dispatchUntilStarts(1, other)
    expect(f.starts, JSON.stringify(await f.diagnostic())).toHaveLength(1)
    expect(f.starts[0]!.runId).not.toBe(f.record.id)
    f.finish()
    await other.dispatch()
    await other.drain()
    expect((await f.read()).run).toMatchObject({ state: 'passed', collection: 'complete' })
    f.setCleanup('stopped')
    f.setOffline(false)
    pending.reply.resolve()
    await observing
    const completed = await f.read()
    expect(completed).toMatchObject({ run: { state: 'passed', executionRunId: f.starts[0]!.runId },
      tests: { files: [{ tests: [{ name: 'replacement result' }] }] } })
    expect(completed.logTail).not.toContain('abandoned output')
    expect(completed.run).toEqual(await f.stored())
  } finally {
    pending?.reply.resolve()
    await observing
    await other.close()
    await f.close()
  }
})

it('keeps work on an executor that reports the matching execution while log reads time out', async () => {
  const executionRunId = randomUUID()
  const f = await fixture({ executionRunId })
  const started = Date.now()
  try {
    await f.dispatch()
    const unavailableSince = (await f.read()).run.observation!.transportUnavailableSince
    expect(unavailableSince).toBeDefined()
    f.setOffline(false)
    f.setReadFailure('timeout')
    f.setStatusExecution(executionRunId)
    vi.setSystemTime(started + 300_000)
    await f.dispatch()
    expect((await f.read()).run.observation!.transportUnavailableSince).not.toBe(unavailableSince)
    vi.setSystemTime(started + 600_000)
    await f.dispatch()
    expect((await f.read()).run).toMatchObject({ state: 'running', executionRunId,
      computer: { hostRef: f.original.hostRef } })
    expect(f.starts).toEqual([])
    expect(f.cancels).toEqual([])
  } finally { await f.close() }
})

it('records a matching planning status before caching it and deciding whether to reroute', async () => {
  const executionRunId = randomUUID()
  const f = await fixture({ executionRunId })
  try {
    await f.dispatch()
    const unavailableSince = (await f.read()).run.observation!.transportUnavailableSince
    expect(unavailableSince).toBeDefined()
    f.setOffline(false)
    f.setReadFailure('timeout')
    f.setStatusExecution(executionRunId)
    vi.setSystemTime(Date.now() + 438_000)
    const fleet = await f.listComputers()
    expect(fleet.computers.find(computer => computer.hostRef.deviceId === f.original.hostRef.deviceId))
      .toMatchObject({ ready: true, running: [f.record.id] })
    const observed = (await f.read()).run
    expect(observed.observation!.transportUnavailableSince).not.toBe(unavailableSince)
    expect(observed).toEqual(await f.stored())
    await f.dispatch()
    expect((await f.read()).run).toMatchObject({ state: 'running', executionRunId,
      computer: { hostRef: f.original.hostRef } })
    expect(f.starts).toEqual([])
    expect(f.cancels).toEqual([])
  } finally { await f.close() }
})

it.each(['passed', 'failed'] as const)(
  'resets the outage for a matching %s status while leaving outcome collection to run reads', async state => {
    const executionRunId = randomUUID()
    const f = await fixture({ executionRunId })
    const started = Date.now()
    try {
      await f.dispatch()
      const unavailableSince = (await f.read()).run.observation!.transportUnavailableSince
      expect(unavailableSince).toBeDefined()
      f.setOffline(false)
      f.setReadFailure('timeout')
      f.setStatusExecution(executionRunId, state)
      vi.setSystemTime(started + 300_000)
      await f.dispatch()
      const observed = (await f.read()).run
      expect(observed.observation!.transportUnavailableSince).not.toBe(unavailableSince)
      expect(observed).toMatchObject({ state: 'running', executionRunId, exitCode: null, finishedAt: null })
      expect(observed.collection).toBeUndefined()
      expect(observed).toEqual(await f.stored())
      vi.setSystemTime(started + 600_000)
      await f.dispatch()
      expect((await f.read()).run).toMatchObject({ state: 'running', executionRunId,
        computer: { hostRef: f.original.hostRef }, exitCode: null, finishedAt: null })
      expect(f.starts).toEqual([])
      expect(f.cancels).toEqual([])
    } finally { await f.close() }
  })

it('reroutes when status names the ticket but does not observe its active execution', async () => {
  const f = await fixture({ executionRunId: randomUUID() })
  try {
    await f.dispatch()
    f.setOffline(false)
    f.setReadFailure('timeout')
    f.setStatusExecution(f.record.id)
    vi.setSystemTime(Date.now() + 438_000)
    await f.dispatchUntilStarts(1)
    expect(f.starts).toHaveLength(1)
    expect(f.starts[0]!.computer).toBe(f.replacement.key)
    expect((await f.read()).run).toMatchObject({ state: 'running',
      executionRunId: f.starts[0]!.runId, computer: { hostRef: f.replacement.hostRef } })
  } finally { await f.close() }
})

it('does not apply a delayed status from an abandoned execution to its replacement', async () => {
  const executionRunId = randomUUID()
  const f = await fixture({ executionRunId })
  const other = f.anotherDispatcher()
  let pending: ReturnType<typeof f.holdOldStatus> | undefined
  let observing: ReturnType<typeof f.listComputers> | undefined
  try {
    await f.dispatch()
    f.setOffline(false)
    f.setReadFailure('timeout')
    f.setStatusExecution(executionRunId)
    vi.setSystemTime(Date.now() + 438_000)
    pending = f.holdOldStatus()
    // Hold only the live status read; a dispatch also starts a competing observation of the ticket.
    observing = f.listComputers()
    await pending.entered.promise
    f.setStatusExecution(undefined)
    await f.dispatchUntilStarts(1, other)
    expect(f.starts).toHaveLength(1)
    const replacementId = f.starts[0]!.runId
    f.setReplacementReadFailure('timeout')
    await other.dispatch()
    await other.drain()
    const outage = (await f.read()).run.observation!.transportUnavailableSince
    expect(outage).toBeDefined()
    pending.reply.resolve()
    await observing
    expect((await f.read()).run).toMatchObject({ state: 'running', executionRunId: replacementId,
      observation: { transportUnavailableSince: outage } })
  } finally {
    pending?.reply.resolve()
    await observing
    await other.close()
    await f.close()
  }
})
