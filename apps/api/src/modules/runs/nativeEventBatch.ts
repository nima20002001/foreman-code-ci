import { HarnessNativeEventSchema, type HarnessNativeEvent } from '@foreman-code/contracts'
import { assertGraphTransaction, type GraphTransactionSql } from '../run-graph/connection.js'
import { normalizeNativeProducerEvent, NATIVE_PRODUCER_REJECTION_TYPE, NATIVE_PRODUCER_REJECTION_VERSION,
  type NormalizedNativeProducerEvent } from '../run-graph/nativeProducerNormalization.js'
import { DomainError } from '../errors.js'
import { sameRepeatValue } from './repeatResolution.js'

interface ExecutionAllocator { id: string; next_sequence: string }
interface EventRow { execution_id: string; sequence: number; connection_id: string | null;
  source_sequence: number | null; record: HarnessNativeEvent }
interface EventInsert extends EventRow { ordinal: number }
export interface NativeEventAppendResult { inserted: boolean; rejected: boolean; sequence: string }
const sourceKey = (event: Pick<HarnessNativeEvent, 'executionId' | 'connectionId' | 'sequence'>) =>
  JSON.stringify([event.executionId, event.connectionId, event.sequence])
const positionKey = (executionId: string, sequence: number) => JSON.stringify([executionId, sequence])

function conflict(): never {
  throw new DomainError('NATIVE_EVENT_IDENTITY_CONFLICT', 'The native source identity is already bound to different history.', 409)
}
function allocateEvents(input: readonly NormalizedNativeProducerEvent[], allocators: readonly ExecutionAllocator[],
  saved: readonly EventRow[]) {
  const positions = new Map(saved.map(row => [positionKey(row.execution_id, row.sequence), row]))
  const sources = new Map(saved.filter(row => row.connection_id !== null).map(row => [
    sourceKey({ executionId: row.execution_id, connectionId: row.connection_id!, sequence: row.source_sequence! }), row,
  ]))
  const next = new Map(allocators.map(row => [row.id, BigInt(row.next_sequence)]))
  const inserts: EventInsert[] = []
  const results = input.map(({ event, rejected }, ordinal) => {
    const existing = event.connectionId === undefined
      ? positions.get(positionKey(event.executionId, event.sequence)) : sources.get(sourceKey(event))
    if (existing) {
      const original = event.connectionId === undefined ? existing.record : { ...existing.record, sequence: event.sequence }
      const previouslyRejected = existing.record.type === NATIVE_PRODUCER_REJECTION_TYPE
        && existing.record.payload.normalization === NATIVE_PRODUCER_REJECTION_VERSION
      if (existing.connection_id === (event.connectionId ?? null)
        && (previouslyRejected || rejected && normalizeNativeProducerEvent(original).rejected)) {
        return { inserted: false, rejected: true, sequence: String(existing.sequence) }
      }
      if (!sameRepeatValue(original, event)) return conflict()
      return { inserted: false, rejected, sequence: String(existing.sequence) }
    }
    const counter = next.get(event.executionId)
    if (counter === undefined) throw Object.assign(new Error('The native event execution does not exist.'), { code: '23503' })
    const sequence = event.connectionId === undefined ? BigInt(event.sequence) : counter
    if (sequence > 2147483647n) throw Object.assign(new Error('Native event sequence is out of range.'), { code: '22003' })
    next.set(event.executionId, counter > sequence ? counter : sequence + 1n)
    const stored = { ...event, sequence: Number(sequence) }
    const row = { execution_id: event.executionId, sequence: Number(sequence),
      connection_id: event.connectionId ?? null, source_sequence: event.connectionId === undefined ? null : event.sequence,
      record: stored }
    positions.set(positionKey(event.executionId, stored.sequence), row)
    if (event.connectionId !== undefined) sources.set(sourceKey(event), row)
    inserts.push({ ordinal, ...row })
    return { inserted: true, rejected, sequence: String(sequence) }
  })
  return { inserts, results, next }
}

/** Lock each allocator once; validate all replays before allocating or inserting any rows. */
export async function appendNormalizedNativeEvents(sql: GraphTransactionSql,
  input: readonly NormalizedNativeProducerEvent[]): Promise<NativeEventAppendResult[]> {
  assertGraphTransaction(sql)
  if (!input.length) return []
  const events = input.map(normalized => {
    const event = HarnessNativeEventSchema.parse(normalized.event)
    if (!Number.isSafeInteger(event.sequence) || event.sequence > 2147483647) {
      throw new DomainError('GRAPH_EVIDENCE_INVALID', 'The native source sequence must fit the durable integer identity.', 409)
    }
    return { ...normalized, event }
  })
  const saved = (await sql.query<{ allocators: ExecutionAllocator[]; events: EventRow[] }>(
    'select allocators,events from read_harness_native_event_batch($1::jsonb)',
    [JSON.stringify(events.map(({ event }) => ({
      execution_id: event.executionId, connection_id: event.connectionId ?? null, source_sequence: event.sequence,
    })))])).rows[0]!
  const batch = allocateEvents(events, saved.allocators, saved.events)
  if (!batch.inserts.length) return batch.results
  const changedExecutions = new Set(batch.inserts.map(row => row.execution_id))
  await sql.query(`with proposed as materialized (
      select * from jsonb_to_recordset($2::jsonb)
        as p(ordinal integer,execution_id text,sequence integer,record jsonb,connection_id text,source_sequence integer)
    ), allocated as (
      update harness_executions e set native_event_next_sequence=a.next_sequence
      from jsonb_to_recordset($1::jsonb) as a(id text,next_sequence bigint) where e.id=a.id returning e.id,e.run_id
    ), appended as (
      insert into harness_native_events(execution_id,sequence,record,connection_id,source_sequence)
      select p.execution_id,p.sequence,p.record,p.connection_id,p.source_sequence
      from proposed p join allocated a on a.id=p.execution_id order by p.ordinal returning execution_id,sequence,record
    ) insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
      select a.run_id,'harness','harness_output',n.execution_id,(n.record->>'occurredAt')::timestamptz,
        jsonb_build_object('nativeEventSequence',n.sequence,'nativeEventType',n.record->>'type')
      from appended n join allocated a on a.id=n.execution_id
      join proposed p on p.execution_id=n.execution_id and p.sequence=n.sequence
      where coalesce(n.record#>>'{payload,nativeMethod}',n.record#>>'{payload,method}','') not in (
        'item/agentMessage/delta','item/commandExecution/outputDelta','item/fileChange/outputDelta',
        'item/reasoning/textDelta','item/reasoning/summaryTextDelta','item/reasoning/summaryPartAdded',
        'item/mcpToolCall/progress','thread/tokenUsage/updated','account/rateLimits/updated')
      order by p.ordinal`, [JSON.stringify([...batch.next].filter(([id]) => changedExecutions.has(id))
      .map(([id, next]) => ({ id, next_sequence: String(next) }))),
    JSON.stringify(batch.inserts)])
  return batch.results
}
