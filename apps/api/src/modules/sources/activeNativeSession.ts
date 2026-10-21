import { isDeepStrictEqual } from 'node:util'
import { HarnessExecutionSchema, NativeSessionReferenceSchema, NativeSessionLaneSchema,
  type HarnessExecution, type NativeSessionReference } from '@foreman-code/contracts'
import { SourceActiveNativeSessionSchema, type SourceActiveNativeSession } from '@foreman-code/contracts/source-operations'
import type { SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { readAcceptedPlacement, readDispatchIntent, readNativePlacement } from '../placement/persistence.js'
import { readReconciledDispatchIntent } from '../runs/remote/persistence.js'
import { readNativeExecutionBinding } from '../placement/executionBinding.js'
import { repeatExecutionIdentity } from '../runs/repeatResolution.js'
import { sourceMaterializationDigest } from './bindingHash.js'
import { sourceSha256 } from './manifest.js'
import { DomainError } from '../errors.js'

export interface SourceOwnedNativeSession {
  execution: HarnessExecution; session: NativeSessionReference; generation: number
  writer: { id: string; token: string; connectionGeneration: number }; signal: AbortSignal; assertCurrent(): Promise<void> | void
}
/** An entered COMMIT permits the first allocation; it is not an allocated
 * session. Only an actual original session row switches to continuation. */
export async function readSourceCurrentNativeSession(sql: GraphSqlClient, record: SourceMaterializationRecord,
  captures: readonly SourceOwnedNativeSession[]): Promise<SourceActiveNativeSession | null> {
  if (record.receipt.binding.accessMode !== 'exclusive-write') return null
  await readReconciledDispatchIntent(sql, record.operationId, true)
  const row = (await sql.query<{ reference: unknown; finalized: boolean }>(
    'select reference,workflow_finalized_at is not null as finalized from execution_native_sessions where execution_id=$1 for share',
    [record.receipt.executionId])).rows[0]
  if (!row) return null
  const session = NativeSessionReferenceSchema.safeParse(row.reference)
  const owned = captures.filter(capture => capture.execution.id === record.receipt.executionId)
  if (row.finalized || !session.success || owned.length !== 1 || !isDeepStrictEqual(session.data, owned[0]!.session))
    throw new DomainError('SOURCE_NATIVE_SESSION_CONFLICT', 'The allocated original native session no longer has its current exact installed owner.', 409)
  const proof = await readSourceActiveNativeSession(sql, record, owned[0]!)
  if (!proof) throw new DomainError('SOURCE_NATIVE_SESSION_CONFLICT', 'The allocated original native session lacks current entered placement and writer authority.', 409)
  return proof
}
/** Read-only SQL qualification of the ORIGINAL entered lifetime. The capture is
 * supplied by the installed manager, never reconstructed from these rows. */
export async function readSourceActiveNativeSession(sql: GraphSqlClient, record: SourceMaterializationRecord,
  capture: SourceOwnedNativeSession): Promise<SourceActiveNativeSession | null> {
  capture.signal.throwIfAborted(); await capture.assertCurrent()
  if (record.receipt.binding.accessMode !== 'exclusive-write' || !record.finalDispatchBindingHash
    || capture.execution.id !== record.receipt.executionId) return null
  const intent = await readReconciledDispatchIntent(sql, record.operationId, true)
  const row = (await sql.query<{ record: unknown }>('select record from harness_executions where id=$1 and run_id=$2 for share',
    [capture.execution.id, capture.execution.runId])).rows[0]
  const execution = HarnessExecutionSchema.safeParse(row?.record)
  if (!execution.success || execution.data.id !== capture.execution.id || execution.data.runId !== capture.execution.runId
    || !isDeepStrictEqual(repeatExecutionIdentity(execution.data), repeatExecutionIdentity(capture.execution))
    || execution.data.nativeSessionId !== capture.session.nativeSessionId) return null
  const original = await readDispatchIntent(sql, execution.data.id)
  const placement = await readAcceptedPlacement(sql, execution.data.runId, execution.data.workflowNodeId)
  const rawNative = await readNativePlacement(sql, execution.data.id)
  if (!original || !intent || !placement || !rawNative || original.operationId !== record.operationId
    || original.bindingHash !== intent.bindingHash || intent.executionId !== execution.data.id || intent.runId !== execution.data.runId
    || intent.nodeId !== execution.data.workflowNodeId || intent.technicalAttempt !== execution.data.attempt
    || intent.attemptId !== record.receipt.attemptId || intent.operationId !== record.operationId) return null
  const native = readNativeExecutionBinding(placement, intent, rawNative)
  if (native.bindingHash !== record.finalDispatchBindingHash || sourceMaterializationDigest(native.materialization) !== sourceMaterializationDigest(record)) return null
  const entry = (await sql.query<{ phase: string; reservation: { execution: unknown; scope: { runId: string } }; transition: {
    phase: string; reservation: unknown; launchDigest: string | null }; source_id: string | null; source_digest: string | null }>(
    'select phase,reservation,transition,source_id,source_digest from workflow_native_entries where execution_id=$1 and run_id=$2 for share',
    [execution.data.id, execution.data.runId])).rows[0]
  if (!entry || entry.phase !== 'entered' || entry.transition?.phase !== 'entered' || !entry.transition.launchDigest
    || !entry.source_id || !entry.source_digest || entry.reservation?.scope?.runId !== execution.data.runId
    || !isDeepStrictEqual(entry.reservation.execution, repeatExecutionIdentity(execution.data))
    || !isDeepStrictEqual(entry.transition.reservation, entry.reservation)) return null
  const sessionRow = (await sql.query<{ reference: unknown; finalized: boolean }>(
    'select reference,workflow_finalized_at is not null as finalized from execution_native_sessions where execution_id=$1 for share', [execution.data.id])).rows[0]
  const session = NativeSessionReferenceSchema.safeParse(sessionRow?.reference)
  if (!session.success || sessionRow?.finalized || !isDeepStrictEqual(session.data, capture.session)) return null
  const laneRow = (await sql.query<{ id: string; revision: number; record: unknown }>(`select id,revision,record from native_session_lanes
    where id=$1 and record->>'leaseToken'=$2 and (record->>'leaseExpiresAt')::timestamptz>clock_timestamp() for share`,
    [capture.writer.id, capture.writer.token])).rows[0]
  const lane = NativeSessionLaneSchema.safeParse(laneRow?.record)
  if (!laneRow || !lane.success || lane.data.id !== laneRow.id || lane.data.id !== capture.writer.id || lane.data.revision !== Number(laneRow.revision)
    || lane.data.leaseToken !== capture.writer.token || !lane.data.leaseOwner || !lane.data.leaseExpiresAt
    || Date.parse(lane.data.leaseExpiresAt) <= Date.now() || lane.data.ownerAgentId !== execution.data.agentId
    || lane.data.harness !== capture.session.harness || lane.data.nativeSessionId !== capture.session.nativeSessionId
    || lane.data.connectionGeneration !== capture.writer.connectionGeneration) return null
  const grant = await sql.query(`select 1 from execution_dispatch_owner_grants where execution_id=$1
    and operation_id=$2 and grant_id=$3 and epoch=$4 and not revoked for share`,
    [execution.data.id, record.operationId, intent.owner.grantId, intent.owner.epoch])
  if (grant.rowCount !== 1) return null
  await capture.assertCurrent(); capture.signal.throwIfAborted()
  return SourceActiveNativeSessionSchema.parse({ version: 1, executionId: execution.data.id, runId: execution.data.runId,
    technicalAttempt: execution.data.attempt, attemptId: record.receipt.attemptId, operationId: record.operationId,
    materializationId: record.receipt.materializationId, sourceBindingHash: record.sourceBindingHash,
    finalDispatchBindingHash: record.finalDispatchBindingHash, nativeSession: capture.session, generation: capture.generation,
    cwdAttestation: native.workingTree.cwdAttestation,
    entry: { sourceId: entry.source_id, sourceDigest: entry.source_digest, launchDigest: entry.transition.launchDigest }, owner: intent.owner,
    lane: { id: lane.data.id, revision: lane.data.revision, tokenHash: sourceSha256(Buffer.from(capture.writer.token)), expiresAt: lane.data.leaseExpiresAt } })
}
