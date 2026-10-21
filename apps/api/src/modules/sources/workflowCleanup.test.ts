import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { SourceMaterializationRecordSchema } from '@foreman-code/contracts/source-admission'
import { RetainedSourceFootprintSchema } from '@foreman-code/contracts/source-operations'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { readUnboundWorkflowClosure, readWorkflowClosure } from '../interactions/workflowClosure.js'
import { hasRetainedRemoteReviewerSource, readRetainedRemoteReviewer } from '../interactions/retainedRemoteReviewer.js'
import { closeCompletedWorkflowSources, localWorkflowSourceClosed } from './workflowCleanup.js'
import { PostgresSourceService } from './service.js'
import { withSourceOperationExclusion } from './sourceOperationExclusion.js'
import { deferred } from '../../../test/helpers/deferred.js'
import { DomainError, databaseReadFailure } from '../errors.js'
import { DeviceApplicationError } from '../devices/deviceApplicationError.js'

vi.mock('../interactions/workflowClosure.js', () => ({
  readWorkflowClosure: vi.fn(),
  readUnboundWorkflowClosure: vi.fn(),
}))
vi.mock('../interactions/retainedRemoteReviewer.js', () => ({
  readRetainedRemoteReviewer: vi.fn(), hasRetainedRemoteReviewerSource: vi.fn(),
}))
beforeEach(() => vi.resetAllMocks())
afterEach(() => vi.useRealTimers())

function fixture(bound: boolean, state: 'completed' | 'starting' = 'completed') {
  const execution = HarnessExecutionSchema.parse({
    id: 'execution', runId: 'run', workflowNodeId: 'node', agentId: 'agent',
    agentConfigurationVersionId: 'configuration', attempt: 1,
    workingDirectory: '/private/source/tree', runtimeDirectory: '/private/runtime',
    input: {}, state, createdAt: '2026-10-04T00:00:00Z',
    ...(bound ? { nativeSessionId: 'native-session' } : {}),
    ...(state === 'completed' ? {
      result: { outcome: 'canceled' }, finishedAt: '2026-10-04T00:01:00Z',
    } : {}),
  })
  const sql = { query: vi.fn(async () => ({ rows: [{ record: execution }] })) } as unknown as GraphSqlClient
  return { execution, sql }
}

it.each([true, false])('requires stored physical closure when a completed execution is bound=%s', async bound => {
  const f = fixture(bound)
  expect(await localWorkflowSourceClosed(f.sql, f.execution.id)).toBe(false)
  const read = bound ? vi.mocked(readWorkflowClosure) : vi.mocked(readUnboundWorkflowClosure)
  expect(read).toHaveBeenCalledWith(f.sql, f.execution)
  if (bound) {
    vi.mocked(readWorkflowClosure).mockResolvedValue({
      execution: f.execution, durableGeneration: '1',
      session: { harness: 'codex', nativeSessionId: 'native-session', providerVersion: '0.154.0' },
    } as NonNullable<Awaited<ReturnType<typeof readWorkflowClosure>>>)
  } else {
    vi.mocked(readUnboundWorkflowClosure).mockResolvedValue({
      execution: f.execution, durableGeneration: '1',
    } as NonNullable<Awaited<ReturnType<typeof readUnboundWorkflowClosure>>>)
  }
  expect(await localWorkflowSourceClosed(f.sql, f.execution.id)).toBe(true)
})

it('keeps a live execution claim even if a previous lifetime has closure evidence', async () => {
  const f = fixture(false, 'starting')
  expect(await localWorkflowSourceClosed(f.sql, f.execution.id)).toBe(false)
  expect(readUnboundWorkflowClosure).not.toHaveBeenCalled()
  expect(readWorkflowClosure).not.toHaveBeenCalled()
})

it('keeps the claim when execution identity or closure lookup cannot be confirmed', async () => {
  const f = fixture(true)
  expect(await localWorkflowSourceClosed(f.sql, 'another-execution')).toBe(false)
  vi.mocked(readWorkflowClosure).mockRejectedValue(new Error('closure database unavailable'))
  await expect(localWorkflowSourceClosed(f.sql, f.execution.id)).rejects.toThrow('closure database unavailable')
})

function remoteSourceFixture() {
  const execution = HarnessExecutionSchema.parse({ ...fixture(true).execution, result: { outcome: 'succeeded' } })
  const hash = 'a'.repeat(64)
  const filesystem = { device: '1', inode: '2', mountId: '3' }
  const record = SourceMaterializationRecordSchema.parse({
    receipt: { version: 1, materializationId: randomUUID(), executionId: execution.id, attemptId: randomUUID(),
      placementHash: hash, keyRevision: 1, authorizationRevision: 1,
      binding: { version: 1, mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
        workspaceId: 'workspace', rootId: randomUUID(), bindingRevision: 1, locationRevision: 1,
        canonicalPath: '/original/source', filesystem, accessMode: 'read-only', snapshotId: randomUUID(), manifestDigest: hash },
      verifiedManifestDigest: hash, verifiedEntries: 1, verifiedBytes: 4,
      verifiedAt: '2026-10-04T00:00:00Z', localTreeIdentity: filesystem },
    rootPolicyId: randomUUID(), rootPolicyRevision: '1', operationId: randomUUID(), reservationId: randomUUID(),
    sourceBindingHash: hash, finalDispatchBindingHash: hash, state: 'prepared',
  })
  const settlement = { pending: false }
  const pool = { query: async () => ({ rows: [{ materialization_id: record.receipt.materializationId,
    record, execution, settlement_pending: settlement.pending }] }) } as unknown as Pick<pg.Pool, 'query'>
  const sources = { confirmClosed: vi.fn(async () => undefined) }
  const report = vi.fn()
  return { pool, sources, report, record, execution, settlement }
}

it('leaves a sessionless interrupted copy for physical reservation reclamation', async () => {
  const f = remoteSourceFixture()
  delete f.execution.nativeSessionId
  f.execution.result = { outcome: 'failed',
    error: { code: 'EXECUTION_INTERRUPTED', message: 'Owner restarted', retryable: false } }
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  expect(f.sources.confirmClosed).not.toHaveBeenCalled()
  expect(hasRetainedRemoteReviewerSource).not.toHaveBeenCalled()
  expect(f.report).not.toHaveBeenCalled()
})

it('retains the source claim for a verified original reviewer, then requires physical closure after retention ends', async () => {
  const f = remoteSourceFixture()
  vi.mocked(hasRetainedRemoteReviewerSource).mockResolvedValue(true)
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  expect(f.sources.confirmClosed).not.toHaveBeenCalled()
  expect(f.report).not.toHaveBeenCalled()
  vi.mocked(hasRetainedRemoteReviewerSource).mockResolvedValue(false)
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  expect(f.sources.confirmClosed).toHaveBeenCalledWith(f.record)
})

it('keeps the original source when Main retention authority expires before physical closure', async () => {
  const f = remoteSourceFixture()
  vi.mocked(hasRetainedRemoteReviewerSource).mockResolvedValue(true)
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  expect(f.sources.confirmClosed).not.toHaveBeenCalled()
  expect(f.report).not.toHaveBeenCalled()
  vi.mocked(hasRetainedRemoteReviewerSource).mockResolvedValue(false)
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  expect(f.sources.confirmClosed).toHaveBeenCalledWith(f.record)
})

it('reconciles source ownership after reviewer credentials are revoked without requiring review access', async () => {
  const f = remoteSourceFixture()
  vi.mocked(readRetainedRemoteReviewer).mockRejectedValue(new Error('The original reviewer process lease is required'))
  vi.mocked(hasRetainedRemoteReviewerSource).mockResolvedValue(true)
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  expect(f.sources.confirmClosed).not.toHaveBeenCalled()
  expect(f.report).not.toHaveBeenCalled()
  expect(readRetainedRemoteReviewer).not.toHaveBeenCalled()
  vi.mocked(hasRetainedRemoteReviewerSource).mockResolvedValue(false)
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  expect(f.sources.confirmClosed).toHaveBeenCalledWith(f.record)
  expect(f.report).not.toHaveBeenCalled()
})

it('reports closure uncertainty when no verified retained reviewer owns the source', async () => {
  const f = remoteSourceFixture()
  const uncertainty = new Error('Original source closure is unconfirmed')
  f.sources.confirmClosed.mockRejectedValue(uncertainty)
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  expect(f.sources.confirmClosed).toHaveBeenCalledWith(f.record)
  expect(f.report).toHaveBeenCalledWith(uncertainty)
})

it('retries a closure check that timed out behind a busy Run on a later pass instead of reporting it', async () => {
  const f = remoteSourceFixture()
  const timeout = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
  f.sources.confirmClosed.mockRejectedValue(databaseReadFailure(timeout))
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  expect(f.sources.confirmClosed).toHaveBeenCalledOnce()
  expect(f.report).not.toHaveBeenCalled()
})

it('defers unconfirmed physical closure without releasing the original source claim', async () => {
  const f = remoteSourceFixture()
  const releaseClaim = vi.fn(async () => ({ retainedBytes: 0 }))
  const confirmedClosed = vi.fn(async () => false)
  const dependencies = [f.pool, {}, {}, {}, f.record.receipt.binding.mainId, {}, { releaseClaim },
    { confirmedClosed }] as unknown as ConstructorParameters<typeof PostgresSourceService>
  const sources = new PostgresSourceService(...dependencies)
  await expect(sources.confirmClosed(f.record)).rejects.toMatchObject({ code: 'SOURCE_EXECUTION_UNCERTAIN' })
  vi.mocked(hasRetainedRemoteReviewerSource).mockResolvedValue(true)
  await closeCompletedWorkflowSources(f.pool, sources, f.report)
  expect(f.report).not.toHaveBeenCalled()
  expect(releaseClaim).not.toHaveBeenCalled()
  vi.mocked(hasRetainedRemoteReviewerSource).mockResolvedValue(false)
  await closeCompletedWorkflowSources(f.pool, sources, f.report)
  const closureChecks = confirmedClosed.mock.calls.length
  await closeCompletedWorkflowSources(f.pool, sources, f.report)
  await closeCompletedWorkflowSources(f.pool, sources, f.report)
  expect(confirmedClosed).toHaveBeenCalledTimes(closureChecks)
  expect(f.report).not.toHaveBeenCalled()
  expect(releaseClaim).not.toHaveBeenCalled()
})

it('defers a completed Main node while its original native lifetime is still settling', async () => {
  const f = remoteSourceFixture()
  f.record.receipt.binding.deviceId = null
  f.record.receipt.binding.workerInstallationId = null
  f.record.receipt.keyRevision = null
  f.record.receipt.authorizationRevision = null
  f.settlement.pending = true
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  expect(f.sources.confirmClosed).not.toHaveBeenCalled()
  expect(f.report).not.toHaveBeenCalled()
  f.settlement.pending = false
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  expect(f.sources.confirmClosed).toHaveBeenCalledWith(f.record)
})

it.each([true, false])('visits a closed sessionless retained copy with reconciliation record=%s', async preparationClosed => {
  const f = remoteSourceFixture()
  delete f.execution.nativeSessionId
  const pool = { query: async () => ({ rows: [{ materialization_id: f.record.receipt.materializationId,
    record: f.record, execution: f.execution,
    settlement_pending: false, already_closed: true, preparation_closed: preparationClosed }] }) } as unknown as Pick<pg.Pool, 'query'>
  await closeCompletedWorkflowSources(pool, f.sources, f.report)
  expect(f.sources.confirmClosed).toHaveBeenCalledWith(f.record)
  expect(f.report).not.toHaveBeenCalled()
})

it('keeps a sessionless copy when its preparation closure is still uncertain', async () => {
  const f = remoteSourceFixture()
  delete f.execution.nativeSessionId
  const pool = { query: async () => ({ rows: [{ materialization_id: f.record.receipt.materializationId,
    record: f.record, execution: f.execution,
    settlement_pending: false, preparation_closed: false }] }) } as unknown as Pick<pg.Pool, 'query'>
  await closeCompletedWorkflowSources(pool, f.sources, f.report)
  expect(f.sources.confirmClosed).not.toHaveBeenCalled()
  expect(f.report).not.toHaveBeenCalled()
})

function cleanupClock() {
  vi.useFakeTimers({ toFake: ['Date'] })
  let now = Date.parse('2026-10-04T00:02:00Z')
  vi.setSystemTime(now)
  return (milliseconds: number) => {
    now += milliseconds
    vi.setSystemTime(now)
  }
}

it('uses the persisted retry date of a retained worktree without repeating its footprint scan', async () => {
  const advance = cleanupClock()
  const f = remoteSourceFixture()
  const row = { materialization_id: f.record.receipt.materializationId, record: f.record,
    execution: f.execution, settlement_pending: false, already_closed: true,
    worktree_cleanup: { state: 'retained', nextAttemptAt: new Date(Date.now() + 300_000).toISOString() } }
  expect(RetainedSourceFootprintSchema.parse({ retainedBytes: 1024, worktree: row.worktree_cleanup }).worktree)
    .toEqual(row.worktree_cleanup)
  const pool = { query: async () => ({ rows: [row] }) } as unknown as Pick<pg.Pool, 'query'>
  await closeCompletedWorkflowSources(pool, f.sources, f.report)
  expect(f.sources.confirmClosed).not.toHaveBeenCalled()
  advance(300_000)
  await closeCompletedWorkflowSources(pool, f.sources, f.report)
  expect(f.sources.confirmClosed).toHaveBeenCalledOnce()
})

it('cleans up a terminal Run immediately despite its active-Run worktree backoff', async () => {
  const f = remoteSourceFixture()
  const row = { materialization_id: f.record.receipt.materializationId, record: f.record,
    execution: f.execution, settlement_pending: false, already_closed: true, run_terminal: true,
    worktree_cleanup: { state: 'retained', nextAttemptAt: new Date(Date.now() + 300_000).toISOString() } }
  const pool = { query: async () => ({ rows: [row] }) } as unknown as Pick<pg.Pool, 'query'>
  await closeCompletedWorkflowSources(pool, f.sources, f.report)
  expect(f.sources.confirmClosed).toHaveBeenCalledWith(f.record)
  expect(f.report).not.toHaveBeenCalled()
})

it('honors the renewed cleanup backoff when a terminal Run retains uncommitted files', async () => {
  const advance = cleanupClock()
  const f = remoteSourceFixture()
  const row = { materialization_id: f.record.receipt.materializationId, record: f.record,
    execution: f.execution, settlement_pending: false, already_closed: true, run_terminal: true,
    worktree_cleanup: { state: 'retained', removalAttempted: true,
      nextAttemptAt: new Date(Date.now() + 300_000).toISOString() } }
  const pool = { query: async () => ({ rows: [row] }) } as unknown as Pick<pg.Pool, 'query'>
  await closeCompletedWorkflowSources(pool, f.sources, f.report)
  expect(f.sources.confirmClosed).not.toHaveBeenCalled()
  advance(300_000)
  await closeCompletedWorkflowSources(pool, f.sources, f.report)
  expect(f.sources.confirmClosed).toHaveBeenCalledWith(f.record)
  expect(f.report).not.toHaveBeenCalled()
})

it.each([
  new DomainError('SOURCE_EXECUTION_UNCERTAIN', 'Physical closure is unconfirmed.', 409),
  new DeviceApplicationError('SOURCE_EXECUTION_UNCERTAIN'),
])('backs off unconfirmed closure from the source service or device (%s)', async error => {
  const advance = cleanupClock()
  const f = remoteSourceFixture()
  f.sources.confirmClosed.mockRejectedValue(error)
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  for (let tick = 0; tick < 10; tick++) {
    advance(1000)
    await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  }
  expect(f.sources.confirmClosed).toHaveBeenCalledTimes(1)
  expect(f.report).not.toHaveBeenCalled()
  advance(20_000)
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  expect(f.sources.confirmClosed).toHaveBeenCalledTimes(2)
})

it('increases closure retry delays up to five minutes while continuing to retry', async () => {
  const advance = cleanupClock()
  const f = remoteSourceFixture()
  f.sources.confirmClosed.mockRejectedValue(new DeviceApplicationError('SOURCE_EXECUTION_UNCERTAIN'))
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  let attempts = 1
  for (const interval of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
    advance(interval - 1)
    await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
    expect(f.sources.confirmClosed).toHaveBeenCalledTimes(attempts)
    advance(1)
    await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
    expect(f.sources.confirmClosed).toHaveBeenCalledTimes(++attempts)
  }
  expect(f.report).not.toHaveBeenCalled()
})

it('closes a source after confirmation arrives and resets its retry delay after success', async () => {
  const advance = cleanupClock()
  const f = remoteSourceFixture()
  const uncertainty = new DeviceApplicationError('SOURCE_EXECUTION_UNCERTAIN')
  f.sources.confirmClosed.mockRejectedValue(uncertainty)
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  advance(30_000)
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  f.sources.confirmClosed.mockResolvedValue(undefined)
  advance(60_000)
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  expect(f.sources.confirmClosed).toHaveBeenCalledTimes(3)
  f.sources.confirmClosed.mockRejectedValue(uncertainty)
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  expect(f.sources.confirmClosed).toHaveBeenCalledTimes(4)
  advance(30_000)
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  expect(f.sources.confirmClosed).toHaveBeenCalledTimes(5)
  expect(f.report).not.toHaveBeenCalled()
})

it.each([
  Object.assign(new Error('The original source receipt is missing.'), { code: 'ENOENT' }),
  new DeviceApplicationError('ENOENT'),
])('reports a missing source file once and keeps retrying without assuming completion (%s)', async error => {
  const advance = cleanupClock()
  const f = remoteSourceFixture()
  f.sources.confirmClosed.mockRejectedValue(error)
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  for (let tick = 0; tick < 10; tick++) {
    advance(1000)
    await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  }
  expect(f.sources.confirmClosed).toHaveBeenCalledTimes(1)
  expect(f.report).toHaveBeenCalledExactlyOnceWith(error)
  advance(20_000)
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  advance(60_000)
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  expect(f.sources.confirmClosed).toHaveBeenCalledTimes(3)
  expect(f.report).toHaveBeenCalledTimes(1)
  f.sources.confirmClosed.mockResolvedValue(undefined)
  advance(120_000)
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  expect(f.sources.confirmClosed).toHaveBeenCalledTimes(4)
  f.sources.confirmClosed.mockRejectedValue(error)
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  expect(f.report).toHaveBeenCalledTimes(2)
})

it('keeps retrying and reporting unrelated failures on each reconciliation tick', async () => {
  const f = remoteSourceFixture()
  const error = new Error('Closure database unavailable')
  f.sources.confirmClosed.mockRejectedValue(error)
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  expect(f.sources.confirmClosed).toHaveBeenCalledTimes(2)
  expect(f.report).toHaveBeenNthCalledWith(1, error)
  expect(f.report).toHaveBeenNthCalledWith(2, error)
})

it('continues through a full page of deferred sources to clean up another source', async () => {
  cleanupClock()
  const deferred = remoteSourceFixture()
  const ready = remoteSourceFixture()
  const page = Array.from({ length: 100 }, () => {
    const materializationId = randomUUID()
    return {
      materialization_id: materializationId,
      record: SourceMaterializationRecordSchema.parse({ ...deferred.record,
        receipt: { ...deferred.record.receipt, materializationId: materializationId } }),
      execution: deferred.execution,
    }
  })
  const lastPage = [{ materialization_id: ready.record.receipt.materializationId,
    record: ready.record, execution: ready.execution }]
  const scans = [{ rows: page }, { rows: lastPage }, { rows: page }, { rows: lastPage }]
  // A lookup of one source still sees it open; scans return their pages in order.
  const query = vi.fn(async (_text: string, params: unknown[]) => params[3] === null ? scans.shift()
    : { rows: [...page, ...lastPage].filter(row => row.materialization_id === params[3]) })
  const pool = { query } as unknown as Pick<pg.Pool, 'query'>
  const confirmClosed = vi.fn(async (record: typeof ready.record) => {
    if (record.receipt.materializationId !== ready.record.receipt.materializationId) {
      throw new DeviceApplicationError('SOURCE_EXECUTION_UNCERTAIN')
    }
  })
  const sources = { confirmClosed }
  await closeCompletedWorkflowSources(pool, sources, ready.report)
  expect(confirmClosed).toHaveBeenCalledTimes(101)
  await closeCompletedWorkflowSources(pool, sources, ready.report)
  expect(confirmClosed).toHaveBeenCalledTimes(102)
  expect(confirmClosed).toHaveBeenLastCalledWith(ready.record)
  expect(ready.report).not.toHaveBeenCalled()
})

it('discards retry state when a source no longer appears in a completed scan', async () => {
  cleanupClock()
  const f = remoteSourceFixture()
  const rows = [{ materialization_id: f.record.receipt.materializationId,
    record: f.record, execution: f.execution }]
  const scans = [{ rows }, { rows: [] }, { rows }]
  const query = vi.fn(async (_text: string, params: unknown[]) => params[3] === null ? scans.shift() : { rows })
  const pool = { query } as unknown as Pick<pg.Pool, 'query'>
  f.sources.confirmClosed.mockRejectedValue(new DeviceApplicationError('ENOENT'))
  await closeCompletedWorkflowSources(pool, f.sources, f.report)
  await closeCompletedWorkflowSources(pool, f.sources, f.report)
  await closeCompletedWorkflowSources(pool, f.sources, f.report)
  expect(f.sources.confirmClosed).toHaveBeenCalledTimes(2)
  expect(f.report).toHaveBeenCalledTimes(2)
})

it('leaves a source that reservation reclamation closed after the sweep listed it', async () => {
  const f = remoteSourceFixture()
  const listed = (await f.pool.query('')).rows
  let queries = 0
  // Reclamation removes the Worker directory and settles the reservation while the sweep is walking its page.
  const pool = { query: async () => ({ rows: ++queries === 1 ? listed : [] }) } as unknown as Pick<pg.Pool, 'query'>
  await closeCompletedWorkflowSources(pool, f.sources, f.report)
  expect(f.sources.confirmClosed).not.toHaveBeenCalled()
  expect(f.report).not.toHaveBeenCalled()
})

it('waits for reservation reclamation of the same source before closing it', async () => {
  const f = remoteSourceFixture()
  const listed = (await f.pool.query('')).rows
  let reclaimed = false
  const pool = { query: async () => ({ rows: reclaimed ? [] : listed }) } as unknown as Pick<pg.Pool, 'query'>
  const reclamation = deferred<void>()
  const reclaiming = withSourceOperationExclusion(f.record.operationId, async () => {
    await reclamation.promise
    reclaimed = true
  })
  const sweep = closeCompletedWorkflowSources(pool, f.sources, f.report)
  await new Promise(resolve => setImmediate(resolve))
  expect(f.sources.confirmClosed).not.toHaveBeenCalled()
  reclamation.resolve()
  await Promise.all([reclaiming, sweep])
  expect(f.sources.confirmClosed).not.toHaveBeenCalled()
  expect(f.report).not.toHaveBeenCalled()
})
