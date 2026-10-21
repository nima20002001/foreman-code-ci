import { afterEach, expect, it } from 'vitest'
import { runtimeTimingChannel, withRuntimeTimingContext, type RuntimeTimingRecord } from '../../infrastructure/runtimeTiming.js'
import { codexTransportTimings, openCodexRuntimeTiming } from './codexRuntimeTiming.js'

const records: RuntimeTimingRecord[] = []
const capture = (record: unknown) => records.push(record as RuntimeTimingRecord)
afterEach(() => { runtimeTimingChannel.unsubscribe(capture); records.length = 0 })

function payload() {
  return { resourceLogs: [{ scopeLogs: [{ logRecords: [{
    timeUnixNano: '1791215701000000000', body: { stringValue: 'codex.websocket_event' }, attributes: [
      { key: 'duration_ms', value: { doubleValue: 12_500 } },
      { key: 'kind', value: { stringValue: 'response.completed' } },
      { key: 'success', value: { boolValue: true } },
      { key: 'conversation.id', value: { stringValue: '00000000-0000-4000-8000-000000000001' } },
      { key: 'prompt', value: { stringValue: 'private prompt' } },
      { key: 'authorization', value: { stringValue: 'private credential' } },
    ],
  }] }] }] }
}

it('keeps native clock and duration while retaining only transport metadata', () => {
  expect(codexTransportTimings(payload())).toEqual([{ component: 'harness',
    phase: 'native.websocket_event', operation: 'codex.websocket_event',
    startedAt: '2026-10-05T15:54:48.500Z', finishedAt: '2026-10-05T15:55:01.000Z', durationMs: 12_500,
    eventType: 'response.completed', success: true, nativeSessionId: '00000000-0000-4000-8000-000000000001' }])
  const unsupported = payload()
  unsupported.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.body.stringValue = 'codex.tool_result'
  expect(codexTransportTimings(unsupported)).toEqual([])
  const malformed = payload()
  malformed.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.timeUnixNano = 'not a timestamp'
  expect(codexTransportTimings(malformed)).toEqual([])
})

it('accepts loopback metadata on its private endpoint and preserves the admission identity', async () => {
  runtimeTimingChannel.subscribe(capture)
  const receiver = await withRuntimeTimingContext({ runId: 'run', executionId: 'execution' }, openCodexRuntimeTiming)
  try {
    const response = await fetch(receiver.endpoint, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload()) })
    expect(response.status).toBe(200)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ runId: 'run', executionId: 'execution', durationMs: 12_500 })
    expect((await fetch(new URL('/different/v1/logs', receiver.endpoint), { method: 'POST' })).status).toBe(404)
    expect(records).toHaveLength(1)
  } finally { await receiver.close() }
})

it('reads the bundled transport event duration field and dotted event name', () => {
  const input = payload()
  const record = input.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!
  record.body.stringValue = 'codex.websocket.event'
  record.attributes[0]!.key = 'event.duration_ms'
  expect(codexTransportTimings(input)[0]).toMatchObject({ phase: 'native.websocket_event',
    durationMs: 12_500, eventType: 'response.completed' })
})
