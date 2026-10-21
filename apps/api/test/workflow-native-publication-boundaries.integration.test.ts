import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HarnessNativeEvent, NativeHarnessEvent } from '@foreman-code/contracts'
import { appendNormalizedNativeEvent } from '../src/modules/runs/nativeEvents.js'
import { normalizeNativeProducerEvent } from '../src/modules/run-graph/nativeProducerNormalization.js'
import { PostgresInteractionCoordinationRepository } from '../src/modules/interactions/coordination.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('workflow native publication boundaries', () => {
  it('uses persisted positions across provider gaps, other connections and ignored initial frames', async () => {
    const f = await checkpointRuntimeFixture(1, 1, { approvalNodeIds: [],
      nativeSourcePersisted: async (sql, _evidence, source) => {
        if (source.original.type !== 'session_created') return
        await appendNormalizedNativeEvent(sql, normalizeNativeProducerEvent({ executionId: source.execution.executionId, connectionId: 'another-connection',
          sequence: 700, type: 'native.notification', occurredAt: source.observedAt, payload: {} }))
      } })
    const start = f.provider.startTurn.bind(f.provider)
    const remap = (event: NativeHarnessEvent): NativeHarnessEvent => ({ ...event,
      connectionId: 'provider-connection', sequence: 100 + event.sequence * 10 })
    vi.spyOn(f.provider, 'startTurn').mockImplementation(async function* (session, input) {
      let first = true
      for await (const event of start(session, input)) {
        if (first) {
          first = false
          yield { ...remap(event), sequence: 90, type: 'native.notification', payload: {} }
        }
        yield remap(event)
      }
    })
    const reconcile = f.provider.reconcile.bind(f.provider)
    vi.spyOn(f.provider, 'reconcile').mockImplementation(async (...args) => {
      const history = await reconcile(...args)
      return { ...history, events: history.events.map(remap) }
    })
    try {
      await f.engine.start(f.f.run.id)
      expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
      const rows = (await f.db.pool.query<{ first: string; last: string; terminal: string }>(
        `select first_native_sequence::text as first,last_native_sequence::text as last,
          terminal_native_sequence::text as terminal from run_native_correlations where run_id=$1
          and work_kind='workflow' and native_request_id is null`, [f.f.run.id])).rows
      expect(rows).toHaveLength(2)
      for (const row of rows) expect(row).toEqual({ first: '1', last: '3', terminal: '3' })
      const events = (await f.db.pool.query<{ record: HarnessNativeEvent; source_sequence: number }>(
        `select n.record,n.source_sequence from harness_native_events n join harness_executions e
          on e.id=n.execution_id where e.run_id=$1 order by e.id,n.sequence`, [f.f.run.id])).rows
      expect(events.map(event => event.source_sequence)).toEqual([700, 90, 100, 110, 700, 90, 100, 110])
    } finally { await f.close() }
  }, 60_000)

  it('commits retained history after the locked lane crosses its expiry', async () => {
    let delayed = false
    let renewal: Promise<unknown> | undefined
    let renewalError: unknown
    const f = await checkpointRuntimeFixture(1, 1, { approvalNodeIds: [],
      nativeSourcePersisted: async (sql, _evidence, source) => {
        if (delayed || source.original.type !== 'history') return
        delayed = true
        const lane = (await sql.query<{ owner: string }>(
          "select record->>'leaseOwner' as owner from native_session_lanes where id=$1", [source.lane!.id])).rows[0]!
        renewal = coordination.renewLane(source.lane!.id, source.lane!.token, 400, {
          owner: lane.owner, connectionGeneration: source.lane!.connectionGeneration,
        }).catch(error => { renewalError = error })
        await sql.query('select pg_sleep(0.6)')
      } })
    const coordination = new PostgresInteractionCoordinationRepository(f.db.pool)
    const reconcile = f.provider.reconcile.bind(f.provider)
    let shortened = false
    vi.spyOn(f.provider, 'reconcile').mockImplementation(async (...args) => {
      const history = await reconcile(...args)
      if (!shortened && history.terminalTurn) {
        shortened = true
        await f.db.pool.query(`update native_session_lanes set updated_at=clock_timestamp(),
          record=jsonb_set(record,'{leaseExpiresAt}',to_jsonb(to_char(
            (clock_timestamp()+interval '400 milliseconds') at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) where native_session_id=$1`, [args[0].nativeSessionId])
      }
      return history
    })
    try {
      await f.engine.start(f.f.run.id)
      expect(delayed).toBe(true)
      await renewal
      expect(renewalError).toMatchObject({ code: 'SESSION_LANE_RENEWAL_BUSY' })
      expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
      expect(f.provider.counts.starts).toBe(2)
      expect((await f.db.pool.query(`select 1 from workflow_native_proofs where run_id=$1
        and record->'original'->>'type'='history'`, [f.f.run.id])).rowCount).toBeGreaterThan(0)
    } finally { await renewal; await f.close() }
  }, 60_000)

  it.each(['leaseToken', 'connectionGeneration', 'runOwner'] as const)('rejects a changed %s during retained history publication', async field => {
    let changed = false
    const f = await checkpointRuntimeFixture(1, 1, { approvalNodeIds: [],
      nativeSourcePersisted: async (sql, _evidence, source) => {
        if (changed || source.original.type !== 'history') return
        changed = true
        if (field === 'runOwner') {
          await sql.query('select pg_advisory_unlock(810002,hashtext($1))', [source.scope.runId])
          return
        }
        await sql.query(`update native_session_lanes set record=jsonb_set(record,ARRAY[$2::text],$3::jsonb)
          where native_session_id=$1`, [source.session.nativeSessionId, field,
        JSON.stringify(field === 'leaseToken' ? 'replacement-token' : 999)])
      } })
    try {
      await expect(f.engine.start(f.f.run.id)).rejects.toMatchObject({
        code: field === 'runOwner' ? 'RUN_OWNERSHIP_LOST' : 'SESSION_LANE_LEASE_LOST' })
      expect(changed).toBe(true)
      expect((await f.db.pool.query(`select 1 from workflow_native_proofs where run_id=$1
        and record->'original'->>'type'='history'`, [f.f.run.id])).rowCount).toBe(0)
      expect(f.provider.counts.starts).toBe(1)
    } finally { await f.close() }
  }, 60_000)
})
