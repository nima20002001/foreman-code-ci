import { randomUUID } from 'node:crypto'
import { CiGetOutputSchema, CiRunRecordSchema, type CiHostReply, type CiHostRun,
  type CiTestResults } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { afterEach, expect, it, vi } from 'vitest'
import { DeviceApplicationAdmissionError } from '../src/modules/devices/deviceApplicationError.js'
import { CI_GET_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { DomainError } from '../src/modules/errors.js'
import { fixture } from './helpers/hostCiMcpFixture.js'

/** Dispatch passes hand observations and follow-up passes to background work; settle waits for all of it. */
async function settle(service: { dispatch(): Promise<void>; drain(): Promise<void> }) {
  await service.dispatch()
  await service.drain()
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

type CollectionReply = 'backpressure' | 'pending' | 'partial' | 'complete' | 'unsupported'
const results: CiTestResults = { summary: { passed: 0, failed: 1, skipped: 0 }, truncated: false,
  files: [{ file: 'apps/api/src/example.test.ts', status: 'failed', durationMs: 10,
    tests: [{ name: 'returns the expected result', status: 'failed', durationMs: 10 }] }] }

async function collectionFixture(mode: CollectionReply, initialState: 'running' | 'failed' = 'failed') {
  const f = await fixture()
  const computer = f.computers[0]!
  const lastSuccessAt = new Date(Date.now() - 10_000).toISOString()
  const finishedAt = new Date().toISOString()
  const record = CiRunRecordSchema.parse({ id: randomUUID(), groupId: randomUUID(), workspaceId: f.workspaceId,
    suite: 'unit', scope: 'full', files: [], part: null, partition: null, repository: 'fixture/project',
    commit: 'a'.repeat(40), state: initialState, computer: { hostRef: computer.hostRef, label: computer.label },
    step: 'unit', exitCode: initialState === 'failed' ? 1 : null, message: 'Test failure',
    queuedAt: lastSuccessAt, startedAt: lastSuccessAt, finishedAt: initialState === 'failed' ? finishedAt : null,
    initiator: { principalId: 'operator', executionId: null }, collection: 'pending',
    observation: { status: 'available', lastSuccessAt, consecutiveFailures: 0, lastError: null, nextAttemptAt: null } })
  await f.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,host_key,record,log_tail)
    values($1,$2,$3,$4,$5,$6::jsonb,$7)`, [record.id, record.workspaceId, record.groupId, record.state,
    initialState === 'running' ? computer.key : null, JSON.stringify(record), 'saved output'])
  let reads = 0
  let collectionReads = 0
  let remoteState: CiHostRun['state'] = 'failed'
  let tailUnavailable = false
  const request = f.endpoint.request.bind(f.endpoint)
  vi.spyOn(f.endpoint, 'request').mockImplementation(async (host, input, options): Promise<CiHostReply> => {
    if (input.operation !== 'read') return request(host, input, options)
    reads++
    const run: CiHostRun = { runId: record.id, state: remoteState, step: 'unit',
      startedAt: lastSuccessAt, finishedAt, exitCode: remoteState === 'failed' ? 1 : 0,
      message: 'Test failure', logBytes: tailUnavailable ? 40_000 : 12 }
    if (input.afterOffset > 0 && tailUnavailable) {
      throw new DomainError('CI_LOG_UNAVAILABLE', 'Log tail unavailable', 503)
    }
    if (!input.testResults) return { operation: 'read', run, text: 'fresh output', nextOffset: 12 }
    collectionReads++
    if (mode === 'backpressure') throw new DeviceApplicationAdmissionError('background_yield')
    const collection = mode === 'partial' ? 'pending' : mode
    return { operation: 'read', run: { ...run, collection }, text: '', nextOffset: 0,
      ...(['complete', 'partial'].includes(mode) ? { testResults: results } : {}) }
  })
  const read = async () => {
    const response = await f.operator.callTool({ name: 'ci_get',
      arguments: { workspaceId: f.workspaceId, ticketId: record.id, testStatus: ['failed'] } })
    expect(response.isError).not.toBe(true)
    return CiGetOutputSchema.parse(decodeMcpToolResult(response))
  }
  return { ...f, record, lastSuccessAt, finishedAt, read, counts: () => ({ reads, collectionReads }),
    mode: (value: CollectionReply) => { mode = value }, remoteState: (value: CiHostRun['state']) => { remoteState = value },
    tailUnavailable: (value: boolean) => { tailUnavailable = value } }
}

it.each(['backpressure', 'pending', 'partial'] as const)(
  'backs off terminal %s collection across dispatches and recovers through authenticated MCP', async mode => {
    const f = await collectionFixture(mode)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      for (const [index, delay] of [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000].entries()) {
        const attemptedAt = Date.now()
        await settle(f.ci)
        const output = await f.read()
        expect(output.run).toMatchObject({ state: 'failed', exitCode: 1, finishedAt: f.finishedAt,
          collection: 'pending', observation: { status: 'unavailable', lastSuccessAt: f.lastSuccessAt,
            consecutiveFailures: index + 1, nextAttemptAt: new Date(attemptedAt + delay).toISOString(),
            lastError: expect.stringContaining(mode === 'backpressure' ? 'backpressure' : 'CI_COLLECTION_PENDING') } })
        expect(f.counts().collectionReads).toBe(index + 1)
        const counts = f.counts()
        vi.setSystemTime(attemptedAt + delay - 1)
        await settle(f.ci)
        expect(f.counts()).toEqual(counts)
        vi.setSystemTime(attemptedAt + delay)
      }
      f.mode('complete')
      await settle(f.ci)
      expect(await f.read()).toMatchObject({ run: { state: 'failed', collection: 'complete',
        observation: { status: 'available', consecutiveFailures: 0, lastError: null,
          lastSuccessAt: new Date().toISOString(), nextAttemptAt: null } }, tests: results })
      const stored = (await f.pool.query('select record,test_results from ci_runs where id=$1', [f.record.id])).rows[0]!
      expect(stored.record).toEqual((await f.read()).run)
      expect(stored.test_results).toEqual(results)
      const counts = f.counts()
      vi.setSystemTime(Date.now() + 60_000)
      await settle(f.ci)
      expect(f.counts()).toEqual(counts)
      const denied = await f.connect(['workflows:read'])
      expect((await f.call(denied, 'ci_get', { ticketId: f.record.id })).isError).toBe(true)
      const reader = await f.connect(CI_GET_ACTIONS)
      expect(CiGetOutputSchema.parse(await f.value(reader, 'ci_get', { ticketId: f.record.id })).run)
        .toMatchObject({ collection: 'complete', observation: { consecutiveFailures: 0 } })
    } finally { await f.close() }
  })

it('does not observe a ticket again from a stale read of the active runs while its backoff is pending', async () => {
  const f = await collectionFixture('pending')
  vi.useFakeTimers({ toFake: ['Date'] })
  // The dispatcher reads active runs as { id, record, host_key } rows.
  const activeRows = (rows: unknown[]) => rows.filter(row => typeof row === 'object' && row !== null
    && ['id', 'record', 'host_key'].every(key => key in row) && Object.keys(row).length === 3
    && (row as { id: string }).id === f.record.id)
  let beforeObservation: unknown[] | undefined
  let replay = false
  const query = f.pool.query.bind(f.pool) as (...args: unknown[]) => Promise<{ rows: unknown[] }>
  vi.spyOn(f.pool, 'query').mockImplementation((async (...args: unknown[]) => {
    const result = await query(...args)
    const rows = activeRows(result.rows)
    if (!rows.length) return result
    beforeObservation ??= rows
    // A pass whose read of the active runs predates a finished observation sees the older record.
    return replay ? { ...result, rows: beforeObservation } : result
  }) as never)
  try {
    await settle(f.ci)
    expect(f.counts().collectionReads).toBe(1)
    replay = true
    await settle(f.ci)
    expect(f.counts().collectionReads).toBe(1)
    expect((await f.read()).run.observation).toMatchObject({ status: 'unavailable', consecutiveFailures: 1 })
  } finally { await f.close() }
})

it('persists newly finished facts when collection fails and preserves that outcome on retry', async () => {
  const f = await collectionFixture('backpressure', 'running')
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    await settle(f.ci)
    expect(await f.read()).toMatchObject({ run: { state: 'failed', exitCode: 1, finishedAt: f.finishedAt,
      collection: 'pending', observation: { status: 'unavailable', consecutiveFailures: 1,
        lastSuccessAt: f.lastSuccessAt } }, logTail: 'fresh output' })
    f.remoteState('passed')
    vi.setSystemTime(Date.now() + 1000)
    await settle(f.ci)
    expect(await f.read()).toMatchObject({ run: { state: 'failed', exitCode: 1, finishedAt: f.finishedAt,
      observation: { status: 'unavailable', consecutiveFailures: 2, lastSuccessAt: f.lastSuccessAt } } })
  } finally { await f.close() }
})

it('finishes unsupported collection without scheduling another observation', async () => {
  const f = await collectionFixture('unsupported')
  try {
    await settle(f.ci)
    expect(await f.read()).toMatchObject({ run: { state: 'failed', collection: 'unsupported',
      observation: { status: 'available', consecutiveFailures: 0, nextAttemptAt: null } } })
    const counts = f.counts()
    await settle(f.ci)
    expect(f.counts()).toEqual(counts)
  } finally { await f.close() }
})

it('recovers a terminal log observation after collection completes and then stops polling', async () => {
  const f = await collectionFixture('complete', 'running')
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    f.tailUnavailable(true)
    await settle(f.ci)
    expect(await f.read()).toMatchObject({ run: { state: 'failed', exitCode: 1, finishedAt: f.finishedAt,
      collection: 'complete', observation: { status: 'unavailable', consecutiveFailures: 1 } } })
    f.tailUnavailable(false)
    f.remoteState('passed')
    vi.setSystemTime(Date.now() + 1000)
    await settle(f.ci)
    const recovered = await f.read()
    expect(recovered).toMatchObject({ run: { state: 'failed', exitCode: 1, finishedAt: f.finishedAt,
      collection: 'complete', observation: { status: 'available', consecutiveFailures: 0, nextAttemptAt: null } },
      logTail: 'fresh output', tests: results })
    const stored = (await f.pool.query('select record from ci_runs where id=$1', [f.record.id])).rows[0]!
    expect(stored.record).toEqual(recovered.run)
    const counts = f.counts()
    vi.setSystemTime(Date.now() + 60_000)
    await settle(f.ci)
    expect(f.counts()).toEqual(counts)
    const denied = await f.connect(['workflows:read'])
    expect((await f.call(denied, 'ci_get', { ticketId: f.record.id })).isError).toBe(true)
  } finally { await f.close() }
})

it('settles a canceled part at once without collecting results, so its gate group is terminal', async () => {
  const f = await collectionFixture('pending', 'running')
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    f.remoteState('canceled')
    await settle(f.ci)
    const output = await f.read()
    expect(output.run).toMatchObject({ state: 'canceled', collection: 'unsupported',
      observation: { status: 'available', consecutiveFailures: 0, nextAttemptAt: null } })
    const waited = CiGetOutputSchema.parse(decodeMcpToolResult(await f.operator.callTool({ name: 'ci_get',
      arguments: { workspaceId: f.workspaceId, ticketId: f.record.id, waitUntil: 'group-terminal', logTail: false } })))
    expect(waited.wait).toMatchObject({ status: 'settled', tickets: 1, settledTickets: 1 })
    const counts = f.counts()
    vi.setSystemTime(Date.now() + 120_000)
    await settle(f.ci)
    expect(f.counts()).toEqual(counts)
  } finally { await f.close() }
})
