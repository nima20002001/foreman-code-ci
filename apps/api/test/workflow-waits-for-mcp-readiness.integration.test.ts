import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HarnessNativeEvent } from '@foreman-code/contracts'
import { faultWorkflowFixture, expectRecoveredFault } from './helpers/faultWorkflowFixture.js'
import { readUntil } from './helpers/observableCondition.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.runIf(postgresEnabled)('workflow MCP startup readiness', () => {
  let fixture: Awaited<ReturnType<typeof faultWorkflowFixture>>
  beforeAll(async () => { fixture = await faultWorkflowFixture({ mcpUnavailable: true }) }, 10_000)
  afterAll(async () => { await fixture?.close() }, 10_000)

  // A temporarily unavailable Foreman Code MCP server must be retried before native turn entry.
  it('waits for Foreman Code MCP at turn start and then completes', async () => {
    await fixture.launch()
    await readUntil(fixture.mcpInspections, count => count > 0,
      { timeoutMs: 4_000, get description() {
        return `the unavailable Foreman Code MCP inspection: ${fixture.startupDescription}`
      } })
    const before = await fixture.read()
    expect(before.executions.filter(execution => execution.workflowNodeId === fixture.affected.id)
      .every(execution => !fixture.worker.replay.starts.some(turn =>
        turn.correlationId === `execution:${execution.id}`))).toBe(true)
    const waiting = await readUntil(() => fixture.base.runs.listActivity(fixture.base.f.run.id),
      activity => activity.some(value => value.payload.nativeEventType === 'turn.mcp_startup_retry'),
    { timeoutMs: 4_000, description: 'the native MCP startup retry' })
    const retry = waiting.find(activity => activity.payload.nativeEventType === 'turn.mcp_startup_retry')!
    const native = (await fixture.base.db.pool.query<{ record: HarnessNativeEvent }>(
      'select record from harness_native_events where execution_id=$1 and sequence=$2',
      [retry.harnessExecutionId, retry.payload.nativeEventSequence])).rows[0]!.record
    expect(native).toMatchObject({ type: 'turn.mcp_startup_retry', payload: { attempt: 2, delayMs: 10_000 } })
    await fixture.makeMcpReady(Number(native.payload.delayMs))
    fixture.release()
    expectRecoveredFault(await fixture.finished(), fixture, /mcp|readiness|unavailable|retry/i)
  }, 18_000)
})
