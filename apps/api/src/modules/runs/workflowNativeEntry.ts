import type { HarnessExecution } from '@foreman-code/contracts'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { DomainError } from '../errors.js'
import { assertGraphTransaction, beforeGraphCommit, didGraphTransactionCommit, poisonGraphTransaction,
  type GraphSqlClient, type GraphTransactionSql } from '../run-graph/connection.js'
import { requireRepeatCanonicalReceiptBeforeCommit, assertRepeatCanonicalReceiptLocked, assertRepeatCanonicalReceipt,
  type RepeatCanonicalReceipt } from '../run-graph/repeatReceipts.js'
import type { RunOwnership } from './ownership.js'
import { repeatDigest, repeatExecutionIdentity, repeatId, sameRepeatValue,
  type RepeatNodeRef, type RepeatScope } from './repeatResolution.js'

/** Positive, monotonic entry protocol. reserved is created with input.bind,
 * before ANY native allocation. Only a known-COMMIT launch claimant may cross
 * reserved -> prepared -> entered. Cleanup may instead seal reserved/prepared
 * -> not_submitted. Preparation permits only local directory setup, NOT a
 * manager, credential, preflight, session or provider command.
 * Neither terminal business state nor missing native rows establishes either
 * transition. An entered/uncertain lifetime can NEVER be sealed not_submitted. */
export interface WorkflowNativeReservation {
  scope: RepeatScope
  ref: RepeatNodeRef
  execution: ReturnType<typeof repeatExecutionIdentity>
  inputDigest: string
  createdAt: string
}
export interface WorkflowNativeEntryRecord {
  reservation: WorkflowNativeReservation
  phase: 'prepared' | 'entered' | 'not_submitted'
  ownerId: string
  ownerFence: string
  launchDigest: string | null
}
export interface WorkflowNativeEntryPermit { readonly executionId: string }
type Owner = Pick<RunOwnership, 'runId' | 'assertOwned' | 'oneShotConnection' | 'readOneShotFence'>
interface Issuance { owner: Owner; record: WorkflowNativeEntryRecord; receipt: RepeatCanonicalReceipt }
const pending = new WeakMap<GraphTransactionSql, Map<string, Issuance>>()
const issued = new WeakMap<object, Issuance>()
function conflict(): never {
  throw new DomainError('NATIVE_ENTRY_CONFLICT', 'The exact native entry reservation has no matching committed permission.', 409)
}
export function workflowNativeReservation(scope: RepeatScope, ref: RepeatNodeRef,
  execution: HarnessExecution, inputDigest: string): WorkflowNativeReservation {
  if (execution.runId !== scope.runId || execution.workflowNodeId !== ref.nodeId
    || !/^sha256:[0-9a-f]{64}$/.test(inputDigest)) return conflict()
  return structuredClone({ scope, ref, execution: repeatExecutionIdentity(execution), inputDigest, createdAt: execution.createdAt })
}
export async function reserveWorkflowNativeEntryLocked(sql: GraphTransactionSql, reservation: WorkflowNativeReservation): Promise<void> {
  assertGraphTransaction(sql)
  const reservationJson = canonicalGraphJson(reservation)
  const result = await sql.query(`insert into workflow_native_entries
    (execution_id,run_id,reservation,reservation_json,reservation_digest,phase) values($1,$2,$3::jsonb,$4::text,$5,'reserved')`,
  [reservation.execution.executionId, reservation.scope.runId, reservationJson, reservationJson, repeatDigest(reservation)])
  if (result.rowCount !== 1) return conflict()
}
export async function readWorkflowNativeEntryLocked(sql: GraphTransactionSql, reservation: WorkflowNativeReservation) {
  assertGraphTransaction(sql)
  return readNativeEntry(sql, reservation, true)
}

/** Readback is not an entry permit. In particular reserved/prepared and a
 * missing row are NOT no-submission proof; only an exact canonical seal is. */
export async function readWorkflowNativeEntry(sql: GraphSqlClient, reservation: WorkflowNativeReservation) {
  return readNativeEntry(sql, reservation, false)
}
export interface NativeEntryRow {
  phase: 'reserved' | 'prepared' | 'entered' | 'not_submitted'
  reservation: unknown
  reservation_digest: string
  transition: WorkflowNativeEntryRecord | null
  source_id: string | null
  source_digest: string | null
}
async function readNativeEntry(sql: GraphSqlClient, reservation: WorkflowNativeReservation, locked: boolean) {
  const row = (await sql.query<NativeEntryRow>(
    `select phase,reservation,reservation_digest,transition,source_id,source_digest
     from workflow_native_entries where execution_id=$1 and run_id=$2${locked ? ' for update' : ''}`,
    [reservation.execution.executionId, reservation.scope.runId])).rows[0]
  return assertWorkflowNativeEntryRow(row, reservation)
}

export function assertWorkflowNativeEntryRow(row: NativeEntryRow | null | undefined,
  reservation: WorkflowNativeReservation): NativeEntryRow {
  if (!row || !sameRepeatValue(row.reservation, reservation) || row.reservation_digest !== repeatDigest(reservation)) return conflict()
  return row
}

/** Called inside the canonical mutation callback. The private pending map is
 * intentionally not recoverable from a row, a command receipt or a JSON token. */
export async function enterWorkflowNativeLocked(sql: GraphTransactionSql, owner: Owner,
  record: WorkflowNativeEntryRecord, receipt: RepeatCanonicalReceipt, prepared?: WorkflowNativeEntryPermit): Promise<void> {
  assertGraphTransaction(sql); owner.assertOwned()
  if (!['prepared', 'entered'].includes(record.phase) || owner.runId !== record.reservation.scope.runId || !record.launchDigest) return conflict()
  const row = await readWorkflowNativeEntryLocked(sql, record.reservation)
  const from = record.phase === 'prepared' ? 'reserved' : 'prepared'
  if (row.phase !== from || from === 'reserved' && row.transition !== null) return conflict()
  if (from === 'prepared') {
    // Consume the exact acknowledged preparation capability, never a copy or a
    // cold read. Do not enlist an unchanged-prepared check: this mutation
    // deliberately advances that same immutable reservation to entered.
    const item = prepared && issued.get(prepared)
    if (!item || item.owner !== owner || item.record.phase !== 'prepared'
      || !sameRepeatValue(item.record.reservation, record.reservation)
      || !sameRepeatValue(row.transition, item.record)
      || item.record.launchDigest !== record.launchDigest
      || row.source_id !== item.receipt.evidence.sourceId || row.source_digest !== item.receipt.sourceDigest) return conflict()
    await assertRepeatCanonicalReceiptLocked(sql, item.receipt)
    issued.delete(prepared!)
  } else if (prepared !== undefined) return conflict()
  const fence = await owner.readOneShotFence(sql)
  if (fence.ownerId !== record.ownerId || fence.fence !== record.ownerFence) return conflict()
  const result = await sql.query(`update workflow_native_entries set phase=$6,transition=$3::jsonb,
    source_id=$4,source_digest=$5 where execution_id=$1 and run_id=$2 and phase=$7 returning execution_id`,
  [record.reservation.execution.executionId, owner.runId, canonicalGraphJson(record), receipt.evidence.sourceId, receipt.sourceDigest, record.phase, from])
  if (result.rowCount !== 1) return conflict()
  let entries = pending.get(sql)
  if (!entries) { entries = new Map(); pending.set(sql, entries) }
  if (entries.has(record.reservation.execution.executionId)) return conflict()
  entries.set(record.reservation.execution.executionId, { owner, record: structuredClone(record), receipt: structuredClone(receipt) })
  requireRepeatCanonicalReceiptBeforeCommit(sql, receipt)
  beforeGraphCommit(sql, async () => {
    try {
      const current = await readWorkflowNativeEntryLocked(sql, record.reservation)
      if (current.phase !== record.phase || !sameRepeatValue(current.transition, record)
        || current.source_id !== receipt.evidence.sourceId || current.source_digest !== receipt.sourceDigest) return conflict()
      const fence = await owner.readOneShotFence(sql)
      if (fence.ownerId !== record.ownerId || fence.fence !== record.ownerFence) return conflict()
    } catch (error) { poisonGraphTransaction(sql); throw error }
  })
}

/** Only the successful transaction acknowledgement can release this capability.
 * A failed/ambiguous COMMIT or cold receipt read cannot recreate it. */
export function releaseWorkflowNativeEntryPermit(sql: GraphTransactionSql, owner: Owner,
  executionId: string): WorkflowNativeEntryPermit {
  owner.assertOwned()
  const item = pending.get(sql)?.get(executionId)
  if (!didGraphTransactionCommit(sql) || owner.oneShotConnection().unusable || !item || item.owner !== owner) return conflict()
  pending.get(sql)!.delete(executionId)
  const permit = Object.freeze({ executionId })
  issued.set(permit, item)
  return permit
}
export async function assertWorkflowNativeEntryPermitLocked(sql: GraphTransactionSql, owner: Owner,
  permit: WorkflowNativeEntryPermit, reservation: WorkflowNativeReservation): Promise<void> {
  assertGraphTransaction(sql); owner.assertOwned()
  const item = issued.get(permit)
  if (!item || item.owner !== owner || item.record.phase !== 'entered' || permit.executionId !== reservation.execution.executionId
    || !sameRepeatValue(item.record.reservation, reservation)) return conflict()
  const check = async () => {
    owner.assertOwned()
    const current = await readWorkflowNativeEntryLocked(sql, reservation)
    const fence = await owner.readOneShotFence(sql)
    if (current.phase !== 'entered' || !sameRepeatValue(current.transition, item.record)
      || current.source_id !== item.receipt.evidence.sourceId || current.source_digest !== item.receipt.sourceDigest
      || fence.ownerId !== item.record.ownerId || fence.fence !== item.record.ownerFence) return conflict()
    await assertRepeatCanonicalReceiptLocked(sql, item.receipt)
  }
  try { await check(); beforeGraphCommit(sql, check) }
  catch (error) { poisonGraphTransaction(sql); throw error }
}

export function nativeEntrySourceId(record: WorkflowNativeEntryRecord): string {
  return repeatId('workflow-native-entry', record.reservation.scope.runId, record.reservation.execution.executionId, record.phase)
}

/** Seal an allocated reservation before the native submission boundary. The
 * Run lock and monotonic phase CAS arbitrate against the one-use entered grant.
 * There is deliberately no entered -> not_submitted transition. */
export async function sealWorkflowNativeEntryLocked(sql: GraphTransactionSql, owner: Owner,
  record: WorkflowNativeEntryRecord, receipt: RepeatCanonicalReceipt): Promise<void> {
  assertGraphTransaction(sql); owner.assertOwned()
  if (record.phase !== 'not_submitted' || record.reservation.scope.runId !== owner.runId) return conflict()
  const allowed = await sql.query(`select 1 from runs r where r.id=$1 and (
    r.stop_requested_at is not null or r.execution_state in ('completed','interrupted')
    or exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending)
    or exists(select 1 from harness_executions e join approval_execution_state b on b.execution_id=e.id
      where e.id=$2 and e.run_id=r.id and b.failure_result is not null))`,
  [owner.runId, record.reservation.execution.executionId])
  if (allowed.rowCount !== 1) return conflict()
  await sealNativeEntryLocked(sql, owner, record, receipt)
}

/** A failed preparation can close only the still-reserved entry, before launch. */
export async function sealWorkflowPreparationFailureLocked(sql: GraphTransactionSql, owner: Owner,
  record: WorkflowNativeEntryRecord, receipt: RepeatCanonicalReceipt): Promise<void> {
  assertGraphTransaction(sql)
  owner.assertOwned()
  const previous = await readWorkflowNativeEntryLocked(sql, record.reservation)
  if (previous.phase !== 'reserved' || record.launchDigest !== null) return conflict()
  await sealNativeEntryLocked(sql, owner, record, receipt)
}

async function sealNativeEntryLocked(sql: GraphTransactionSql, owner: Owner,
  record: WorkflowNativeEntryRecord, receipt: RepeatCanonicalReceipt): Promise<void> {
  assertGraphTransaction(sql)
  owner.assertOwned()
  if (record.phase !== 'not_submitted' || record.reservation.scope.runId !== owner.runId) return conflict()
  const previous = await readWorkflowNativeEntryLocked(sql, record.reservation)
  if (!['reserved', 'prepared'].includes(previous.phase)) return conflict()
  if (previous.phase === 'prepared') {
    if (!previous.transition || previous.transition.phase !== 'prepared' || !previous.source_id || !previous.source_digest
      || previous.transition.launchDigest !== record.launchDigest) return conflict()
    await assertRepeatCanonicalReceiptLocked(sql, { scope: record.reservation.scope,
      evidence: { sourceKind: 'execution', sourceId: previous.source_id, sourceRevision: '1' },
      sourceDigest: previous.source_digest, effect: null })
  }
  const fence = await owner.readOneShotFence(sql)
  if (fence.ownerId !== record.ownerId || fence.fence !== record.ownerFence) return conflict()
  const changed = await sql.query(`update workflow_native_entries set phase='not_submitted',transition=$3::jsonb,
    source_id=$4,source_digest=$5 where execution_id=$1 and run_id=$2 and phase=$6 returning execution_id`,
  [record.reservation.execution.executionId, owner.runId, canonicalGraphJson(record), receipt.evidence.sourceId,
    receipt.sourceDigest, previous.phase])
  if (changed.rowCount !== 1) return conflict()
  requireRepeatCanonicalReceiptBeforeCommit(sql, receipt)
  beforeGraphCommit(sql, async () => {
    try {
      owner.assertOwned()
      const current = await readWorkflowNativeEntryLocked(sql, record.reservation)
      if (current.phase !== 'not_submitted' || !sameRepeatValue(current.transition, record)
        || current.source_id !== receipt.evidence.sourceId || current.source_digest !== receipt.sourceDigest
        || !sameRepeatValue(fence, await owner.readOneShotFence(sql))) return conflict()
    } catch (error) { poisonGraphTransaction(sql); throw error }
  })
}

/** Read a positive seal, not the absence of submission records. Its immutable
 * reservation includes occurrence, configuration and input identity; the
 * canonical receipt proves the negative transition committed with its effect. */
export async function assertWorkflowNativeNotSubmittedLocked(sql: GraphTransactionSql,
  reservation: WorkflowNativeReservation): Promise<WorkflowNativeEntryRecord> {
  const row = await readWorkflowNativeEntryLocked(sql, reservation)
  await assertRepeatCanonicalReceiptLocked(sql, notSubmittedReceipt(row, reservation))
  return structuredClone(row.transition!)
}

/** Read-only counterpart for Save admission. It cannot seal an entry, finalize
 * a session, or reconstruct the one-use launch capability from persisted data. */
export async function readWorkflowNativeNotSubmitted(sql: GraphSqlClient,
  reservation: WorkflowNativeReservation): Promise<WorkflowNativeEntryRecord> {
  const row = await readWorkflowNativeEntry(sql, reservation)
  await assertRepeatCanonicalReceipt(sql, notSubmittedReceipt(row, reservation))
  return structuredClone(row.transition!)
}
function notSubmittedReceipt(row: NativeEntryRow, reservation: WorkflowNativeReservation): RepeatCanonicalReceipt {
  if (row.phase !== 'not_submitted' || row.transition?.phase !== 'not_submitted'
    || !sameRepeatValue(row.transition.reservation, reservation) || !row.source_id || !row.source_digest) return conflict()
  return { scope: reservation.scope,
    evidence: { sourceKind: 'execution', sourceId: row.source_id, sourceRevision: '1' },
    sourceDigest: row.source_digest, effect: null }
}
