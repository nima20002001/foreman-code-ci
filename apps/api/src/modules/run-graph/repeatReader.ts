import { readPublicProjectionLocked } from './compactSnapshot.js'
import { assertPublicProjectionCommittedLocked } from './publicProjectionReceipt.js'
import type pg from 'pg'
import {
  GraphSequenceSchema, RUN_GRAPH_LIMITS, RepeatGraphReadRequestV3Schema, RepeatGraphEventsRequestV3Schema,
  RepeatGraphBatchV3Schema, RepeatGraphPageV3Schema, RepeatGraphResetV3Schema, RepeatGraphCurrentV3Schema,
  RepeatGraphStateV3Schema, repeatGraphTopologyV3, sortRepeatGraphState, validateRepeatGraphSnapshotV3,
  graphJsonBytes, canonicalGraphJson, sameCanonicalGraphScope,
  type RepeatGraphScopeV3, type RepeatGraphSnapshotV3, type RepeatGraphPageV3, type RepeatGraphResetV3,
  type RepeatGraphBatchV3,
} from '@foreman-code/contracts/wave25'
import { withExclusiveGraphConnection, type GraphTransactionSql } from './connection.js'
import { RunGraphError } from './errors.js'
import {
  readRecordedRepeatGraphPinsLocked, readRepeatRunStateLocked, readRepeatGraphOccurrencesLocked,
  readRepeatGraphExecutionsLocked, readRepeatGraphBindingsLocked, readRepeatGraphResolutionsLocked,
  readRepeatGraphResultsLocked, readRepeatGraphDecisionsLocked,
} from './repeatProjectionRows.js'
import { assertRepeatGraphCommittedState, assertRepeatGraphBatchesCommitted } from './repeatProjectionProof.js'

/** Inject the existing authenticated Run read policy in BOTH HTTP and Operator
 * MCP. Never replace this with permission=true, a service principal or a cached
 * workflow read. These entry points do not enable the v3 rollout themselves. */
export type AuthorizeRepeatGraphRead = (sql: GraphTransactionSql, scope: RepeatGraphScopeV3) => Promise<void>
export interface RepeatGraphHead {
  head_sequence: string; retention_floor: string; protocol_version: number;
  history_coverage: 'from_admission' | 'from_snapshot';
}
async function authorizedHead(sql: GraphTransactionSql, scope: RepeatGraphScopeV3,
  authorize: AuthorizeRepeatGraphRead): Promise<RepeatGraphHead> {
  if (typeof authorize !== 'function') throw new RunGraphError('GRAPH_READ_ACCESS_DENIED')
  try { await authorize(sql, scope) } catch { throw new RunGraphError('GRAPH_READ_ACCESS_DENIED') }
  const rows = await sql.query<RepeatGraphHead>(`select h.head_sequence::text,h.retention_floor::text,h.protocol_version,h.history_coverage
    from runs r join workflow_versions v on v.id=r.workflow_version_id left join run_graph_heads h on h.run_id=r.id
    where r.id=$1 and r.workspace_id=$2 and r.workflow_id=$3 and r.workflow_version_id=$4
      and v.execution_semantics_version=3 and v.workspace_id=r.workspace_id and v.workflow_id=r.workflow_id`,
  [scope.runId, scope.workspaceId, scope.workflowId, scope.workflowVersionId])
  const head = rows.rows[0]
  if (rows.rows.length !== 1 || !head) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
  if (head.head_sequence === null) throw new RunGraphError('GRAPH_NOT_INITIALIZED')
  if (head.protocol_version !== 1) throw new RunGraphError('GRAPH_UNSUPPORTED_PROTOCOL')
  if (!GraphSequenceSchema.safeParse(head.head_sequence).success || !GraphSequenceSchema.safeParse(head.retention_floor).success
    || BigInt(head.retention_floor) > BigInt(head.head_sequence)
    || !['from_admission', 'from_snapshot'].includes(head.history_coverage)) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
  return head
}
function readRequest(input: unknown) {
  if (typeof input !== 'object' || input === null || !('protocolVersion' in input) || input.protocolVersion !== 1) {
    throw new RunGraphError('GRAPH_UNSUPPORTED_PROTOCOL')
  }
  const result = RepeatGraphReadRequestV3Schema.safeParse(input)
  if (!result.success) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
  return result.data
}
function reset(scope: RepeatGraphScopeV3, requestedSequence: string, head: RepeatGraphHead,
  reason: RepeatGraphResetV3['reason']): RepeatGraphResetV3 {
  return RepeatGraphResetV3Schema.parse({ kind: 'reset', protocolVersion: 1, scope, requestedSequence,
    headSequence: head.head_sequence, retentionFloor: head.retention_floor, reason, action: 'fetch_snapshot' })
}

/** Reused by snapshot AND delta, including an empty delta. Otherwise a
 * domain update missing publication could masquerade as a complete empty page.
 * One bounded primary repeatable-read cut; no second source of live facts. */
async function verifiedRepeatCut(sql: GraphTransactionSql, scope: RepeatGraphScopeV3, head: RepeatGraphHead): Promise<RepeatGraphSnapshotV3> {
  try {
    const { version } = await readRecordedRepeatGraphPinsLocked(sql, scope)
    const run = await readRepeatRunStateLocked(sql, scope)
    const occurrences = await readRepeatGraphOccurrencesLocked(sql, scope)
    const executions = await readRepeatGraphExecutionsLocked(sql, scope, { version })
    const bindings = await readRepeatGraphBindingsLocked(sql, scope, undefined, executions)
    const resolutions = await readRepeatGraphResolutionsLocked(sql, scope)
    const results = await readRepeatGraphResultsLocked(sql, scope, executions)
    const decisions = await readRepeatGraphDecisionsLocked(sql, scope)
    const publicView = await readPublicProjectionLocked(sql, scope, version)
    await assertPublicProjectionCommittedLocked(sql, scope, head.head_sequence, readPublicProjectionLocked, publicView)
    const data = { ...publicView, run, occurrences, executions, bindings, resolutions, results, decisions }
    if (graphJsonBytes(data) > RUN_GRAPH_LIMITS.snapshotBytes) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
    const state = sortRepeatGraphState(RepeatGraphStateV3Schema.parse(data))
    const candidate = { kind: 'snapshot' as const, protocolVersion: 1 as const, scope,
      asOfSequence: head.head_sequence, retentionFloor: head.retention_floor, historyCoverage: head.history_coverage,
      topology: repeatGraphTopologyV3(version), state }
    if (graphJsonBytes(candidate) > RUN_GRAPH_LIMITS.snapshotBytes) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
    const snapshot = validateRepeatGraphSnapshotV3(version, candidate)
    await assertRepeatGraphCommittedState(sql, scope, head.head_sequence, snapshot.state)
    return snapshot
  } catch (error) {
    if (error instanceof RunGraphError) throw error
    // No parser fragments, private source records or paths cross this boundary.
    throw new RunGraphError('GRAPH_INVARIANT_VIOLATION', { cause: error })
  }
}

/** Same primary repeatable-read cut for head, immutable pins, domain rows AND
 * permanent receipt verification. No retained-batch replay used as a new store.
 * A capacity excess returns an error; never partial state labelled complete. */
export async function readRepeatGraphSnapshot(pool: pg.Pool, input: unknown,
  authorize: AuthorizeRepeatGraphRead): Promise<RepeatGraphSnapshotV3> {
  const request = readRequest(input)
  return withExclusiveGraphConnection(pool, (connection) => connection.transaction(async (sql) => {
    const head = await authorizedHead(sql, request.scope, authorize)
    return verifiedRepeatCut(sql, request.scope, head)
  }, true))
}
export async function readRepeatGraphCurrent(pool: pg.Pool, input: unknown, authorize: AuthorizeRepeatGraphRead) {
  const snapshot = await readRepeatGraphSnapshot(pool, input, authorize)
  return RepeatGraphCurrentV3Schema.parse({ ...snapshot, kind: 'current' })
}

/** V3 branch of the EXISTING complete-batch journal reader. The 1/2 reader and
 * its schemas remain unchanged; callers must dispatch by the exact saved pin.
 * This returns whole publication positions even for non-occurrence facts. */
export async function readRepeatGraphPage(pool: pg.Pool, input: unknown,
  authorize: AuthorizeRepeatGraphRead): Promise<RepeatGraphPageV3 | RepeatGraphResetV3> {
  readRequestForEvents(input)
  const request = RepeatGraphEventsRequestV3Schema.parse(input)
  return withExclusiveGraphConnection(pool, (connection) => connection.transaction(async (sql) => {
    const { scope, afterSequence } = request
    const head = await authorizedHead(sql, scope, authorize), after = BigInt(afterSequence)
    // Do not label a stale unjournaled domain cut as a complete empty page.
    await verifiedRepeatCut(sql, scope, head)
    if (after < BigInt(head.retention_floor)) return reset(scope, afterSequence, head, 'history_expired')
    if (after > BigInt(head.head_sequence)) return reset(scope, afterSequence, head, 'cursor_ahead')
    if (BigInt(head.head_sequence) - after > BigInt(RUN_GRAPH_LIMITS.catchupBatches)) return reset(scope, afterSequence, head, 'catchup_limit')
    const metadata = await sql.query<{ sequence: string; kind: string; payload_bytes: number }>(
      `select b.sequence::text,b.kind,b.payload_bytes from run_graph_batches b
       where b.run_id=$1 and b.sequence>$2::bigint and b.sequence<=$3::bigint order by b.sequence limit $4`,
      [scope.runId, afterSequence, head.head_sequence, RUN_GRAPH_LIMITS.pageBatches])
    const batches: RepeatGraphBatchV3[] = []
    const page = (through: string): RepeatGraphPageV3 => ({ kind: 'page', protocolVersion: 1, scope,
      baseSequence: afterSequence, throughSequence: through, headSequence: head.head_sequence,
      retentionFloor: head.retention_floor, hasMore: BigInt(through) < BigInt(head.head_sequence), batches: [...batches] })
    let through = afterSequence
    let budget = RUN_GRAPH_LIMITS.pageBytes - graphJsonBytes(page(through)) - 128
    const selected: string[] = []
    for (const row of metadata.rows) {
      if (!GraphSequenceSchema.safeParse(row.sequence).success || BigInt(row.sequence) !== BigInt(through) + 1n) return reset(scope, afterSequence, head, 'gap')
      if (row.kind === 'reset') return reset(scope, afterSequence, head, 'atomic_change_too_large')
      if (row.kind !== 'events' || !Number.isInteger(row.payload_bytes) || row.payload_bytes < 1 || row.payload_bytes > RUN_GRAPH_LIMITS.batchBytes) {
        return reset(scope, afterSequence, head, 'schema_changed')
      }
      if (row.payload_bytes + 1 > budget) break
      selected.push(row.sequence); budget -= row.payload_bytes + 1; through = row.sequence
    }
    if (selected.length) {
      const bodies = await sql.query<{ sequence: string; payload: string }>(
        'select b.sequence::text,b.payload from run_graph_batches b where b.run_id=$1 and b.sequence=any($2::bigint[]) order by b.sequence',
        [scope.runId, selected])
      if (bodies.rows.length !== selected.length) return reset(scope, afterSequence, head, 'gap')
      let previous = afterSequence
      for (const row of bodies.rows) {
        let batch: RepeatGraphBatchV3
        try { batch = RepeatGraphBatchV3Schema.parse(JSON.parse(row.payload)) }
        catch { return reset(scope, afterSequence, head, 'schema_changed') }
        if (batch.sequence !== row.sequence || batch.previousSequence !== previous || !sameCanonicalGraphScope(batch.scope, scope)) {
          return reset(scope, afterSequence, head, 'gap')
        }
        batches.push(batch); previous = batch.sequence
      }
    }
    if (through === afterSequence && after < BigInt(head.head_sequence)) return reset(scope, afterSequence, head, 'gap')
    const response = RepeatGraphPageV3Schema.safeParse(page(through))
    if (!response.success) return reset(scope, afterSequence, head, 'schema_changed')
    try { await assertRepeatGraphBatchesCommitted(sql, scope, head.head_sequence, response.data.batches) }
    catch (error) {
      if (error instanceof RunGraphError) return reset(scope, afterSequence, head, 'schema_changed')
      throw error
    }
    canonicalGraphJson(response.data, RUN_GRAPH_LIMITS.pageBytes)
    return response.data
  }, true))
}
function readRequestForEvents(input: unknown): void {
  if (typeof input !== 'object' || input === null || !('afterSequence' in input)
    || !GraphSequenceSchema.safeParse(input.afterSequence).success) throw new RunGraphError('GRAPH_INVALID_CURSOR')
  if (!('protocolVersion' in input) || input.protocolVersion !== 1) throw new RunGraphError('GRAPH_UNSUPPORTED_PROTOCOL')
  if (!RepeatGraphEventsRequestV3Schema.safeParse(input).success) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
}
