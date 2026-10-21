import { beforeGraphCommit, beforeGraphCommitChecks, isGraphTransactionFinalizing, type GraphSqlClient, type GraphTransactionSql } from './connection.js'
import { RunGraphError } from './errors.js'

/** Authority and projection state for ONE native batch transaction.
 * Reads are fetched once; writes are staged here and flushed as multi-row statements
 * before finalization. Finalizers never use this state: once the batch closes, every
 * COMMIT check reads live and each distinct check runs exactly once. */
export interface NativeBatch {
  readonly sql: GraphTransactionSql
  readonly runId: string
  /** Native appends made once for the whole group, in frame order, keyed by source identity. */
  readonly appended: Map<string, { inserted: boolean; rejected: boolean; sequence: string }>
  readonly reads: Map<string, Promise<unknown>>
  readonly staged: Map<string, StagedNativeRow>
  readonly commitChecks: Map<string | object, () => Promise<void>>
  readonly collected: Map<string | object, { expected: unknown[]; verify: (expected: readonly unknown[]) => Promise<void> }>
  closed: boolean
}
/** `expected` is the database revision that the first staged write was based on (null: insert).
 * `value` is the latest state; `dirty` rows still have to reach the database in one flush. */
export interface StagedNativeRow { kind: 'correlation' | 'activity' | 'checkpoint'; expected: string | null; value: unknown; dirty: boolean }

const batches = new WeakMap<GraphSqlClient, NativeBatch>()
export const WORKFLOW_CORRELATION_READ_PREFIX = 'latest-workflow-correlation:'

export function openNativeBatch(sql: GraphTransactionSql, runId: string): NativeBatch {
  if (batches.has(sql)) throw new RunGraphError('GRAPH_TRANSACTION_NESTED')
  const batch: NativeBatch = { sql, runId, appended: new Map(), reads: new Map(), staged: new Map(), commitChecks: new Map(), collected: new Map(), closed: false }
  batches.set(sql, batch)
  return batch
}

export function hasNativeBatch(sql: GraphSqlClient): boolean { return batches.has(sql) }

/** Only an open batch on a live (non-finalizing) transaction may serve memoized state. */
export function activeNativeBatch(sql: GraphSqlClient): NativeBatch | undefined {
  const batch = batches.get(sql)
  return batch && !batch.closed && !isGraphTransactionFinalizing(sql as GraphTransactionSql) ? batch : undefined
}

function appendKey(event: { executionId: string; connectionId?: string | undefined; sequence: number }): string {
  return JSON.stringify([event.executionId, event.connectionId ?? null, event.sequence])
}

export function rememberNativeAppend(sql: GraphSqlClient, event: { executionId: string; connectionId?: string | undefined; sequence: number },
  result: { inserted: boolean; rejected: boolean; sequence: string }): void {
  const batch = activeNativeBatch(sql)
  if (batch) batch.appended.set(appendKey(event), result)
}

/** The group's native append result for this frame, when the batch already performed it. */
export function prefetchedNativeAppend(sql: GraphSqlClient, event: { executionId: string; connectionId?: string | undefined; sequence: number }) {
  return activeNativeBatch(sql)?.appended.get(appendKey(event))
}

/** Seeds a read that the batch already performed for a group, so per-frame callers hit the memo. */
export function seedNativeRead<T>(sql: GraphSqlClient, key: string, value: T): void {
  const batch = activeNativeBatch(sql)
  if (batch && !batch.reads.has(key)) batch.reads.set(key, Promise.resolve(value))
}

/** Read once per batch. Outside an active batch the read is performed directly. */
export function memoizeNativeRead<T>(sql: GraphSqlClient, key: string, read: () => Promise<T>): Promise<T> {
  const batch = activeNativeBatch(sql)
  if (!batch) return read()
  let value = batch.reads.get(key)
  if (!value) {
    value = read()
    batch.reads.set(key, value)
  }
  return value as Promise<T>
}

/** Keep the first expected database revision and the latest value. Flush writes that once. */
export function stageNativeRow(batch: NativeBatch, id: string,
  row: { kind: StagedNativeRow['kind']; expected: string | null; value: unknown }): void {
  const previous = batch.staged.get(id)
  batch.staged.set(id, previous ? { ...previous, value: row.value, dirty: true } : { ...row, dirty: true })
}

/** A direct statement that changes a row forgets its staged copy and any memoized read of it. */
export function forgetNativeRow(batch: NativeBatch, id: string): void {
  batch.staged.delete(id)
  batch.reads.delete(`row:${id}`)
}

/** Per-frame COMMIT verifications collapse to one live check per key at finalization. */
export function nativeCommitCheck(sql: GraphTransactionSql, key: string, verify: () => Promise<void>): void {
  const batch = activeNativeBatch(sql)
  if (!batch) {
    beforeGraphCommit(sql, verify)
    return
  }
  if (!batch.commitChecks.has(key)) batch.commitChecks.set(key, verify)
}

const identityTokens = new Map<string, object>()

/** Per-call expectations for one COMMIT check share a single live verification that sees all of them. */
export function nativeCommitCollect<T>(sql: GraphTransactionSql, key: string | object, expected: T,
  verify: (expected: readonly T[]) => Promise<void>): void {
  const batch = activeNativeBatch(sql)
  if (!batch) {
    beforeGraphCommitChecks(sql, typeof key === 'string' ? tokenFor(key) : key, expected, verify)
    return
  }
  let entry = batch.collected.get(key)
  if (!entry) {
    const created = { expected: [] as unknown[], verify: verify as (expected: readonly unknown[]) => Promise<void> }
    entry = created
    batch.collected.set(key, created)
    batch.commitChecks.set(key, () => created.verify(created.expected))
  }
  entry.expected.push(expected)
}

function tokenFor(key: string): object {
  let token = identityTokens.get(key)
  if (!token) {
    token = {}
    identityTokens.set(key, token)
  }
  return token
}

/** Flush staged rows, close the batch, and register the single live COMMIT check. */
export async function finishNativeBatch(batch: NativeBatch, flush: () => Promise<void>): Promise<void> {
  await flush()
  batch.closed = true
  const checks = [...batch.commitChecks.values()]
  beforeGraphCommit(batch.sql, async () => {
    for (const verify of checks) await verify()
  })
}

/** Idempotent; a failed or finished batch never serves memoized state again. */
export function closeNativeBatch(batch: NativeBatch): void {
  batch.closed = true
  batches.delete(batch.sql)
}
