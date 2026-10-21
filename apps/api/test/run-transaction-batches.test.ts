import { nativeStreamFixture } from './helpers/nativeStreamFixture.js'
import pg from 'pg'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { HarnessExecutionSchema, type HarnessNativeEvent } from '@foreman-code/contracts'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { createWorkflowNativeCaptureChannel } from '../src/modules/interactions/workflowNativeCapture.js'
import { settleWorkForRestart } from '../src/modules/runs/workflowLifecycle.js'
import { graphSourceDigest } from '../src/modules/run-graph/publication.js'
import { nativeGraphSource } from '../src/modules/run-graph/nativeIngestion.js'
import { appendNormalizedNativeEvents } from '../src/modules/runs/nativeEventBatch.js'
import { normalizeNativeProducerEvent } from '../src/modules/run-graph/nativeProducerNormalization.js'
import { beforeGraphCommit, type GraphTransactionSql } from '../src/modules/run-graph/connection.js'
import { appendNativeEvent, appendNormalizedNativeEvent } from '../src/modules/runs/nativeEvents.js'

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
  const start = performance.now()
  try {
    const value = await work()
    return { value, statements, elapsedMs: performance.now() - start }
  } finally { wrapper.mockRestore() }
}

async function fixture(size: number, live = false, closed = false,
  checkPhysical?: (sql: GraphTransactionSql) => Promise<void>) {
  const f = await nativeStreamFixture(db, size, live, closed, checkPhysical)
  owners.push(f.owner)
  return f
}

it('appends transcript batches in a constant number of statements and preserves replay and conflict behavior', async () => {
  const f = await fixture(80, true)
  const frames = Array.from({ length: 16 }, (_, index) => {
    const event = f.event(index)
    return { event, evidence: f.capture({ type: 'event', event }) }
  })
  const first = await measure(() => f.repository.appendNativeEvents(frames.slice(0, 1), f.owner, { ...f.lease.fence, live: true, providerId: 'turn' }))
  const batch = await measure(() => f.repository.appendNativeEvents(frames, f.owner, { ...f.lease.fence, live: true, providerId: 'turn' }))
  const saved = await f.read()
  expect(saved.events).toEqual(frames.map(({ event }) => ({ record: event })))
  expect(saved.executions).toEqual(f.executions.map(record => ({ record })))
  await f.repository.appendNativeEvents(frames, f.owner, { ...f.lease.fence, live: true, providerId: 'turn' })
  expect(await f.read()).toEqual(saved)
  const changed = { ...frames[2]!.event, payload: { different: true } }
  await expect(f.repository.appendNativeEvents([{ event: changed, evidence: f.capture({ type: 'event', event: changed }) }],
    f.owner, { ...f.lease.fence, live: true, providerId: 'turn' })).rejects.toMatchObject({ code: 'NATIVE_SOURCE_CONFLICT' })
  expect(await f.read()).toEqual(saved)
  console.info('appendNativeEvents', batch)
  expect(batch.statements).toBeLessThanOrEqual(first.statements + 2)
  expect(batch.statements).toBeLessThanOrEqual(26)
})

it('replays retained semantic history with constant statement count and unchanged persisted events', async () => {
  const f = await fixture(80, true)
  const events = Array.from({ length: 400 }, (_, sequence) => ({ ...f.event(sequence), type: 'turn.started',
    payload: { threadId: f.session.nativeSessionId, turn: { id: 'turn', status: 'inProgress' } } }))
  await f.owner.oneShotConnection().transaction(async sql => {
    for (const event of events) {
      await appendNormalizedNativeEvent(sql, normalizeNativeProducerEvent(event))
      const source = nativeGraphSource(event)
      await sql.query(`insert into run_graph_sources(run_id,source_kind,source_id,source_revision,source_digest,semantic_digest,first_sequence)
        values($1,'native_event',$2,0,$3,$4,1)`,
      [f.scope.runId, source.sourceId, graphSourceDigest(event), graphSourceDigest({ fixture: event.sequence })])
    }
  })
  // The provider's exact terminal frame is already retained, like the live stream before its history read.
  const terminal = { ...f.event(400), type: 'turn.completed', payload: { threadId: f.session.nativeSessionId,
    turn: { id: 'turn', status: 'failed' } } }
  await appendNativeEvent(db.pool, terminal)
  await db.pool.query(`insert into run_graph_sources(run_id,source_kind,source_id,source_revision,source_digest,semantic_digest,first_sequence)
    values($1,'native_event',$2,0,$3,$4,1)`,
  [f.scope.runId, nativeGraphSource(terminal).sourceId, graphSourceDigest(terminal), graphSourceDigest({ fixture: 'terminal' })])
  const history = { correlationId: `execution:${f.execution.id}`, nativeTurnId: 'turn',
    events: [...events, terminal], pendingInteractions: [], terminalTurn: {
      correlationId: `execution:${f.execution.id}`, providerId: 'turn', result: { outcome: 'failed' as const,
        error: { code: 'FIXTURE_FAILED', message: 'Fixture terminal', retryable: false } },
    } }
  const evidence = f.capture({ type: 'history', history })
  const incoming = HarnessExecutionSchema.parse({ ...f.execution, state: 'completed', result: history.terminalTurn.result,
    finishedAt: channelObservedAt(evidence) })
  const before = await f.read()
  const measured = await measure(() => f.repository.updateExecution(incoming, f.owner, evidence))
  const after = await f.read()
  expect(after.events).toEqual(before.events)
  expect(after.executions).toEqual(before.executions.map(row => row.record.id === incoming.id ? { record: incoming } : row))
  console.info('updateExecution', measured)
  expect(measured.statements).toBeLessThanOrEqual(128)
})

function channelObservedAt(evidence: ReturnType<ReturnType<typeof createWorkflowNativeCaptureChannel>['capture']['capture']>): string {
  return (evidence.evidence as { observedAt: string }).observedAt
}

it('retains many unsubmitted executions across restart with constant statement count and identical persisted state', async () => {
  const small = await fixture(1)
  const large = await fixture(80)
  const before = await large.read()
  const first = await measure(() => settleWorkForRestart(small.owner))
  const batch = await measure(() => settleWorkForRestart(large.owner))
  expect(first.value).toBe(true)
  expect(batch.value).toBe(true)
  expect(await large.read()).toEqual(before)
  console.info('settleWorkForRestart', batch)
  expect(batch.statements).toBeLessThanOrEqual(first.statements + 2)
  expect(batch.statements).toBeLessThanOrEqual(100)
})

it('settles many closed native attempts across restart without per-attempt queries', async () => {
  const small = await fixture(1, false, true)
  const large = await fixture(80, false, true)
  const before = await large.read()
  const first = await measure(() => settleWorkForRestart(small.owner))
  const batch = await measure(() => settleWorkForRestart(large.owner))
  expect(first.value).toBe(true)
  expect(batch.value).toBe(true)
  expect(await large.read()).toEqual(before)
  expect((await db.pool.query('select execution_id from execution_native_sessions where workflow_finalized_at is not null and execution_id=any($1::text[])',
    [large.executions.map(item => item.id)])).rowCount).toBe(80)
  console.info('settleClosedWorkForRestart', batch)
  expect(batch.statements).toBeLessThanOrEqual(first.statements + 2)
  expect(batch.statements).toBeLessThanOrEqual(100)
})

it('matches single-event allocation, replay, activity filtering and absorbing rejection across a mixed batch', async () => {
  const f = await fixture(2)
  const source = f.executions[0]!
  const target = f.executions[1]!
  const first = { ...f.event(5), executionId: source.id, payload: { text: 'visible' } }
  const disconnected = { executionId: source.id, sequence: 10, type: 'native.notification',
    occurredAt: source.createdAt, payload: { text: 'unconnected' } }
  const other = { ...first, connectionId: 'other-connection', sequence: 7 }
  const rejected = { ...first, sequence: 8, payload: null } as unknown as HarnessNativeEvent
  const absorbed = { ...first, sequence: 8, payload: { text: 'bounded later replay' } }
  const frames = [first, disconnected, other, first, f.event(9), rejected, absorbed]
    .map(event => ({ ...event, executionId: source.id }))
  for (const event of frames) await appendNativeEvent(db.pool, event)
  const batch = frames.map(event => normalizeNativeProducerEvent({ ...event, executionId: target.id }))
  const measured = await measure(() => f.owner.oneShotConnection().transaction(sql => appendNormalizedNativeEvents(sql, batch)))
  expect(measured.value.map(item => [item.inserted, item.rejected, item.sequence])).toEqual([
    [true, false, '0'], [true, false, '10'], [true, false, '11'], [false, false, '0'],
    [true, false, '12'], [true, true, '13'], [false, true, '13'],
  ])
  const saved = async (id: string) => ({
    events: (await db.pool.query('select record,connection_id,source_sequence from harness_native_events where execution_id=$1 order by sequence', [id]))
      .rows.map(row => ({ ...row, record: { ...row.record, executionId: 'execution' } })),
    activities: (await db.pool.query('select kind,payload from run_activity where harness_execution_id=$1 order by sequence', [id])).rows,
    allocator: (await db.pool.query('select native_event_next_sequence::text from harness_executions where id=$1', [id])).rows,
  })
  const original = await saved(source.id)
  expect(await saved(target.id)).toEqual(original)
  await f.owner.oneShotConnection().transaction(sql => appendNormalizedNativeEvents(sql, batch))
  expect(await saved(target.id)).toEqual(original)
  await expect(f.owner.oneShotConnection().transaction(sql => appendNormalizedNativeEvents(sql, [
    normalizeNativeProducerEvent({ ...f.event(100), executionId: target.id }),
    normalizeNativeProducerEvent({ ...first, executionId: target.id, payload: { conflicting: true } }),
  ]))).rejects.toMatchObject({ code: 'NATIVE_EVENT_IDENTITY_CONFLICT' })
  expect(await saved(target.id)).toEqual(original)
  // An unconnected identity cannot adopt a connected rejection at the same stored position.
  await expect(f.owner.oneShotConnection().transaction(sql => appendNormalizedNativeEvents(sql, [
    normalizeNativeProducerEvent({ ...disconnected, executionId: target.id, sequence: 13 }),
  ]))).rejects.toMatchObject({ code: 'NATIVE_EVENT_IDENTITY_CONFLICT' })
  expect(await saved(target.id)).toEqual(original)
  expect(measured.statements).toBeLessThanOrEqual(5)
})

it('rolls a native batch back when its writer lane changes before commit', async () => {
  let changed = false
  const f = await fixture(1, true, false, async sql => {
    if (changed) return
    changed = true
    beforeGraphCommit(sql, async () => {
      await sql.query("update native_session_lanes set record=jsonb_set(record,'{leaseToken}',$2::jsonb) where id=$1",
        [f.lease.fence.id, JSON.stringify('replaced')])
    })
  })
  const before = await f.read()
  const event = f.event(1)
  await expect(f.repository.appendNativeEvents([{ event, evidence: f.capture({ type: 'event', event }) }],
    f.owner, { ...f.lease.fence, live: true, providerId: 'turn' })).rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
  expect(await f.read()).toEqual(before)
  expect((await db.pool.query('select proof_id from workflow_native_proofs where execution_id=$1', [f.execution.id])).rowCount).toBe(0)
  expect((await db.pool.query("select record->>'leaseToken' as token from native_session_lanes where id=$1",
    [f.lease.fence.id])).rows).toEqual([{ token: 'token' }])
})
