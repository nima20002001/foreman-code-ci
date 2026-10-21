import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { MemorySaver } from '@langchain/langgraph-checkpoint'
import { afterEach, test, vi } from 'vitest'
import { DomainError } from '../src/modules/errors.js'
import { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import { DeviceApplicationError } from '../src/modules/devices/deviceApplicationError.js'
import { managedMcpChannelFixture } from './helpers/managedMcpChannel.js'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

async function sweep(failure: unknown, passes: number, precedingFailures: readonly unknown[] = []) {
  vi.useFakeTimers()
  const owner = { runId: 'run-stuck', release: vi.fn(async () => {}) }
  const runs = { repeatRepositoryFactory: () => ({}),
    reconciliationCandidates: vi.fn(async (after: string) => after === '' ? [{ id: 'run-stuck' }] : []),
    acquireOwnership: vi.fn(async () => owner),
    requestCleanup: vi.fn(async () => {}) }
  const engine = new LangGraphWorkflowEngine(runs as never, {} as never, { reconcileReviews: async () => {}, reconcileWorkflowControls: async () => {} } as never,
    new MemorySaver(), '/workspace/reconcile-failure', {} as never, {} as never, {} as never)
  const start = vi.spyOn(engine, 'start').mockRejectedValue(failure)
  for (const preceding of precedingFailures) start.mockRejectedValueOnce(preceding)
  const reported: unknown[] = []
  for (let pass = 0; pass < passes; pass++) {
    await engine.reconcile(error => { reported.push(error) })
    await vi.advanceTimersByTimeAsync(60_000)
  }
  return { start, runs, owner, reported }
}

test('a Run whose recovery fails transiently stays eligible for recovery with backoff', async () => {
  const { start, runs, reported } = await sweep(new DomainError('REMOTE_NATIVE_PHYSICAL_BACKPRESSURE',
    'Original physical source retention is full.', 503), 40)
  assert.equal(start.mock.calls.length, 40)
  assert.equal(runs.requestCleanup.mock.calls.length, 0)
  assert.ok(reported.every(error => (error as DomainError).code === 'REMOTE_NATIVE_PHYSICAL_BACKPRESSURE'))
})

test('lost installed workflow authority stays recoverable after crossing the device link', async () => {
  const channel = managedMcpChannelFixture({ mainId: randomUUID(), deviceId: randomUUID(),
    workerInstallationId: randomUUID(), bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1,
    connectionGeneration: 2, connectionEpoch: randomUUID() }, {
    namespace: 'execution-v1', version: 1, role: 'server', maxJsonBytes: 4096, maxBinaryBytes: 0,
    handle: async () => { throw new DomainError('WORKER_WORKFLOW_UNAVAILABLE',
      'The original installed workflow authority is unavailable.', 409) },
  })
  let failure: unknown
  try {
    failure = await channel.main.request('execution-v1', { method: 'status' }).catch(error => error)
    assert.ok(failure instanceof DeviceApplicationError)
  } finally {
    await channel.close()
  }
  const { start, runs } = await sweep(failure, 40)
  assert.equal(start.mock.calls.length, 40)
  assert.equal(runs.requestCleanup.mock.calls.length, 0)
  assert.equal((failure as DeviceApplicationError).retryable, true)
})

test.each([
  { code: 'RUN_PIN_CONFLICT', message: 'The checkpoint belongs to another Run.' },
  { code: 'REMOTE_NATIVE_SOURCE_NOT_CAPTURED', message: 'The authenticated original remote source is unavailable.' },
])('permanent recovery failure $code is settled by cleanup with its real cause', async ({ code, message }) => {
  const { start, runs, owner } = await sweep(new DomainError(code, message, 409), 40)
  assert.equal(runs.requestCleanup.mock.calls.length >= 1, true)
  assert.deepEqual(runs.requestCleanup.mock.calls[0], ['run-stuck', owner, { outcome: 'failed',
    error: { code, message, retryable: false } }])
  assert.equal(owner.release.mock.calls.length, runs.requestCleanup.mock.calls.length)
  // The cleanup request is settled by the same recovery sweep, so the Run is never dropped from it.
  assert.ok(start.mock.calls.length > 10)
})

test.each([0, 9])('pending native closure stays eligible without failed cleanup after %i source capture failures', async count => {
  const pending = new DomainError('REPEAT_CLEANUP_PENDING',
    'The original native process has no positive closure receipt yet.', 409)
  const sourceFailure = new DomainError('REMOTE_NATIVE_SOURCE_NOT_CAPTURED',
    'The authenticated original remote source is unavailable.', 409)
  const { start, runs, reported } = await sweep(pending, 40, Array.from({ length: count }, () => sourceFailure))

  assert.equal(start.mock.calls.length, 40)
  assert.equal(reported.length, 40)
  assert.equal(runs.requestCleanup.mock.calls.length, 0)
  assert.ok(reported.slice(count).every(error => error === pending))
})
