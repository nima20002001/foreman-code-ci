import { afterEach, expect, it } from 'vitest'
import { beginRuntimeTiming, runtimeTimingChannel, runtimeTimingPoint, timeRuntimeOperation,
  withRuntimeTimingContext, type RuntimeTimingRecord } from './runtimeTiming.js'

const records: RuntimeTimingRecord[] = []
const capture = (value: unknown) => records.push(value as RuntimeTimingRecord)
afterEach(() => {
  runtimeTimingChannel.unsubscribe(capture)
  records.length = 0
})

it('preserves the operation promise when timing is disabled', async () => {
  const result = { state: 'completed' }
  const operation = Promise.resolve(result)
  expect(timeRuntimeOperation('engine', 'completion', () => operation)).toBe(operation)
  expect(await operation).toBe(result)
})

it('reports a completed operation once without changing its result or failure', async () => {
  runtimeTimingChannel.subscribe(capture)
  const result = { state: 'completed' }
  expect(await timeRuntimeOperation('engine', 'success', async () => result)).toBe(result)
  const failure = new Error('operation refused')
  await expect(timeRuntimeOperation('engine', 'failure', async () => { throw failure })).rejects.toBe(failure)
  expect(records.map((record) => record.phase)).toEqual(['success', 'failure'])
  for (const record of records) {
    expect(record.durationMs).toBeGreaterThanOrEqual(0)
    expect(Date.parse(record.finishedAt)).toBeGreaterThanOrEqual(Date.parse(record.startedAt))
  }
})

it('keeps concurrent execution identities separate and captures context before completion', async () => {
  runtimeTimingChannel.subscribe(capture)
  const tasks = ['a', 'b'].map((executionId) => withRuntimeTimingContext({ runId: 'run', executionId }, async () => {
    await Promise.resolve()
    runtimeTimingPoint('harness', 'native.event', { eventType: 'turn.started' })
  }))
  await Promise.all(tasks)
  let finish!: () => void
  withRuntimeTimingContext({ runId: 'another-run', executionId: 'c' }, () => {
    finish = beginRuntimeTiming('db', 'transaction')
  })
  finish()
  finish()
  expect(records.map(({ runId, executionId }) => ({ runId, executionId }))).toEqual([
    { runId: 'run', executionId: 'a' }, { runId: 'run', executionId: 'b' },
    { runId: 'another-run', executionId: 'c' },
  ])
  expect(records[0]).toMatchObject({ component: 'harness', eventType: 'turn.started' })
})
