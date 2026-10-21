import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import type { NativeHarnessEvent } from '@foreman-code/contracts'
import type { NativeHistory } from '../src/modules/harnesses/port.js'
import * as repair from '../src/modules/runs/workResultRepair.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('workflow native result repair lease', () => {
  it('publishes a reserved repair when correlation validation crosses the locked lane expiry', async () => {
    const fixture = makeCurrentWorkflowFixture(randomUUID(), 'single')
    fixture.version.definition.handoffs = { contractVersion: 1 }
    const data = { latestDeliverable: { summary: 'Corrected result' }, remainingFindings: [] }
    const f = await checkpointRuntimeFixture(1, 1, { fixture, approvalNodeIds: [],
      outputFor: () => ({ routing: { kind: 'finish', outcome: 'invalid-extra-field' }, data }) })
    const repaired = new Map<string, NativeHistory>()
    const submitted: string[] = []
    const startTurn = f.provider.startTurn.bind(f.provider)
    vi.spyOn(f.provider, 'startTurn').mockImplementation(async function* (session, input) {
      const correlationId = input.clientCorrelationId!
      if (!correlationId.includes(':result-repair:')) {
        yield* startTurn(session, input)
        return
      }
      submitted.push(correlationId)
      const turnId = 'corrective-turn'
      await input.onSubmitted?.(turnId)
      const event = (sequence: number, type: string): NativeHarnessEvent => ({ sequence, type,
        occurredAt: new Date().toISOString(), payload: { threadId: session.nativeSessionId,
          turnId, clientCorrelationId: correlationId, status: type === 'turn.completed' ? 'completed' : 'inProgress' } })
      const terminal = event(3, 'turn.completed')
      const result = { outcome: 'succeeded' as const, output: { routing: { kind: 'finish' }, data } }
      repaired.set(correlationId, { correlationId, events: [terminal], pendingInteractions: [],
        nativeTurnId: turnId, terminalResult: result, terminalTurn: { correlationId, providerId: turnId, result } })
      await f.db.pool.query(`update native_session_lanes set updated_at=clock_timestamp(),
        record=jsonb_set(record,'{leaseExpiresAt}',to_jsonb(to_char(
          (clock_timestamp()+interval '400 milliseconds') at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) where native_session_id=$1`, [session.nativeSessionId])
      yield event(2, 'turn.started')
      yield terminal
    })
    const reconcile = f.provider.reconcile.bind(f.provider)
    vi.spyOn(f.provider, 'reconcile').mockImplementation(async (session, correlationId) =>
      repaired.get(correlationId) ?? reconcile(session, correlationId))
    const assertCorrelation = repair.assertWorkflowCorrelation
    let delayed = false
    vi.spyOn(repair, 'assertWorkflowCorrelation').mockImplementation(async (sql, executionId, correlationId) => {
      if (!delayed && correlationId?.includes(':result-repair:')) {
        delayed = true
        await sql.query('select pg_sleep(0.6)')
      }
      await assertCorrelation(sql, executionId, correlationId)
    })
    try {
      await f.engine.start(f.f.run.id)
      expect(delayed).toBe(true)
      expect(submitted).toHaveLength(1)
      expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
      expect(f.provider.counts.sessions).toBe(1)
      const executions = (await f.runs.listRepeatExecutions(f.f.run.id)).map(item => item.execution)
      expect(executions).toHaveLength(1)
      expect(executions[0]).toMatchObject({ state: 'completed', result: {
        outcome: 'succeeded', output: { routing: { kind: 'finish' }, data },
      } })
      expect((await f.db.pool.query('select attempt from execution_work_result_repairs where execution_id=$1',
        [executions[0]!.id])).rows).toEqual([{ attempt: 1 }])
    } finally {
      await f.close()
    }
  }, 60_000)
})
