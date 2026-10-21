import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import type pg from 'pg'
import type { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import { unavailableRuntime, currentRepositoryFixture } from './eng04-runtime-repository-fixture.js'

// Recording writer ports verify dispatch, not SQL authority or publication.
const calls = vi.hoisted(() => ({ running: [] as unknown[][], stop: [] as unknown[][],
  cleanup: [] as unknown[][], finished: [] as unknown[][] }))
vi.mock('../src/modules/runs/repeatLifecycle.js', () => ({
  markRepeatRunRunning: async (...args: unknown[]) => { calls.running.push(args) },
  requestRepeatRunStop: async (...args: unknown[]) => { calls.stop.push(args) },
}))
vi.mock('../src/modules/runs/workflowLifecycle.js', () => ({
  requestWorkflowCleanup: async (...args: unknown[]) => { calls.cleanup.push(args) },
  finishWorkflowCleanup: async (...args: unknown[]) => { calls.finished.push(args) },
}))
async function fixture() {
  calls.running = []; calls.stop = []; calls.cleanup = []; calls.finished = []
  const f = currentRepositoryFixture(), pool = {} as pg.Pool
  const owner = { runId: f.run.id, assertOwned: () => undefined } as RunOwnership
  type Args = ConstructorParameters<typeof PostgresRunRepository>
  const workflows = {} as Args[1], locations = { revalidateRunAuthorization: async () => { throw new Error('unexpected authority work') } } as unknown as Args[2]
  const { PostgresRunRepository: Repository } = await import('../src/modules/runs/postgres.js')
  const repository = new Repository(pool, workflows, locations, unavailableRuntime())
  return { f, pool, owner, locations, repository }
}
test('current running writer receives exact owner, policy service, update and resume permit', async () => {
  const f = await fixture(), update = { executionState: 'running' as const, outcome: 'pending' as const }
  await f.repository.updateState(f.f.run.id, update, f.owner)
  assert.deepEqual(calls.running, [[f.owner, f.locations, update, undefined]])
})
test('a different Run owner never reaches the current writer', async () => {
  const f = await fixture()
  await assert.rejects(f.repository.updateState(f.f.run.id, { executionState: 'running', outcome: 'pending' },
    { ...f.owner, runId: 'other-run' } as RunOwnership), { code: 'GRAPH_SCOPE_MISMATCH' })
  assert.equal(calls.running.length, 0)
})
test('Stop delegates the exact live authorizer to the current atomic writer', async () => {
  const f = await fixture(), authorize = async () => undefined
  await f.repository.requestStop(f.f.run.id, authorize)
  assert.deepEqual(calls.stop, [[f.pool, f.f.run.id, authorize]])
})
test('cleanup uses current lifecycle writers and preserves owner scope', async () => {
  const f = await fixture()
  await f.repository.requestCleanup(f.f.run.id, f.owner)
  await f.repository.finishCleanup(f.f.run.id, false, f.owner)
  const [pool, runId, owner, failure] = calls.cleanup[0]!
  assert.equal(calls.cleanup.length, 1)
  assert.equal(pool, f.pool)
  assert.equal(runId, f.f.run.id)
  assert.equal(owner, f.owner)
  assert.equal(failure, undefined)
  assert.deepEqual(calls.finished, [[f.owner, false]])
  await assert.rejects(f.repository.finishCleanup(f.f.run.id, false,
    { ...f.owner, runId: 'other-run' } as RunOwnership), { code: 'GRAPH_SCOPE_MISMATCH' })
  assert.equal(calls.finished.length, 1)
})
test('cleanup forwards the specific failure without dropping its Run owner', async () => {
  const f = await fixture()
  const failure = { outcome: 'failed' as const, error: {
    code: 'WORK_RUN_EXECUTION_BUDGET_EXHAUSTED', message: 'No execution capacity remains.', retryable: false,
  } }
  await f.repository.requestCleanup(f.f.run.id, f.owner, failure)
  const [pool, runId, owner, forwardedFailure] = calls.cleanup[0]!
  assert.equal(calls.cleanup.length, 1)
  assert.equal(pool, f.pool)
  assert.equal(runId, f.f.run.id)
  assert.equal(owner, f.owner)
  assert.deepEqual(forwardedFailure, failure)
})
