import { afterAll, beforeAll, expect, it } from 'vitest'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { nativeStreamFixture } from './helpers/nativeStreamFixture.js'
import { withTransaction } from '../src/infrastructure/transaction.js'

let db: Awaited<ReturnType<typeof currentDatabase>>
const fixtures: Awaited<ReturnType<typeof nativeStreamFixture>>[] = []
beforeAll(async () => { db = await currentDatabase() }, 60_000)
afterAll(async () => {
  for (const f of fixtures) await f.owner.release()
  await db?.close()
})

async function fixture() {
  const f = await nativeStreamFixture(db, 2, true)
  fixtures.push(f)
  return f
}

function frames(f: Awaited<ReturnType<typeof fixture>>, start: number, count = 4) {
  return Array.from({ length: count }, (_, index) => {
    const event = f.event(start + index)
    return { event, evidence: f.capture({ type: 'event', event }) }
  })
}

it('commits ordered transcript batches beside shared Run/head readers and another locked execution', async () => {
  const f = await fixture()
  const lease = { ...f.lease.fence, live: true, providerId: 'turn' }
  const before = await db.pool.query('select head_sequence,record from run_graph_heads join run_graph_public_projection using(run_id) where run_id=$1',
    [f.scope.runId])
  const batches = [frames(f, 0), frames(f, 4), frames(f, 8)]
  await withTransaction(db.pool, async reader => {
    await reader.query('select id from runs where id=$1 for share', [f.scope.runId])
    await reader.query('select run_id from run_graph_heads where run_id=$1 for share', [f.scope.runId])
    await reader.query('select id from harness_executions where id=$1 for update', [f.executions[0]!.id])
    await Promise.all(batches.map(batch => f.repository.appendNativeEvents(batch, f.owner, lease)))
  })
  const saved = await f.read()
  expect(saved.events).toEqual(batches.flat().map(({ event }) => ({ record: event })))
  expect((await db.pool.query('select head_sequence,record from run_graph_heads join run_graph_public_projection using(run_id) where run_id=$1',
    [f.scope.runId])).rows).toEqual(before.rows)
  expect((await db.pool.query('select proof_id from workflow_native_proofs where execution_id=$1',
    [f.execution.id])).rowCount).toBe(12)
  await f.repository.appendNativeEvents(frames(f, 0, 12), f.owner, lease)
  expect(await f.read()).toEqual(saved)
  const changed = { ...f.event(1), payload: { text: 'different' } }
  await expect(f.repository.appendNativeEvents([
    { event: changed, evidence: f.capture({ type: 'event', event: changed }) },
  ], f.owner, lease)).rejects.toMatchObject({ code: 'NATIVE_SOURCE_CONFLICT' })
  expect(await f.read()).toEqual(saved)
})

it('keeps transcript order through the single-event public entry beside Run readers', async () => {
  const f = await fixture()
  await withTransaction(db.pool, async reader => {
    await reader.query('select id from runs where id=$1 for share', [f.scope.runId])
    for (const { event, evidence } of frames(f, 0)) {
      await f.repository.appendNativeEvent(event, f.owner,
        { ...f.lease.fence, live: true, providerId: 'turn' }, undefined, undefined, evidence)
    }
  })
  expect((await f.read()).events).toEqual(frames(f, 0).map(({ event }) => ({ record: event })))
})
