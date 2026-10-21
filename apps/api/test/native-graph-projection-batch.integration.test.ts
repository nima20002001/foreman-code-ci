import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import pg from 'pg'
import type { HarnessNativeEvent } from '@foreman-code/contracts'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { nativeStreamFixture } from './helpers/nativeStreamFixture.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'

let db: Awaited<ReturnType<typeof currentDatabase>>
const owners: RunOwnership[] = []
beforeAll(async () => { db = await currentDatabase() }, 60_000)
afterAll(async () => {
  for (const owner of owners) await owner.release()
  await db?.close()
})

async function measure<T>(work: () => Promise<T>) {
  let statements = 0
  const query = pg.Client.prototype.query
  const wrapper = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: unknown[]) {
    statements++
    return Reflect.apply(query, this, args)
  } as typeof query)
  try {
    return { value: await work(), statements }
  } finally { wrapper.mockRestore() }
}

async function fixture() {
  const f = await nativeStreamFixture(db, 1, true)
  owners.push(f.owner)
  return f
}

/** Fixture UUIDs and digests differ per fixture; equal values must still map to equal names. */
function renameIds(dump: string): string {
  const names = new Map<string, string>()
  return dump.replace(/[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
    if (!names.has(id)) names.set(id, `id${names.size}`)
    return names.get(id)!
  })
}

/** A graph-relevant native frame: each completed command item moves the node's public activity. */
function completedItem(executionId: string, sequence: number): HarnessNativeEvent {
  return { executionId, connectionId: 'connection', sequence, type: 'item.completed',
    occurredAt: '2026-10-01T00:00:00.000Z',
    payload: { turnId: 'turn', item: { id: `item-${sequence}`, type: 'commandExecution', status: 'completed' } } as never }
}

/** Transcript-only frame that the graph ignores; it still persists as native history. */
function transcript(executionId: string, sequence: number): HarnessNativeEvent {
  return { executionId, connectionId: 'connection', sequence, type: 'native.notification',
    occurredAt: '2026-10-01T00:00:00.000Z', payload: { nativeMethod: 'item/agentMessage/delta', text: `frame ${sequence}` } }
}

it('projects a 16-frame graph-relevant native batch within a bounded statement budget', async () => {
  const f = await fixture()
  const lease = { ...f.lease.fence, live: true, providerId: 'turn' }
  const frames = (from: number, count: number) => Array.from({ length: count }, (_, index) => {
    const event = completedItem(f.execution.id, from + index)
    return { event, evidence: f.capture({ type: 'event', event }) }
  })
  const single = await measure(() => f.repository.appendNativeEvents(frames(0, 1), f.owner, lease))
  const batch = await measure(() => f.repository.appendNativeEvents(frames(1, 16), f.owner, lease))
  expect(batch.statements).toBeLessThanOrEqual(single.statements + 15 * 5)
})

it('persists a mixed graph and transcript batch exactly as the same frames appended one at a time', async () => {
  const sequence = (executionId: string) => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
    .map(index => index % 3 === 0 ? transcript(executionId, index) : completedItem(executionId, index))
  const batched = await fixture()
  const serial = await fixture()
  const lease = (f: Awaited<ReturnType<typeof fixture>>) => ({ ...f.lease.fence, live: true, providerId: 'turn' })
  const framesOf = (f: Awaited<ReturnType<typeof fixture>>) => sequence(f.execution.id)
    .map(event => ({ event, evidence: f.capture({ type: 'event', event }) }))
  await batched.repository.appendNativeEvents(framesOf(batched), batched.owner, lease(batched))
  for (const frame of framesOf(serial)) await serial.repository.appendNativeEvents([frame], serial.owner, lease(serial))
  const normalized = async (f: Awaited<ReturnType<typeof fixture>>) => {
    const dump = JSON.stringify({
      events: (await db.pool.query('select record,connection_id,source_sequence from harness_native_events where execution_id=$1 order by sequence',
        [f.execution.id])).rows,
      activities: (await db.pool.query('select kind,payload from run_activity where run_id=$1 order by sequence', [f.scope.runId])).rows,
      nativeActivity: (await db.pool.query(`select activity,last_native_sequence::text,terminal_native_sequence::text
        from run_native_activity where run_id=$1 order by workflow_node_id,work_id`, [f.scope.runId])).rows,
      checkpoints: (await db.pool.query('select checkpoint from run_native_projection_checkpoints where run_id=$1', [f.scope.runId])).rows,
      publicProjection: (await db.pool.query('select record from run_graph_public_projection where run_id=$1', [f.scope.runId])).rows,
    })
    return renameIds(dump)
  }
  expect(await normalized(batched)).toEqual(await normalized(serial))
})
