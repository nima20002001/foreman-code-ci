import type pg from 'pg'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, RunGraphScopeSchema, type NativeGraphCorrelationRecord } from '@foreman-code/contracts/wave25'
import { afterEach, expect, it, vi } from 'vitest'
import { didGraphTransactionCommit, ExclusiveGraphConnection, type GraphTransactionSql } from '../src/modules/run-graph/connection.js'
import { PostgresNativeGraphProjectionWriter } from '../src/modules/run-graph/nativeWriter.js'
import { appendWorkflowNativeGraphEventLocked } from '../src/modules/runs/workflowNativeGraph.js'
import * as ingestion from '../src/modules/run-graph/nativeIngestion.js'
import * as rawEvents from '../src/modules/runs/nativeEvents.js'
import * as records from '../src/modules/run-graph/records.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'

vi.mock('../src/modules/run-graph/publication.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/modules/run-graph/publication.js')>(), currentRunGraphPublication: () => ({}) }))
afterEach(() => vi.restoreAllMocks())

// SQL-only composition model. Actual private-capture/physical proof checks are
// exercised separately; this does not claim PostgreSQL or native process proof.
function fixture(type: string, expiresBeforeCommit = false, persistedSequences = new Map<number, string>()) {
  const { run, version } = makeCurrentWorkflowFixture('transcript-fast-path')
  const node = version.definition.nodes[0]!
  const execution = HarnessExecutionSchema.parse({ id: 'original-execution', runId: run.id,
    workflowNodeId: node.id, agentId: node.agentId,
    agentConfigurationVersionId: run.agentConfigurationVersionIds[node.agentId!], attempt: 1,
    input: {}, state: 'running', createdAt: run.createdAt, startedAt: run.createdAt,
    workingDirectory: '/owned/project', runtimeDirectory: '/owned/runtime', nativeSessionId: 'original-session' })
  const owner = { runId: run.id, assertOwned() {},
    readOneShotFence: async () => ({ ownerId: 'original-owner', fence: '1' }) } as unknown as RunOwnership
  const raw = vi.spyOn(rawEvents, 'appendNormalizedNativeEvent').mockResolvedValue({ inserted: true, rejected: false })
  const semantic = vi.spyOn(ingestion, 'appendNativeGraphEvent').mockResolvedValue({ rawInserted: false,
    projected: 0, rejected: 0, ignored: 1 })
  const correlations = new Map<string, NativeGraphCorrelationRecord>()
  vi.spyOn(records, 'readNativeGraphCorrelation').mockImplementation(async (_sql, _scope, _key, correlationKey) =>
    correlations.get(correlationKey))
  const correlation = vi.spyOn(PostgresNativeGraphProjectionWriter.prototype, 'persistCorrelation')
    .mockImplementation(async (_sql, _scope, _revision, value) => { correlations.set(value.correlationKey, structuredClone(value)) })
  vi.spyOn(records, 'readNativeGraphActivity').mockResolvedValue(undefined)
  const laneRecord: { leaseToken: string; leaseExpiresAt: string; connectionGeneration: number;
    correlationId?: string } = {
    leaseToken: 'original-lease', leaseExpiresAt: '2099-01-01T00:00:00Z', connectionGeneration: 1,
  }
  let transaction: GraphTransactionSql | undefined
  const connection = new ExclusiveGraphConnection({ query: async (sql: string, values: unknown[]) => {
    if (sql.startsWith('select sequence::text from harness_native_events')) {
      const position = values[2] as number
      return { rows: [{ sequence: persistedSequences.get(position) ?? String(position) }], rowCount: 1 }
    }
    if (sql.startsWith('select correlation_key,first_native_sequence::text from run_native_correlations')) {
      const base = values[2] as string
      const candidates = [...correlations.values()].filter(value => value.nativeRequestId === null
        && value.interactionId === null
        && (value.correlationKey === base || value.correlationKey.startsWith(`${base}:retry:`)))
        .sort((left, right) => Number(BigInt(right.firstNativeSequence) - BigInt(left.firstNativeSequence)))
      return { rows: candidates.map(value => ({ correlation_key: value.correlationKey,
        first_native_sequence: value.firstNativeSequence })), rowCount: candidates.length }
    }
    if (sql.startsWith('delete from run_native_projection_checkpoints')) return { rows: [], rowCount: 1 }
    if (sql.startsWith('select record from runs')) return { rows: [{ record: run }], rowCount: 1 }
    if (sql.startsWith('select record from harness_executions')) return { rows: [{ record: execution }], rowCount: 1 }
    if (sql.includes('select record,harness,native_session_id')) return { rows: [{ record: laneRecord,
    live: true, harness: 'codex', native_session_id: execution.nativeSessionId, owner_agent_id: execution.agentId }], rowCount: 1 }
    if (sql.startsWith('select 1 from native_session_lanes')) return { rows: [], rowCount: expiresBeforeCommit ? 0 : 1 }
    if (['commit', 'rollback'].includes(sql) || sql.startsWith('begin')) return { rows: [], rowCount: 0 }
    throw new Error(`Unexpected composition SQL: ${sql}`)
  } } as unknown as pg.ClientBase, () => owner.assertOwned())
  const event = { executionId: execution.id, connectionId: 'original-connection', sequence: 1,
    occurredAt: run.createdAt, type, payload: { text: 'original transcript', turnId: 'original-turn' } }
  const append = () => connection.transaction((sql) => {
    transaction = sql
    return appendWorkflowNativeGraphEventLocked(sql, owner, event,
      { id: 'original-lane', token: 'original-lease', live: true,
        ...(event.type === 'turn.capacity_retry' ? {} : { providerId: event.payload.turnId }) })
  })
  const appendCaptured = (mismatch?: 'transaction' | 'run' | 'execution') => connection.transaction((sql) => {
    const context = { sql, execution, scope: RunGraphScopeSchema.parse({
      workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id,
      workflowVersionId: run.workflowVersionId, executionSemanticsVersion: 3,
    }) }
    if (mismatch === 'transaction') context.sql = { ...sql }
    if (mismatch === 'run') context.scope = { ...context.scope, runId: 'another-run' }
    if (mismatch === 'execution') context.execution = { ...execution, id: 'another-execution' }
    return appendWorkflowNativeGraphEventLocked(sql, owner, event,
      { id: 'original-lane', token: 'original-lease', providerId: 'original-turn', live: true },
      undefined, undefined, context)
  })
  return { append, appendCaptured, raw, semantic, correlation, correlations, event, laneRecord,
    committed: () => transaction !== undefined && didGraphTransactionCommit(transaction) }
}

it('preserves the failed native correlation and records a separate capacity retry', async () => {
  const f = fixture('turn.started')
  await f.append()
  const original = structuredClone([...f.correlations.values()][0]!)
  f.event.type = 'turn.capacity_retry'
  f.event.sequence = 2
  await f.append()
  expect(f.committed()).toBe(true)
  expect(f.correlations.get(original.correlationKey)).toEqual(original)
  expect([...f.correlations.values()][1]).toMatchObject({
    nativeSessionId: original.nativeSessionId, nativeTurnId: null,
    firstNativeSequence: '2', lastNativeSequence: '2', terminalNativeSequence: null,
  })
})

it.each([false, true])('publishes first, capacity retry, and repair turns with a lane correlation present: %s', async bound => {
  const f = fixture('turn.started')
  const firstKey = 'execution:original-execution'
  if (bound) f.laneRecord.correlationId = firstKey
  const publish = async (type: string, turnId: string, key: string) => {
    f.event.type = type
    f.event.payload.turnId = turnId
    await f.append()
    expect(f.semantic.mock.lastCall?.[2]?.[0]?.correlationKey).toBe(key)
    expect(f.correlations.get(key)).toMatchObject({ nativeTurnId: turnId })
    f.event.sequence += 1
  }
  const retry = async (turnId: string) => {
    f.event.type = 'turn.capacity_retry'
    f.event.payload.turnId = turnId
    await f.append()
    f.event.sequence += 1
  }

  await publish('turn.started', 'original-turn', firstKey)
  const original = structuredClone(f.correlations.get(firstKey))
  await retry('original-turn')
  const firstRetryKey = `${firstKey}:retry:original-turn`
  await publish('turn.started', 'capacity-turn', firstRetryKey)
  const capacity = structuredClone(f.correlations.get(firstRetryKey))
  await retry('capacity-turn')
  await publish('turn.started', 'capacity-turn-2', `${firstKey}:retry:capacity-turn`)

  for (const attempt of [1, 2]) {
    const repairKey = `${firstKey}:result-repair:${attempt}`
    f.laneRecord.correlationId = repairKey
    const turnId = `repair-turn-${attempt}`
    await publish('turn.started', turnId, repairKey)
    const repair = structuredClone(f.correlations.get(repairKey))
    await retry(turnId)
    const repairRetryKey = `${repairKey}:retry:${turnId}`
    await publish('turn.started', `repair-capacity-turn-${attempt}`, repairRetryKey)
    await publish('turn.completed', `repair-capacity-turn-${attempt}`, repairRetryKey)
    expect(f.correlations.get(repairKey)).toEqual(repair)
  }
  expect(f.correlations.get(firstKey)).toEqual(original)
  expect(f.correlations.get(firstRetryKey)).toEqual(capacity)
})

it('retains the original transcript and correlation without redundant semantic ingestion', async () => {
  const f = fixture('native.notification'); await f.append()
  expect(f.raw).toHaveBeenCalledOnce()
  expect(f.raw.mock.calls[0]![1].event).toEqual(f.event)
  expect(f.correlation).toHaveBeenCalledOnce()
  expect(f.semantic).not.toHaveBeenCalled()
  expect(f.committed()).toBe(true)
})

for (const type of ['turn.started', 'transport.disconnected']) it(`still ingests ${type} evidence`, async () => {
  const f = fixture(type); await f.append()
  expect(f.semantic).toHaveBeenCalledOnce()
})

it('still rejects an expired original lane before committing a transcript', async () => {
  const f = fixture('native.notification', true)
  await expect(f.append()).rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
  expect(f.committed()).toBe(false)
})

it('retains the same captured transcript and correlation when reusing its validated context', async () => {
  const f = fixture('native.notification')
  await f.appendCaptured()
  expect(f.raw.mock.calls[0]![1].event).toEqual(f.event)
  expect(f.correlation).toHaveBeenCalledOnce()
  expect(f.semantic).not.toHaveBeenCalled()
})

it.each(['transaction', 'run', 'execution'] as const)('rejects reused context for another %s before persisting', async mismatch => {
  const f = fixture('native.notification')
  await expect(f.appendCaptured(mismatch)).rejects.toMatchObject({ code: 'GRAPH_SCOPE_MISMATCH' })
  expect(f.raw).not.toHaveBeenCalled()
  expect(f.correlation).not.toHaveBeenCalled()
})

it('revalidates lane expiry before commit after reusing a captured context', async () => {
  const f = fixture('native.notification', true)
  await expect(f.appendCaptured()).rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
  expect(f.raw.mock.calls[0]![1].event).toEqual(f.event)
})


it('initializes transcript and capacity retry boundaries at their persisted positions', async () => {
  const f = fixture('native.notification', false, new Map([[100, '3'], [180, '8']]))
  f.event.sequence = 100
  await f.append()
  const original = structuredClone([...f.correlations.values()][0]!)
  expect(original).toMatchObject({ firstNativeSequence: '3', lastNativeSequence: '3' })
  f.event.type = 'turn.capacity_retry'
  f.event.sequence = 180
  await f.append()
  expect(f.correlations.get(original.correlationKey)).toEqual(original)
  expect([...f.correlations.values()][1]).toMatchObject({
    firstNativeSequence: '8', lastNativeSequence: '8', terminalNativeSequence: null,
  })
})
