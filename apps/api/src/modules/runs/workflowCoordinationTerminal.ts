import { ExecutionResultSchema, type ExecutionResult, type HarnessExecution } from '@foreman-code/contracts'
import { GraphExecutionIdentitySchema, RunGraphScopeSchema, canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { RemoteOperationReceiptSchema, remoteWorkflowTurnId } from '@foreman-code/contracts/remote-execution'
import { REMOTE_NATIVE_SOURCE_LIMIT } from '@foreman-code/contracts/remote-workflow-physical'
import { z } from 'zod'
import { assertGraphTransaction, type GraphTransactionSql } from '../run-graph/connection.js'
import { assertRepeatCanonicalReceiptLocked, requireRepeatCanonicalReceiptBeforeCommit } from '../run-graph/repeatReceipts.js'
import { repeatConflict, repeatDigest, repeatExecutionIdentity, sameRepeatValue } from './repeatResolution.js'
import type { RepeatNativeChange } from './repeatNativeRepository.js'
import type { WorkflowNativeProofRecord } from './workflowNativeProof.js'
import { readAcceptedPlacement, readDispatchIntent } from '../placement/persistence.js'
import { readWorkResultRepairAttempt, workResultRepairCorrelation } from './workResultRepair.js'

const TerminalSchema = z.object({
  scope: RunGraphScopeSchema,
  execution: GraphExecutionIdentitySchema,
  nativeProofId: z.string().min(1),
  nativeCorrelationId: z.string().min(1),
  nativeProviderId: z.string().min(1),
  nativeResultDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  result: ExecutionResultSchema,
  sourceId: z.string().min(1),
  sourceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict()
export type WorkflowCoordinationTerminal = z.infer<typeof TerminalSchema>

/** The native observation's existing canonical source owns this small retained
 * normalization receipt. It is written in the same terminal/F1 transaction. */
export async function recordWorkflowCoordinationTerminalLocked(sql: GraphTransactionSql,
  change: RepeatNativeChange, proof: WorkflowNativeProofRecord): Promise<void> {
  assertGraphTransaction(sql)
  if (change.next.state !== 'completed' || !change.next.result
    || proof.original.type !== 'history' || !proof.original.history.terminalTurn) return
  const terminal = proof.original.history.terminalTurn, nativeResult = terminal.result
  if (terminal.correlationId !== workResultRepairCorrelation(change.next.id,
    await readWorkResultRepairAttempt(sql, change.next.id))) return repeatConflict('NATIVE_TURN_IDENTITY_CONFLICT')
  const record = TerminalSchema.parse({ scope: change.scope, execution: repeatExecutionIdentity(change.next),
    nativeProofId: proof.proofId, nativeCorrelationId: terminal.correlationId, nativeProviderId: terminal.providerId,
    nativeResultDigest: repeatDigest(nativeResult, REMOTE_NATIVE_SOURCE_LIMIT),
    result: change.next.result, sourceId: change.sourceId, sourceDigest: change.sourceDigest })
  const json = canonicalGraphJson(record, 256 * 1024)
  const inserted = await sql.query(`insert into workflow_coordination_terminals
    (execution_id,run_id,native_proof_id,record,record_json,record_digest)
    values($1,$2,$3,$4::text::jsonb,$4::text,$5) on conflict(execution_id) do update
      set record=workflow_coordination_terminals.record
      where workflow_coordination_terminals.record=excluded.record returning execution_id`,
  [change.next.id, change.scope.runId, proof.proofId, json, repeatDigest(record, 256 * 1024)])
  if (inserted.rowCount !== 1) return repeatConflict('COORDINATION_TERMINAL_CONFLICT')
}

export async function readWorkflowCoordinationTerminalLocked(sql: GraphTransactionSql,
  execution: HarnessExecution): Promise<(WorkflowCoordinationTerminal & { nativeResult: ExecutionResult; settled: boolean }) | undefined> {
  assertGraphTransaction(sql)
  const row = (await sql.query<{ record: unknown; record_digest: string; native_proof: WorkflowNativeProofRecord;
    settled_native_proof_id: string | null }>(
    `select t.record,t.record_digest,t.settled_native_proof_id,p.record as native_proof from workflow_coordination_terminals t
      join workflow_native_proofs p on p.proof_id=t.native_proof_id and p.run_id=t.run_id and p.execution_id=t.execution_id
      where t.execution_id=$1 and t.run_id=$2`, [execution.id, execution.runId])).rows[0]
  if (!row) return undefined
  const record = TerminalSchema.parse(row.record), proof = row.native_proof
  if (execution.state !== 'completed' || !execution.result
    || !sameRepeatValue(record.execution, repeatExecutionIdentity(execution))
    || record.scope.runId !== execution.runId || record.nativeProofId !== proof.proofId
    || !sameRepeatValue(proof.scope, record.scope) || !sameRepeatValue(proof.execution, record.execution)
    || proof.original.type !== 'history'
    || proof.original.history.terminalTurn?.correlationId !== record.nativeCorrelationId
    || proof.original.history.terminalTurn.providerId !== record.nativeProviderId
    || !sameRepeatValue(record.result, execution.result)
    || repeatDigest(proof.original.history.terminalTurn.result, REMOTE_NATIVE_SOURCE_LIMIT) !== record.nativeResultDigest
    || repeatDigest(record, 256 * 1024) !== row.record_digest) return repeatConflict('COORDINATION_TERMINAL_CONFLICT')
  const receipt = { scope: record.scope, evidence: { sourceKind: 'execution' as const,
    sourceId: record.sourceId, sourceRevision: '1' }, sourceDigest: record.sourceDigest, effect: null }
  await assertRepeatCanonicalReceiptLocked(sql, receipt)
  requireRepeatCanonicalReceiptBeforeCommit(sql, receipt)
  // The original proof remains the sole native-result owner. A malformed
  // oversized envelope can fail validation without copying or truncating its
  // source bytes into this bounded normalization receipt.
  return { ...record, nativeResult: proof.original.history.terminalTurn!.result,
    settled: row.settled_native_proof_id !== null }
}

export async function markWorkflowCoordinationTerminalSettledLocked(sql: GraphTransactionSql,
  execution: HarnessExecution, proof: WorkflowNativeProofRecord): Promise<void> {
  const retained = await readWorkflowCoordinationTerminalLocked(sql, execution)
  if (!retained || proof.original.type !== 'history'
    || proof.original.history.terminalTurn?.correlationId !== retained.nativeCorrelationId
    || proof.original.history.terminalTurn.providerId !== retained.nativeProviderId
    || !sameRepeatValue(proof.original.history.terminalTurn.result, retained.nativeResult)) {
    return repeatConflict('COORDINATION_TERMINAL_CONFLICT')
  }
  const placement = await readAcceptedPlacement(sql, execution.runId, execution.workflowNodeId)
  if (placement?.hostRef.kind === 'device') {
    const intent = await readDispatchIntent(sql, execution.id)
    const row = intent && (await sql.query<{ receipt: unknown }>(
      'select receipt from remote_execution_receipts where operation_id=$1 for share', [intent.operationId])).rows[0]
    const remote = row && RemoteOperationReceiptSchema.parse(row.receipt)
    const result = remote?.terminal?.result ?? remote?.retainedReviewer?.result
    if (!remote || remoteWorkflowTurnId(remote, retained.nativeCorrelationId) !== retained.nativeProviderId
      || !sameRepeatValue(result, retained.nativeResult)
      || remote.retainedReviewer && !remote.terminal && !sameRepeatValue(execution.result, result)) {
      return repeatConflict('REPEAT_CLEANUP_PENDING')
    }
  }
  await sql.query(`update workflow_coordination_terminals set settled_native_proof_id=$3
    where execution_id=$1 and run_id=$2 and settled_native_proof_id is null`,
  [execution.id, execution.runId, proof.proofId])
}

/** Original remote bytes can differ only by the already committed first-terminal
 * normalization, never by a newly supplied outcome or a repaired old terminal. */
export async function matchesWorkflowNativeTerminalLocked(sql: GraphTransactionSql,
  execution: HarnessExecution, nativeResult: ExecutionResult | undefined): Promise<boolean> {
  if (sameRepeatValue(execution.result, nativeResult)) return true
  if (!nativeResult || execution.state !== 'completed') return false
  const record = await readWorkflowCoordinationTerminalLocked(sql, execution)
  return !!record && sameRepeatValue(record.nativeResult, nativeResult)
}
