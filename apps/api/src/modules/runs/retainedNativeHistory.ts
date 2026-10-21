import type { HarnessNativeEvent } from '@foreman-code/contracts'
import { runtimeTimingPoint } from '../../infrastructure/runtimeTiming.js'
import { assertGraphTransaction, beforeGraphCommit, type GraphTransactionSql } from '../run-graph/connection.js'
import { claudeNativeGraphObservation, nativeGraphSource } from '../run-graph/nativeIngestion.js'
import { selectNativeGraphEvidence } from '../run-graph/nativeEvidence.js'
import { normalizeNativeProducerEvent } from '../run-graph/nativeProducerNormalization.js'
import { graphSourceDigest } from '../run-graph/publication.js'
import { readNativeGraphCorrelation } from '../run-graph/records.js'
import { assertRepeatCanonicalReceiptsLocked, requireRepeatCanonicalReceiptBeforeCommit,
  type RepeatCanonicalReceipt } from '../run-graph/repeatReceipts.js'
import type { WorkflowNativeCapture } from '../interactions/workflowNativeCapture.js'
import { DomainError } from '../errors.js'
import { repeatExecutionIdentity, sameRepeatValue, type RepeatScope } from './repeatResolution.js'

interface RetainedRow {
  connection_id: string | null
  source_sequence: number | null
  sequence: number
  record_matches: boolean
  source_digest: string | null
  semantic_digest: string | null
}
const sourceKey = (connection: string | null, sequence: number) => JSON.stringify([connection, sequence])

/** Only byte-identical committed frames can avoid a second graph ingestion. */
export async function retainedNativeHistoryEvents(sql: GraphTransactionSql, scope: RepeatScope,
  events: readonly HarnessNativeEvent[], capture: WorkflowNativeCapture): Promise<Set<HarnessNativeEvent>> {
  assertGraphTransaction(sql)
  const key = { execution: repeatExecutionIdentity(capture.execution), workKind: 'workflow' as const,
    workId: capture.execution.id }
  const correlationKey = `execution:${capture.execution.id}`
  const candidates = new Map<string, { normalized: HarnessNativeEvent; originals: HarnessNativeEvent[]; semantic: boolean }>()
  const conflicted = new Set<string>()
  for (const event of events) {
    const normalized = normalizeNativeProducerEvent(event)
    const selected = selectNativeGraphEvidence(normalized.event.type, normalized.event.payload)
    if (normalized.rejected || selected.kind === 'invalid' || event.type === 'transport.disconnected'
      || event.payload.nativeMessageId !== undefined && capture.session.harness !== 'claude') continue
    const messageObservation = capture.session.harness === 'claude'
      && claudeNativeGraphObservation(scope, key, normalized.event, {
        nativeSessionId: capture.session.nativeSessionId, nativeMessageId: capture.lane?.providerId ?? null,
        clientCorrelationId: correlationKey, connectionGeneration: String(capture.lane?.connectionGeneration ?? 0),
        terminalReady: true,
      })
    const identity = sourceKey(event.connectionId ?? null, event.sequence)
    const previous = candidates.get(identity)
    if (previous && !sameRepeatValue(previous.normalized, normalized.event)) conflicted.add(identity)
    if (previous) previous.originals.push(event)
    else candidates.set(identity, { normalized: normalized.event, originals: [event],
      semantic: selected.kind === 'evidence' || Boolean(messageObservation) })
  }
  for (const identity of conflicted) candidates.delete(identity)
  if (!candidates.size) return new Set()
  capture.assertCurrent()
  const rows = await sql.query<RetainedRow>(`select n.connection_id,n.source_sequence,n.sequence,
      jsonb_set(n.record,'{sequence}',to_jsonb(original.source_sequence))=original.record as record_matches,
      s.source_digest,s.semantic_digest
    from harness_native_events n join jsonb_to_recordset($2::jsonb)
      as original(connection_id text,source_sequence integer,graph_source_id text,record jsonb)
      on n.connection_id is not distinct from original.connection_id
      and case when n.connection_id is null then n.sequence else n.source_sequence end=original.source_sequence
    left join run_graph_sources s on s.run_id=$3 and s.source_kind='native_event'
      and s.source_id=original.graph_source_id and s.source_revision=0
    where n.execution_id=$1`, [capture.execution.id, JSON.stringify([...candidates.values()].map(({ normalized, semantic }) => ({
    connection_id: normalized.connectionId ?? null, source_sequence: normalized.sequence,
    graph_source_id: semantic ? nativeGraphSource(normalized).sourceId : null, record: normalized,
  }))), scope.runId])
  capture.assertCurrent()
  const retained = new Set<HarnessNativeEvent>()
  const correlation = rows.rows.some((row) => row.source_digest) && capture.lane
    ? await readNativeGraphCorrelation(sql, scope, key, correlationKey) : undefined
  const matches = (current: typeof correlation, connectionId: string | null) => !!current && !!capture.lane
    && current.provider === capture.session.harness && current.nativeSessionId === capture.session.nativeSessionId
    && current.connectionId === connectionId && current.connectionGeneration === capture.lane.connectionGeneration
    && current.nativeTurnId === capture.lane.providerId
  let checkCorrelation = false
  let semanticReplays = 0
  const receipts: RepeatCanonicalReceipt[] = []
  for (const row of rows.rows) {
    const sequence = row.connection_id === null ? row.sequence : row.source_sequence
    if (sequence === null) continue
    const candidate = candidates.get(sourceKey(row.connection_id, sequence))
    if (!candidate || row.record_matches !== true) continue
    capture.assertCurrent()
    if (candidate.semantic) {
      if (!row.source_digest || !row.semantic_digest || !matches(correlation, row.connection_id)) continue
      const receipt = { scope, evidence: nativeGraphSource(candidate.normalized),
        sourceDigest: graphSourceDigest(candidate.normalized), semanticDigest: row.semantic_digest, effect: null }
      receipts.push(receipt)
      checkCorrelation = true
      semanticReplays += candidate.originals.length
    }
    for (const event of candidate.originals) retained.add(event)
  }
  await assertRepeatCanonicalReceiptsLocked(sql, receipts)
  for (const receipt of receipts) requireRepeatCanonicalReceiptBeforeCommit(sql, receipt)
  if (checkCorrelation) beforeGraphCommit(sql, async () => {
    capture.assertCurrent()
    const current = await readNativeGraphCorrelation(sql, scope, key, correlationKey)
    if (!matches(current, correlation!.connectionId)) throw new DomainError(
      'NATIVE_SOURCE_IDENTITY_CONFLICT', 'The retained native history correlation changed before commit.', 409)
  })
  runtimeTimingPoint('db', 'native.history_replay', { runId: scope.runId,
    executionId: capture.execution.id, operation: 'semantic', count: semanticReplays })
  return retained
}
