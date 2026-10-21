import { ExecutionResultSchema, HarnessNativeEventSchema, type HarnessNativeEvent } from '@foreman-code/contracts'
import {
  canonicalGraphJson, parseNativeGraphObservation, sameGraphScope,
  assertNativeGraphProjectionAuthority, type GraphFact, type NativeGraphObservation, type NativeGraphCorrelationRecord, type RunGraphScope,
  type NativeGraphProjectionKey,
} from '@foreman-code/contracts/wave25'
import { poisonGraphTransaction, type GraphTransactionSql } from './connection.js'
import { type CurrentNativeActivity } from './currentActivity.js'
import { readBatchNativeActivities } from './nativeBatchActivity.js'
import { composePublicNodes, readPublicNodeInputs, type PublicNodeInputs } from './publicProjection.js'
import { readNativeProjectionFacts } from './nativeProjectionFacts.js'
import { assertRunGraphPublication, graphSourceDigest, graphSourceRowKey, readGraphSourceRow, type RunGraphPublication } from './publication.js'
import { readNativeCheckpoint, readNativeGraphActivity, readNativeGraphCorrelation, stagedNativeRecordId, type NativeGraphProjectionGuard } from './records.js'
import { RunGraphError } from './errors.js'
import { flushNativeGraphRows, PostgresNativeGraphProjectionWriter } from './nativeWriter.js'
import { nativeProjectionId, nativeProjectionActivity, projectNativeEvidence, reconcileNativeEvidence, type ProjectionBinding, type ProjectionEvent, type NativeProjectionState } from './nativeProjection.js'
import { parseNativeCheckpoint } from './nativeCheckpoint.js'
import { selectNativeGraphEvidence } from './nativeEvidence.js'
import { normalizeNativeProducerEvent } from './nativeProducerNormalization.js'
import { appendNormalizedNativeEvent, readPersistedNativeSequence } from '../runs/nativeEvents.js'
import { appendNormalizedNativeEvents } from '../runs/nativeEventBatch.js'
import type { NormalizedNativeProducerEvent } from './nativeProducerNormalization.js'
import { activeNativeBatch, closeNativeBatch, finishNativeBatch, hasNativeBatch, memoizeNativeRead, openNativeBatch, prefetchedNativeAppend, rememberNativeAppend, seedNativeRead, stageNativeRow } from './nativeBatch.js'

export interface NativeGraphWork {
  guard: NativeGraphProjectionGuard
  correlationKey: string
  /** Optional normalized reliability evidence produced by the qualified adapter, not a raw frame. */
  observation?: NativeGraphObservation
  /** Adapter-qualified COMPLETE view of the exact current work, never a partial history page.
   * Every listed item is grounded in the input's captured provider response. No native call occurs here. */
  currentView?: { complete: true; events: readonly Pick<ProjectionEvent, 'type' | 'payload'>[] }
}
export interface NativeGraphIngestionResult { rawInserted: boolean; projected: number; rejected: number; ignored: number }
export function nativeGraphSource(event: HarnessNativeEvent) {
  return { sourceKind: 'native_event' as const,
    sourceId: nativeProjectionId('native', event.executionId, event.connectionId ?? null, event.sequence), sourceRevision: '0' }
}

/**
 * SQL-only producer. Caller has opened G1 publication FIRST on the exclusively owned connection.
 * The existing native append, bounded projection and semantic batch commit or roll back together.
 * No native/network call, private cursor, advisory owner acquisition, or lifetime replay here.
 */
export async function appendNativeGraphEvent(publication: RunGraphPublication, input: HarnessNativeEvent,
  work: readonly NativeGraphWork[], writer = new PostgresNativeGraphProjectionWriter()): Promise<NativeGraphIngestionResult> {
  try { return await ingest(publication, input, work, writer) }
  catch (error) { poisonGraphTransaction(publication.sql); throw error }
}

async function ingest(publication: RunGraphPublication, input: HarnessNativeEvent, work: readonly NativeGraphWork[],
  writer: PostgresNativeGraphProjectionWriter): Promise<NativeGraphIngestionResult> {
  const { sql, scope } = publication
  assertRunGraphPublication(sql, scope)
  if (scope.executionSemanticsVersion !== 3 || !work.length || work.length > 16) throw new RunGraphError('GRAPH_NOT_INITIALIZED')
  const prepared = normalizeNativeProducerEvent(input)
  const event = HarnessNativeEventSchema.parse(prepared.event)
  if (!Number.isSafeInteger(event.sequence) || event.sequence > 2147483647) throw new RunGraphError('GRAPH_EVIDENCE_INVALID')
  const evidence = nativeGraphSource(event)
  const ordered = [...work].sort((a, b) => canonicalGraphJson(a.guard.expected.key).localeCompare(canonicalGraphJson(b.guard.expected.key)))
  if (new Set(ordered.map((item) => canonicalGraphJson(item.guard.expected.key))).size !== ordered.length) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
  for (const item of ordered) {
    if (!sameGraphScope(item.guard.expected.scope, scope) || item.guard.expected.key.execution.executionId !== event.executionId) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
    assertNativeGraphProjectionAuthority(item.guard.expected, await item.guard.readCurrentLocked(sql, scope, item.guard.expected.key))
  }
  // Same S1 function, identity and integer numbering; it locks the execution AFTER Run/head.
  const appended = prefetchedNativeAppend(sql, event) ?? await appendNormalizedNativeEvent(sql, { ...prepared, event })
  const result: NativeGraphIngestionResult = { rawInserted: appended.inserted, projected: 0, rejected: 0, ignored: 0 }
  // Retained oversized/malformed input always stays a rejection, including when
  // a caller supplies an observation/current view. It cannot seed a checkpoint,
  // publish an activity, or promote that source into acknowledgement/terminal proof.
  if (appended.rejected) { result.rejected = ordered.length; return result }
  if (await readGraphSourceRow(sql, scope.runId, evidence.sourceKind, evidence.sourceId, '0')) { result.ignored = work.length; return result }
  const nativeSequence = prefetchedNativeAppend(sql, event)?.sequence ?? await readPersistedNativeSequence(sql, event)
  const selected = selectNativeGraphEvidence(event.type, event.payload)
  const claudeEvidence = ['message.submitted', 'interaction.pending', 'turn.completed'].includes(event.type)
    && event.payload.nativeMessageId !== undefined
  // Irrelevant token/prose/keepalive events perform no checkpoint/correlation reads at all.
  if (selected.kind !== 'evidence' && !claudeEvidence && ordered.every((item) => !item.observation && !item.currentView)) {
    if (selected.kind === 'invalid') result.rejected = ordered.length
    else result.ignored = ordered.length
    return result
  }
  const writes: (() => Promise<void>)[] = []
  const facts: GraphFact[] = []
  const nodeIds = [...new Set(ordered.map((item) => item.guard.expected.key.execution.workflowNodeId))]
  const inputs = await projectionInputs(sql, scope, nodeIds)
  const beforeCandidates = await readBatchNativeActivities(sql, scope, inputs)
  const afterCandidates: CurrentNativeActivity[] = [...beforeCandidates]
  // Oversized original evidence fails projection explicitly; raw source numbering is preserved.
  let sourceDigest: string
  try { sourceDigest = graphSourceDigest(event) } catch { result.rejected = ordered.length; return result }
  for (const item of ordered) {
    const key = item.guard.expected.key
    const correlation = await readNativeGraphCorrelation(sql, scope, key, item.correlationKey)
    // The exact submission/session correlation is a prerequisite; never infer a workflow lane by exclusion.
    if (!correlation) throw new RunGraphError('GRAPH_NOT_INITIALIZED')
    if (correlation.connectionId !== (event.connectionId ?? null)
      || String(correlation.connectionGeneration) !== item.guard.expected.connectionGeneration) throw new RunGraphError('GRAPH_STALE_GENERATION')
    const closed = await memoizeNativeRead(sql, `closed-work:${canonicalGraphJson(key)}`, () => sql.query<{ closed: boolean }>(
      `select (r.stop_requested_at is not null or r.execution_state in ('completed','interrupted') or
         case when $3='workflow' then e.record->>'state'='completed' else
           exists(select 1 from review_jobs j where j.id=$4 and j.execution_id=e.id
             and (j.record->>'state'='completed' or j.record->'cleanup'->>'completedAt' is not null)) end) as closed
       from runs r join harness_executions e on e.run_id=r.id where r.id=$1 and e.id=$2`,
      [scope.runId, key.execution.executionId, key.workKind, key.workId]))
    if (!closed.rows[0]) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
    const binding: ProjectionBinding = { key, provider: correlation.provider, nativeSessionId: correlation.nativeSessionId,
      nativeTurnId: correlation.nativeTurnId, connectionGeneration: item.guard.expected.connectionGeneration,
      interactionId: correlation.interactionId, closed: closed.rows[0].closed || correlation.terminalNativeSequence !== null }
    const checkpoint = await readNativeCheckpoint(sql, scope, key)
    const previous = checkpoint ? parseNativeCheckpoint(checkpoint.checkpoint) : undefined
    let normalized: Pick<ProjectionEvent, 'type' | 'payload'> | undefined
    try { normalized = normalizedEvidence(scope, item.observation ?? (binding.provider === 'claude'
      ? claudeNativeGraphObservation(scope, key, event, { nativeSessionId: binding.nativeSessionId,
        nativeMessageId: binding.nativeTurnId, clientCorrelationId: item.correlationKey,
        connectionGeneration: binding.connectionGeneration, terminalReady: true }) : undefined), event, binding, selected) }
    catch { result.rejected++; continue }
    if (!normalized && !item.currentView) { result.ignored++; continue }
    const cut = { nativeSequence, sourcePosition: String(event.sequence),
      sourceStreamId: nativeProjectionId('stream', event.executionId, event.connectionId ?? null),
      connectionGeneration: binding.connectionGeneration, sourceId: evidence.sourceId }
    let projected
    if (item.currentView) {
      if (item.currentView.complete !== true || item.currentView.events.length > 256) { result.rejected++; continue }
      const currentEvents: ProjectionEvent[] = []
      let invalid = false
      for (const current of item.currentView.events) {
        if (!['item.snapshot', 'message.updated', 'message.part.updated'].includes(current.type)) { invalid = true; break }
        const safe = selectNativeGraphEvidence(current.type, current.payload)
        const selectedCurrent = normalizedEvidence(scope, undefined, event, binding, safe)
        if (!selectedCurrent) { invalid = true; break }
        currentEvents.push({ ...cut, ...selectedCurrent })
      }
      if (invalid) { result.rejected++; continue }
      projected = reconcileNativeEvidence(previous, binding, cut, currentEvents)
    } else projected = projectNativeEvidence(previous, binding, { ...cut, ...normalized! })
    if (projected.disposition === 'rejected') result.rejected++
    else if (projected.disposition === 'ignored') result.ignored++
    else result.projected++
    // Invalid input does not destroy a good checkpoint; bounded-capacity uncertainty is explicit.
    if (projected.disposition === 'rejected' && projected.reason !== 'capacity') continue
    const nextState = parseNativeCheckpoint(projected.state)
    projected.activity = nativeProjectionActivity(nextState, binding)
    const current = await readNativeGraphActivity(sql, scope, key)
    const changed = !current || canonicalGraphJson(current.activity) !== canonicalGraphJson(projected.activity)
      || current.lastNativeSequence !== (nextState.lastNativeSequence ?? current.lastNativeSequence)
      || current.terminalNativeSequence !== (nextState.terminalNativeSequence ?? current.terminalNativeSequence)
    const candidate: CurrentNativeActivity = { key, activity: projected.activity,
      lastNativeSequence: nextState.lastNativeSequence ?? current?.lastNativeSequence ?? null }
    const candidateIndex = afterCandidates.findIndex((row) => canonicalGraphJson(row.key) === canonicalGraphJson(key))
    if (candidateIndex < 0) afterCandidates.push(candidate)
    else afterCandidates[candidateIndex] = candidate
    const nextRevision = current ? String(BigInt(current.projectionRevision) + 1n) : '0'
    const nextCorrelation: NativeGraphCorrelationRecord = { ...correlation,
      metadataRevision: String(BigInt(correlation.metadataRevision) + 1n),
      firstNativeSequence: BigInt(nativeSequence) < BigInt(correlation.firstNativeSequence) ? nativeSequence : correlation.firstNativeSequence,
      lastNativeSequence: BigInt(nativeSequence) > BigInt(correlation.lastNativeSequence) ? nativeSequence : correlation.lastNativeSequence,
      terminalNativeSequence: projected.state.terminalNativeSequence ?? correlation.terminalNativeSequence }
    if (checkpoint && canonicalGraphJson(previous) === canonicalGraphJson(nextState) && !changed) continue
    const capturedState: NativeProjectionState = nextState
    writes.push(async () => {
      await writer.persistCorrelation(sql, scope, correlation.metadataRevision, nextCorrelation, item.guard)
      if (changed) await writer.persistActivity(sql, scope, current?.projectionRevision ?? null, {
        key, projectionRevision: nextRevision, lastNativeSequence: capturedState.lastNativeSequence ?? current?.lastNativeSequence ?? null,
        terminalNativeSequence: capturedState.terminalNativeSequence ?? current?.terminalNativeSequence ?? null, activity: projected.activity,
      }, item.guard)
      const revision = checkpoint ? String(BigInt(checkpoint.revision) + 1n) : '0'
      const batch = activeNativeBatch(sql)
      if (batch) {
        stageNativeRow(batch, stagedNativeRecordId('checkpoint', key), { kind: 'checkpoint', expected: checkpoint?.revision ?? null,
          value: { key, revision, checkpoint: JSON.parse(canonicalGraphJson(parseNativeCheckpoint(capturedState))) } })
        return
      }
      const values = [scope.runId, key.execution.executionId, key.execution.workflowNodeId, key.execution.attempt,
        key.workKind, key.workId, revision, canonicalGraphJson(parseNativeCheckpoint(capturedState))]
      const saved = await sql.query(
        `insert into run_native_projection_checkpoints(run_id,execution_id,workflow_node_id,attempt,work_kind,work_id,revision,checkpoint)
         values($1,$2,$3,$4,$5,$6,$7::bigint,$8::jsonb)
         on conflict(run_id,execution_id,work_kind,work_id) do update set revision=excluded.revision,checkpoint=excluded.checkpoint
         where run_native_projection_checkpoints.revision=$9::bigint returning execution_id`, [...values, checkpoint?.revision ?? null])
      if (saved.rowCount !== 1) throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
    })
  }
  facts.push(...await readNativeProjectionFacts(beforeCandidates, afterCandidates,
    native => composePublicNodes(sql, scope, inputs, { native })))
  const mutate = async () => { for (const write of writes) await write() }
  if (facts.length) {
    // Includes private fields in the source digest, never in the public graph facts.
    await publication.source({ evidence, sourceDigest, facts }, mutate)
  } else await mutate() // Identity bookkeeping is atomic but is NOT a semantic graph event.
  return result
}

/** Runs one native batch: authority is read once, staged projection rows flush as
 * multi-row statements, and a single live COMMIT check runs after the publication writes. */
export async function withNativeGraphProjectionBatch<T>(sql: GraphTransactionSql, runId: string, work: () => Promise<T>): Promise<T> {
  if (hasNativeBatch(sql)) return work()
  const batch = openNativeBatch(sql, runId)
  try {
    const result = await work()
    await finishNativeBatch(batch, () => flushNativeGraphRows(batch, ['correlation', 'activity', 'checkpoint']))
    return result
  } finally { closeNativeBatch(batch) }
}

/** Once per group: one native append per frame in frame order and one source-row read for the group.
 * Per-frame callers reuse these results from the batch instead of repeating the statements. */
export async function prefetchNativeFrames(sql: GraphTransactionSql, runId: string,
  frames: readonly NormalizedNativeProducerEvent[]): Promise<void> {
  if (!activeNativeBatch(sql) || !frames.length) return
  const appended = await appendNormalizedNativeEvents(sql, frames)
  frames.forEach((frame, index) => rememberNativeAppend(sql, frame.event, appended[index]!))
  const ids = [...new Set(frames.map((frame) => nativeGraphSource(frame.event).sourceId))]
  const rows = await sql.query<{ source_id: string; source_digest: string; semantic_digest: string }>(
    `select source_id,source_digest,semantic_digest from run_graph_sources
     where run_id=$1 and source_kind='native_event' and source_revision=0 and source_id=any($2::text[])`, [runId, ids])
  const found = new Map(rows.rows.map((row) => [row.source_id, row]))
  for (const id of ids) seedNativeRead(sql, graphSourceRowKey(runId, 'native_event', id, '0'), found.get(id))
}

/** Scopes read-once projection inputs to one native batch transaction. Inside it the
 * only writes are native-proof rows, which never change these non-native inputs. */
async function projectionInputs(sql: GraphTransactionSql, scope: RunGraphScope, nodeIds: readonly string[]): Promise<PublicNodeInputs> {
  return memoizeNativeRead(sql, `projection-inputs:${canonicalGraphJson(nodeIds)}`, () => readPublicNodeInputs(sql, scope, nodeIds))
}

function normalizedEvidence(scope: RunGraphScope, observation: NativeGraphObservation | undefined, event: HarnessNativeEvent, binding: ProjectionBinding,
  selected: ReturnType<typeof selectNativeGraphEvidence>): Pick<ProjectionEvent, 'type' | 'payload'> | undefined {
  if (!observation) {
    // Claude frames require their actual message/session correlation. A familiar
    // turn event name cannot be repaired into provider turn evidence.
    if (binding.provider === 'claude') return undefined
    if (selected.kind !== 'evidence') return undefined
    // Exact current connection/session binding is already locked above. Fill only
    // missing session metadata; contradictory provider metadata is never overwritten.
    const payload = { ...selected.payload }
    if (payload.sessionID === undefined && payload.threadId === undefined
      && !('sessionID' in (payload.info as Record<string, unknown> ?? {}))
      && !('sessionID' in (payload.part as Record<string, unknown> ?? {}))) payload.sessionID = binding.nativeSessionId
    return { type: selected.type, payload }
  }
  const value = parseNativeGraphObservation(observation)
  const source = nativeGraphSource(event)
  if (!sameGraphScope(value.scope, scope)
    || value.sourceStreamId !== nativeProjectionId('stream', event.executionId, event.connectionId ?? null)
    || value.observedAt !== event.occurredAt || canonicalGraphJson(value.work) !== canonicalGraphJson(binding.key) || value.source.sourceId !== source.sourceId
    || value.source.sourceRevision !== source.sourceRevision || value.sourcePosition !== String(event.sequence)
    || value.connectionGeneration !== binding.connectionGeneration
    || value.kind !== 'transport' && value.submissionId !== binding.nativeTurnId) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
  const payload = binding.provider === 'claude'
    ? { nativeSessionId: binding.nativeSessionId, nativeMessageId: binding.nativeTurnId }
    : { sessionID: binding.nativeSessionId, turnId: binding.nativeTurnId }
  if (value.kind === 'transport') return value.transport === 'closed' ? { type: 'graph.native.disconnected', payload } : undefined
  if (value.kind === 'submission') return { type: value.state === 'acknowledged' ? 'graph.native.acknowledged' : 'graph.native.uncertain', payload }
  return { type: 'graph.native.terminal', payload: { ...payload, terminal: value.terminal } }
}

/** Positive SDK receipts carry the actual consumed input message. Native turn
 * aliases, idle/history echoes and unattributed results cannot acknowledge it. */
export function claudeNativeGraphObservation(scope: RunGraphScope, work: NativeGraphProjectionKey,
  event: HarnessNativeEvent, binding: { nativeSessionId: string; nativeMessageId: string | null;
    clientCorrelationId: string; connectionGeneration: string; terminalReady: boolean }): NativeGraphObservation | undefined {
  const payload = event.payload
  if (!binding.nativeMessageId || payload.nativeSessionId !== binding.nativeSessionId
    || payload.nativeMessageId !== binding.nativeMessageId || payload.clientCorrelationId !== binding.clientCorrelationId) return undefined
  const base = { scope, work, source: nativeGraphSource(event),
    sourceStreamId: nativeProjectionId('stream', event.executionId, event.connectionId ?? null),
    sourcePosition: String(event.sequence), connectionGeneration: binding.connectionGeneration,
    observedAt: event.occurredAt, submissionId: binding.nativeMessageId }
  if (event.type === 'message.submitted' || event.type === 'interaction.pending'
    && typeof payload.nativeRequestId === 'string' && payload.nativeRequestId.length > 0
    && String(payload.generation) === binding.connectionGeneration) return { ...base, kind: 'submission', state: 'acknowledged' }
  if (event.type !== 'turn.completed' || !binding.terminalReady) return undefined
  const result = ExecutionResultSchema.safeParse(payload.result)
  if (!result.success) return undefined
  return { ...base, kind: 'terminal', terminal: { outcome: result.data.outcome,
    evidenceKind: 'provider_terminal', evidenceId: base.source.sourceId, nativeSettled: true } }
}
