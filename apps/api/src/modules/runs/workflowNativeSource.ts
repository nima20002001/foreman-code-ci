import { REMOTE_NATIVE_SOURCE_LIMIT } from '@foreman-code/contracts/remote-workflow-physical'
import type { WorkflowNativeCapture, WorkflowOriginalNativeSource } from '../interactions/workflowNativeCapture.js'
import { assertGraphTransaction, type GraphTransactionSql } from '../run-graph/connection.js'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { DomainError } from '../errors.js'
import { repeatDigest, repeatId, repeatExecutionIdentity, type RepeatScope } from './repeatResolution.js'
import type { StoredRepeatExecution } from './repeatPostgres.js'
import type { WorkflowNativeProofRecord } from './workflowNativeProof.js'
import type { HarnessExecution } from '@foreman-code/contracts'
import { assertRepeatCanonicalReceiptLocked } from '../run-graph/repeatReceipts.js'
import { assertOriginalWorkflowTerminal } from '../interactions/workflowTerminalSource.js'

function fail(code = 'NATIVE_SOURCE_CONFLICT'): never {
  throw new DomainError(code, 'The original native source conflicts with its retained record.', 409)
}
function originalIdentity(source: WorkflowOriginalNativeSource): unknown {
  switch (source.type) {
    case 'session_created': return ['session', source.session]
    case 'event': return ['event', source.event.connectionId ?? null, source.event.sequence]
    case 'history': return ['history', repeatDigest(source.history, REMOTE_NATIVE_SOURCE_LIMIT)]
    case 'boundary': return fail('NATIVE_SOURCE_NOT_CAPTURED')
  }
}

export function workflowNativeSourceId(executionId: string, source: WorkflowOriginalNativeSource): string {
  return repeatId('workflow-native-source', executionId, repeatDigest(originalIdentity(source)))
}
function sourceIdentity(record: WorkflowNativeProofRecord): unknown {
  return { scope: record.scope, ref: record.ref, execution: record.execution, inputDigest: record.inputDigest,
    session: record.session, commandId: record.commandId, original: record.original,
    ...(record.settlementOf ? { settlementOf: record.settlementOf } : {}) }
}

/** The terminal that committed with the execution, before physical settlement. */
export async function readWorkflowTerminalSource(sql: GraphTransactionSql,
  execution: HarnessExecution): Promise<WorkflowNativeProofRecord | undefined> {
  const rows = (await sql.query<{ record: WorkflowNativeProofRecord; source_digest: string }>(`
    select record,source_digest from workflow_native_proofs where run_id=$1 and execution_id=$2
      and record->>'observedAt'=$3 and record#>>'{original,type}'='history'
      and record#>'{original,history,terminalTurn}' is not null and not (record ? 'settlementOf')`,
  [execution.runId, execution.id, execution.finishedAt])).rows
  if (!rows.length) return undefined
  if (rows.length !== 1) return fail()
  const { record, source_digest } = rows[0]!
  if (record.original.type !== 'history' || !record.original.history.terminalTurn
    || record.inputDigest !== repeatDigest(execution.input)
    || canonicalGraphJson(record.execution) !== canonicalGraphJson(repeatExecutionIdentity(execution))
    || record.session.nativeSessionId !== execution.nativeSessionId
    || repeatDigest(record, REMOTE_NATIVE_SOURCE_LIMIT) !== source_digest) return fail()
  assertOriginalWorkflowTerminal(execution, record.session, record.original.history,
    record.original.history.terminalTurn.correlationId)
  await assertRepeatCanonicalReceiptLocked(sql, { scope: record.scope,
    evidence: { sourceKind: 'native_event', sourceId: record.proofId, sourceRevision: '1' },
    sourceDigest: source_digest, effect: null })
  return structuredClone(record)
}

export function workflowNativeSourceRecord(capture: WorkflowNativeCapture, stored: StoredRepeatExecution,
  scope: RepeatScope, fence: { ownerId: string; fence: string }): WorkflowNativeProofRecord {
  return {
    proofId: workflowNativeSourceId(stored.execution.id, capture.source),
    scope, ref: stored.ref, execution: repeatExecutionIdentity(stored.execution), inputDigest: stored.inputDigest,
    commandId: `execution:${stored.execution.id}`, session: capture.session, original: capture.source,
    observedAt: capture.observedAt, ownerId: fence.ownerId, ownerFence: fence.fence,
    lifetimeGeneration: capture.lifetimeGeneration, closureGeneration: capture.closureGeneration!, lane: capture.lane,
  }
}

/** Each frame keeps its own immutable source, including the first receipt on replay. */
export async function persistWorkflowNativeSources(sql: GraphTransactionSql,
  proposed: readonly WorkflowNativeProofRecord[]): Promise<WorkflowNativeProofRecord[]> {
  assertGraphTransaction(sql)
  const distinct = new Map<string, WorkflowNativeProofRecord>()
  for (const record of proposed) {
    const previous = distinct.get(record.proofId)
    if (previous && canonicalGraphJson(sourceIdentity(previous), REMOTE_NATIVE_SOURCE_LIMIT)
      !== canonicalGraphJson(sourceIdentity(record), REMOTE_NATIVE_SOURCE_LIMIT)) return fail()
    if (!previous) distinct.set(record.proofId, record)
  }
  const rows = await sql.query<{ record: WorkflowNativeProofRecord; source_digest: string; identity_digest: string }>(
    // Database triggers reject changes to retained sources; replay needs no row lock.
    'select record,source_digest,identity_digest from workflow_native_proofs where proof_id=any($1::text[])',
    [[...distinct.keys()]])
  const saved = new Map(rows.rows.map((row) => [row.record.proofId, row]))
  const inserts = []
  for (const record of distinct.values()) {
    const existing = saved.get(record.proofId)
    const identityDigest = repeatDigest(sourceIdentity(record), REMOTE_NATIVE_SOURCE_LIMIT)
    if (existing && (existing.identity_digest !== identityDigest
      || repeatDigest(existing.record, REMOTE_NATIVE_SOURCE_LIMIT) !== existing.source_digest
      || canonicalGraphJson(sourceIdentity(existing.record), REMOTE_NATIVE_SOURCE_LIMIT)
        !== canonicalGraphJson(sourceIdentity(record), REMOTE_NATIVE_SOURCE_LIMIT))) return fail()
    if (!existing) {
      const json = canonicalGraphJson(record, REMOTE_NATIVE_SOURCE_LIMIT)
      inserts.push({ proof_id: record.proofId, run_id: record.scope.runId, execution_id: record.execution.executionId,
        identity_digest: identityDigest, source_digest: repeatDigest(record, REMOTE_NATIVE_SOURCE_LIMIT), record: json })
    }
  }
  if (inserts.length) {
    await sql.query(`insert into workflow_native_proofs(proof_id,run_id,execution_id,identity_digest,source_digest,record,record_json)
      select proof_id,run_id,execution_id,identity_digest,source_digest,record::jsonb,record
      from jsonb_to_recordset($1::jsonb) as source(proof_id text,run_id text,execution_id text,
        identity_digest text,source_digest text,record text)`, [JSON.stringify(inserts)])
  }
  return proposed.map((record) => structuredClone(saved.get(record.proofId)?.record ?? distinct.get(record.proofId)!))
}
