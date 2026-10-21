import { createHash } from 'node:crypto'
import { RemoteOperationReceiptSchema, RemoteOwnerReconciliationSchema, type RemoteOwnerReconciliation, type RemoteOperationReceipt } from '@foreman-code/contracts/remote-execution'
import { WorkerObservationSchema, DispatchIntentSchema, type WorkerObservation } from '@foreman-code/contracts/node-placement'
import { canonicalGraphJson, sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { assertGraphTransaction, beforeGraphCommit, type GraphTransactionSql } from '../../run-graph/connection.js'
import type { RunOwnership } from '../ownership.js'
import { VerifiedRemoteEvidence } from './resultBridge.js'

/** Accepted dispatch is immutable; current native grant renewal is a separate audited fact. */
export async function readReconciledDispatchIntent(sql: Pick<GraphTransactionSql, 'query'>, operationId: string, lock = false) {
  if (lock) {
    // Credential and artifact operations lock the parent before its dispatch.
    await sql.query(`select r.id from runs r join execution_dispatch_intents i on i.run_id=r.id
      where i.operation_id=$1 for share of r`, [operationId])
  }
  const rows = await sql.query<{ record: unknown }>(`select record from execution_dispatch_intents where operation_id=$1${lock ? ' for update' : ''}`, [operationId])
  if (!rows.rows[0]) return undefined
  const original = DispatchIntentSchema.parse(rows.rows[0].record)
  const transitions = await sql.query<{ transition: unknown }>('select transition from remote_execution_owner_reconciliations where operation_id=$1 order by ordinal desc limit 1', [operationId])
  const transition = transitions.rows[0] ? RemoteOwnerReconciliationSchema.parse(transitions.rows[0].transition) : undefined
  return transition ? DispatchIntentSchema.parse({ ...original, owner: transition.nextOwner }) : original
}
export async function persistRemoteOwnerReconciliation(sql: GraphTransactionSql, owner: RunOwnership, raw: RemoteOwnerReconciliation,
  verifyOriginalNativeAndLiveGrant: () => Promise<void>) {
  assertGraphTransaction(sql); owner.assertOwned()
  const transition = RemoteOwnerReconciliationSchema.parse(raw)
  const current = await readReconciledDispatchIntent(sql, transition.operationId, true)
  if (!current || current.runId !== owner.runId) throw new Error('Original remote Run ownership required')
  const existing = await sql.query<{ transition: unknown }>('select transition from remote_execution_owner_reconciliations where command_id=$1', [transition.commandId])
  if (existing.rows[0]) {
    if (!sameWorkflowValue(RemoteOwnerReconciliationSchema.parse(existing.rows[0].transition), transition)) throw new Error('Reconciliation command conflict')
    return current
  }
  if (!sameWorkflowValue(current.owner, transition.previousOwner) || BigInt(transition.nextOwner.epoch) <= BigInt(transition.previousOwner.epoch)) throw new Error('Remote owner renewal conflict')
  const receipts = await sql.query<{ receipt: unknown }>('select receipt from remote_execution_receipts where operation_id=$1 for update', [transition.operationId])
  const original = receipts.rows[0] ? RemoteOperationReceiptSchema.parse(receipts.rows[0].receipt) : undefined
  if (!original?.native || !sameWorkflowValue(original.native, transition.native)) throw new Error('Original native renewal evidence missing')
  await verifyOriginalNativeAndLiveGrant()
  await owner.readOneShotFence(sql)
  await sql.query('insert into remote_execution_owner_reconciliations(operation_id,command_id,transition) values($1,$2,$3::jsonb)', [transition.operationId, transition.commandId, canonicalGraphJson(transition)])
  beforeGraphCommit(sql, async () => { owner.assertOwned(); await owner.readOneShotFence(sql); await verifyOriginalNativeAndLiveGrant() })
  return DispatchIntentSchema.parse({ ...current, owner: transition.nextOwner })
}

/** Called from the bridge's canonical acceptance transaction, never from a worker. */
export async function persistVerifiedRemoteReceipt(sql: GraphTransactionSql, owner: RunOwnership, verified: VerifiedRemoteEvidence,
  assertLiveAuthority: () => Promise<void>): Promise<void> {
  assertGraphTransaction(sql); owner.assertOwned()
  if (!(verified instanceof VerifiedRemoteEvidence) || owner.runId !== verified.receipt.intent.runId) throw new Error('Verified remote Run ownership required')
  const receipt = RemoteOperationReceiptSchema.parse(verified.receipt)
  const fence = await owner.readOneShotFence(sql)
  const verify = async () => {
    owner.assertOwned(); const current = await owner.readOneShotFence(sql)
    if (!sameWorkflowValue(current, fence)) throw new Error('Remote receipt scheduler ownership lost')
    await assertLiveAuthority()
    const intent = await readReconciledDispatchIntent(sql, receipt.intent.operationId, true)
    if (!intent || !sameWorkflowValue(intent, receipt.intent)) throw new Error('Remote receipt dispatch ownership mismatch')
  }
  await verify()
  const prior = await sql.query<{ receipt: unknown }>('select receipt from remote_execution_receipts where operation_id=$1 for update', [receipt.intent.operationId])
  if (prior.rows[0]) {
    const existing = RemoteOperationReceiptSchema.parse(prior.rows[0].receipt)
    if (receipt.sequence <= existing.sequence) {
      if (sameWorkflowValue(existing, receipt)) return
      throw new Error('Remote receipt sequence conflict')
    }
    if (existing.terminal && !sameWorkflowValue(existing.terminal, receipt.terminal)) throw new Error('Remote terminal evidence conflict')
  }
  await sql.query(`insert into remote_execution_receipts(operation_id,sequence,receipt) values($1,$2,$3::jsonb)
    on conflict(operation_id) do update set sequence=excluded.sequence,receipt=excluded.receipt`, [receipt.intent.operationId, receipt.sequence, canonicalGraphJson(receipt)])
  beforeGraphCommit(sql, verify)
}
export async function auditRejectedRemoteReceipt(sql: GraphTransactionSql, receipt: RemoteOperationReceipt, reason: string) {
  assertGraphTransaction(sql)
  // Hash only: rejected reports cannot persist arbitrary credential-bearing payloads.
  const digest = createHash('sha256').update(canonicalGraphJson(receipt)).digest('hex')
  await sql.query('select operation_id from execution_dispatch_intents where operation_id=$1 for update', [receipt.intent.operationId])
  await sql.query(`insert into remote_execution_recovery_audit(operation_id,reason,evidence_digest)
    select operation_id,$2,$3 from execution_dispatch_intents where operation_id=$1`, [receipt.intent.operationId, reason.slice(0, 100), digest])
  await sql.query(`delete from remote_execution_recovery_audit where operation_id=$1 and ordinal not in
    (select ordinal from remote_execution_recovery_audit where operation_id=$1 order by ordinal desc limit 32)`, [receipt.intent.operationId])
}
export async function readRemoteReceipts(sql: Pick<GraphTransactionSql, 'query'>, runId: string, nodeId: string): Promise<RemoteOperationReceipt[]> {
  const rows = await sql.query<{ receipt: unknown }>(`select r.receipt from remote_execution_receipts r join execution_dispatch_intents i using(operation_id)
    where i.run_id=$1 and i.node_id=$2 order by i.execution_id`, [runId, nodeId])
  return rows.rows.map(row => {
    const receipt = RemoteOperationReceiptSchema.parse(row.receipt)
    if (receipt.intent.runId !== runId || receipt.intent.nodeId !== nodeId) throw new Error('Remote receipt readback binding mismatch')
    return receipt
  })
}
/** Physical milestone only; detailed Stop/uncertainty remains in readRemoteReceipts. */
export async function readRemoteObservations(sql: Pick<GraphTransactionSql, 'query'>, runId: string, nodeId: string): Promise<WorkerObservation[]> {
  return (await readRemoteReceipts(sql, runId, nodeId)).map(receipt => WorkerObservationSchema.parse({
    schemaVersion: 1, protocolVersion: 1, operationId: receipt.intent.operationId, attemptId: receipt.intent.attemptId,
    executionId: receipt.intent.executionId, bindingHash: receipt.intent.bindingHash, connection: receipt.connection,
    workerIncarnationId: receipt.workerIncarnationId, sequence: String(receipt.sequence),
    phase: receipt.phase === 'confirmed_terminal' ? 'terminal' : receipt.phase === 'running' ? 'running' : receipt.native ? 'entered' : 'accepted',
    ...(receipt.native ? { native: { sessionId: receipt.native.sessionId, ...(receipt.native.turnId ? { turnId: receipt.native.turnId } : {}) } } : {}),
    ...(receipt.terminal?.resultDigest ? { resultDigest: receipt.terminal.resultDigest } : {}), artifactDigests: receipt.terminal?.artifactDigests ?? [],
  }))
}
