import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { readCurrentRunDetails } from '../src/modules/runs/currentRead.js'
import { appendNormalizedNativeEvents } from '../src/modules/runs/nativeEventBatch.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { withExclusiveGraphConnection, type GraphSqlClient } from '../src/modules/run-graph/connection.js'
import { normalizeNativeProducerEvent } from '../src/modules/run-graph/nativeProducerNormalization.js'
import { readRepeatGraphPinsLocked } from '../src/modules/run-graph/repeatProjectionRows.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { nativeStreamFixture } from './helpers/nativeStreamFixture.js'
import { currentRepositoryFixture } from './helpers/wave25CurrentRepository.js'

let db: Awaited<ReturnType<typeof currentDatabase>>
const owners: RunOwnership[] = []
beforeAll(async () => { db = await currentDatabase() }, 60_000)
afterAll(async () => {
  for (const owner of owners) await owner.release()
  await db?.close()
})

async function measure<T>(label: string, work: () => Promise<T>, sql?: GraphSqlClient) {
  const query = sql ? vi.spyOn(sql, 'query') : vi.spyOn(pg.Client.prototype, 'query')
  try {
    const value = await work()
    const statements = query.mock.calls.length
    console.info(label, { statements })
    return { value, statementCount: statements }
  } finally {
    query.mockRestore()
  }
}

it('reads ordered Run details and activity with bounded round trips as execution history grows', async () => {
  for (const size of [1, 80]) {
    const f = await nativeStreamFixture(db, size)
    owners.push(f.owner)
    const event = { ...f.event(0), payload: { text: 'visible diagnostic' } }
    await f.owner.oneShotConnection().transaction(sql =>
      appendNormalizedNativeEvents(sql, [normalizeNativeProducerEvent(event)]))
    const read = () => readCurrentRunDetails(db.pool, f.issued.principal, f.scope.workspaceId, f.scope.runId)
    const result = await measure(`run_get executions=${size}`, read)
    expect(result.value.executions).toEqual(f.executions)
    expect(result.value.activity.map(({ kind, payload }) => ({ kind, payload })))
      .toEqual((await f.read()).activities)
    expect(result.value.activity.at(-1)).toMatchObject({ kind: 'harness_output', harnessExecutionId: f.execution.id,
      payload: { nativeEventSequence: 0, nativeEventType: event.type } })
    expect(result.value.activitySnapshot!.queued).toEqual(f.executions.map(execution => ({
      kind: 'execution', workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId,
      workflowVersionId: f.scope.workflowVersionId, runId: f.scope.runId,
      executionId: execution.id, attemptKey: String(execution.attempt),
    })))
    expect(await read()).toEqual(result.value)
    expect.soft(result.statementCount).toBeLessThanOrEqual(size === 1 ? 19 : 23)
  }
})

it('reads Repeat pins together and preserves occurrence and admission replay', async () => {
  const base = makeCurrentWorkflowFixture(randomUUID(), 'repeat')
  const f = await currentRepositoryFixture({ ...db, databaseUrl: process.env.TEST_DATABASE_URL! }, base)
  const owner = await RunOwnership.acquire(db.pool, f.f.run.id, () => {})
  if (!owner) throw new Error('Fixture Run already has an owner')
  owners.push(owner)
  const store = await f.repository.repeat(owner)
  const pins = await withExclusiveGraphConnection(db.pool, connection => connection.transaction(sql =>
    measure('repeat pins', () => readRepeatGraphPinsLocked(sql, f.f.scope), sql), true))
  expect(pins.value.run).toEqual(f.f.run)
  expect(pins.value.version).toEqual(f.f.version)
  expect(pins.value.configurations).toEqual(f.f.configurations)
  const block = f.f.version.definition.repeat!.blocks[0]!
  const entered = await measure('repeat enterBlock', () => store.enterBlock(block.id))
  if (entered.value.kind !== 'active') throw new Error('Repeat entry should be active')
  const ref = { nodeId: block.entryNodeId, occurrence: entered.value.occurrence.identity }
  const { executionId, ...identity } = f.f.identities[0]!
  const candidate = () => HarnessExecutionSchema.parse({ ...identity, id: executionId,
    runId: f.f.run.id, state: 'queued', input: {}, createdAt: f.f.createdAt })
  const admitted = await measure('repeat admit', () => store.admit(ref, candidate))
  if (admitted.value.kind !== 'admitted') throw new Error('Repeat admission should queue an execution')
  const head = async () => (await db.pool.query('select head_sequence::text from run_graph_heads where run_id=$1',
    [f.f.run.id])).rows
  const before = await head()
  expect(await store.enterBlock(block.id)).toEqual(entered.value)
  expect(await store.admit(ref, () => { throw new Error('Replay must use its saved execution') }))
    .toEqual({ ...admitted.value, reused: true })
  expect((await store.readExecution(executionId)).execution).toEqual(admitted.value.execution)
  expect(await head()).toEqual(before)
  expect(pins.statementCount).toBe(1)
})

it('batches native allocation and leaves replay-only execution tuples untouched', async () => {
  const f = await nativeStreamFixture(db, 2)
  owners.push(f.owner)
  const events = f.executions.map(execution => normalizeNativeProducerEvent({
    ...f.event(0), executionId: execution.id,
  }))
  await f.owner.oneShotConnection().transaction(sql => appendNormalizedNativeEvents(sql, events.slice(0, 1)))
  const result = await f.owner.oneShotConnection().transaction(async sql => {
    const writes = async () => Number((await sql.query<{ count: string }>(
      "select pg_stat_get_xact_tuples_updated('harness_executions'::regclass)::text as count")).rows[0]!.count)
    const before = await writes()
    const measured = await measure('native mixed replay batch', () => appendNormalizedNativeEvents(sql, events), sql)
    return { ...measured, updates: await writes() - before }
  })
  expect(result.value).toEqual([
    { inserted: false, rejected: false, sequence: '0' },
    { inserted: true, rejected: false, sequence: '0' },
  ])
  expect((await db.pool.query('select execution_id,sequence from harness_native_events where execution_id=any($1::text[]) order by execution_id',
    [f.executions.map(execution => execution.id)])).rows)
    .toEqual(f.executions.map(execution => ({ execution_id: execution.id, sequence: 0 })))
  console.info('native mixed replay batch', { updates: result.updates })
  expect.soft(result.statementCount).toBe(2)
  expect(result.updates).toBe(1)
})

it('reads committed replay identities after waiting for a concurrent native appender', async () => {
  const f = await nativeStreamFixture(db, 1)
  owners.push(f.owner)
  const event = normalizeNativeProducerEvent(f.event(7))
  let releaseWriter!: () => void
  let writerReady!: () => void
  const held = new Promise<void>(resolve => { releaseWriter = resolve })
  const ready = new Promise<void>(resolve => { writerReady = resolve })
  const writer = f.owner.oneShotConnection().transaction(async sql => {
    await appendNormalizedNativeEvents(sql, [event])
    writerReady()
    await held
  })
  let reader: Promise<unknown> | undefined
  try {
    await ready
    await withExclusiveGraphConnection(db.pool, async connection => {
      const pid = Number((await connection.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid)
      reader = connection.transaction(sql => appendNormalizedNativeEvents(sql, [event]))
      try {
        await vi.waitFor(async () => {
          const blocked = (await db.pool.query<{ blocked: boolean }>(
            'select cardinality(pg_blocking_pids($1))>0 as blocked', [pid])).rows[0]!.blocked
          expect(blocked).toBe(true)
        })
      } finally {
        releaseWriter()
      }
      await writer
      expect(await reader).toEqual([{ inserted: false, rejected: false, sequence: '0' }])
    })
    expect((await f.read()).events).toEqual([{ record: { ...event.event, sequence: 0 } }])
  } finally {
    releaseWriter()
    await Promise.allSettled([writer, ...(reader ? [reader] : [])])
  }
})
