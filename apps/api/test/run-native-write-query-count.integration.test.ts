import { afterAll, beforeAll, expect, it } from 'vitest'
import { HarnessExecutionSchema, type HarnessNativeEvent } from '@foreman-code/contracts'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { nativeStreamFixture } from './helpers/nativeStreamFixture.js'
import { runtimeTimingChannel, type RuntimeTimingRecord } from '../src/infrastructure/runtimeTiming.js'

let db: Awaited<ReturnType<typeof currentDatabase>>
const owners: Array<Awaited<ReturnType<typeof nativeStreamFixture>>['owner']> = []
beforeAll(async () => { db = await currentDatabase() }, 60_000)
afterAll(async () => {
  for (const owner of owners) await owner.release()
  await db?.close()
})

async function measure<T>(work: () => Promise<T>) {
  let statements = 0
  const record = (message: unknown) => {
    if ((message as RuntimeTimingRecord).phase === 'sql.query') statements++
  }
  runtimeTimingChannel.subscribe(record)
  try { return { value: await work(), statements } }
  finally { runtimeTimingChannel.unsubscribe(record) }
}

async function fixture() {
  const f = await nativeStreamFixture(db, 1, true)
  owners.push(f.owner)
  return f
}

function frame(executionId: string, sequence: number): HarnessNativeEvent {
  return { executionId, connectionId: 'connection', sequence, type: 'item.completed',
    occurredAt: '2026-10-01T00:00:00.000Z',
    payload: { turnId: 'turn', item: { id: `item-${sequence}`, type: 'commandExecution', status: 'completed' } } }
}

it('appends graph frames without per-frame statements and retains ordered replay and atomic conflicts', async () => {
  const f = await fixture()
  const lease = { ...f.lease.fence, live: true, providerId: 'turn' }
  const frames = (from: number, size: number) => Array.from({ length: size }, (_, index) => {
    const event = frame(f.execution.id, from + index)
    return { event, evidence: f.capture({ type: 'event', event }) }
  })
  const single = await measure(() => f.repository.appendNativeEvents(frames(0, 1), f.owner, lease))
  const input = frames(1, 16)
  const batch = await measure(() => f.repository.appendNativeEvents(input, f.owner, lease))
  const saved = await f.read()
  expect(saved.events.map(row => row.record)).toEqual(Array.from({ length: 17 }, (_, index) => frame(f.execution.id, index)))
  await f.repository.appendNativeEvents(input, f.owner, lease)
  expect(await f.read()).toEqual(saved)
  const conflicting = { ...input[3]!.event, payload: { different: true } }
  await expect(f.repository.appendNativeEvents([
    ...frames(17, 1), { event: conflicting, evidence: f.capture({ type: 'event', event: conflicting }) },
  ], f.owner, lease)).rejects.toMatchObject({ code: 'NATIVE_EVENT_IDENTITY_CONFLICT' })
  expect(await f.read()).toEqual(saved)
  console.info('graph frame statements', { single: single.statements, batch: batch.statements })
  expect(batch.statements).toBeLessThanOrEqual(single.statements + 4)
})

it('updates from unretained graph history with bounded statements and immutable terminal replay', async () => {
  const update = async (size: number) => {
    const f = await fixture()
    const events = Array.from({ length: size }, (_, index) => frame(f.execution.id, index))
    events.push({ ...frame(f.execution.id, size), type: 'turn.completed',
      payload: { threadId: f.session.nativeSessionId, turn: { id: 'turn', status: 'failed' } } })
    const result = { outcome: 'failed' as const,
      error: { code: 'PROVIDER_FAILED', message: 'Provider stopped.', retryable: false } }
    const history = { correlationId: `execution:${f.execution.id}`, nativeTurnId: 'turn', events,
      pendingInteractions: [], terminalTurn: { correlationId: `execution:${f.execution.id}`, providerId: 'turn', result } }
    const evidence = f.capture({ type: 'history', history })
    const incoming = HarnessExecutionSchema.parse({ ...f.execution, state: 'completed', result,
      finishedAt: (evidence.evidence as { observedAt: string }).observedAt })
    const measured = await measure(() => f.repository.updateExecution(incoming, f.owner, evidence))
    const saved = await f.read()
    expect(saved.events.map(row => row.record)).toEqual(events)
    expect(await f.repository.getExecution(incoming.id, f.owner)).toEqual(incoming)
    await f.repository.updateExecution(incoming, f.owner, evidence)
    expect(await f.read()).toEqual(saved)
    await expect(f.repository.updateExecution({ ...incoming, result: { outcome: 'canceled' } }, f.owner, evidence))
      .rejects.toMatchObject({ code: 'REPEAT_TERMINAL_CONFLICT' })
    expect(await f.read()).toEqual(saved)
    return measured.statements
  }
  const single = await update(1)
  const batch = await update(16)
  console.info('history update statements', { single, batch })
  expect(batch).toBeLessThanOrEqual(single + 8)
}, 60_000)
