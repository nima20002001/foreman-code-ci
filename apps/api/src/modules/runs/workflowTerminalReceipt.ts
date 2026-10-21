import { DomainError } from '../errors.js'
import { assertOriginalWorkflowTerminal } from '../interactions/workflowTerminalSource.js'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { assertRepeatCanonicalReceiptLocked, requireRepeatCanonicalReceiptBeforeCommit } from '../run-graph/repeatReceipts.js'
import type { StoredRepeatExecution } from './repeatPostgres.js'
import type { AcceptedRepeatRunSnapshot } from './repeatStartRead.js'
import { repeatDigest, repeatExecutionIdentity, sameRepeatValue } from './repeatResolution.js'
import type { WorkflowNativeProofRecord } from './workflowNativeProof.js'
import { assertWorkflowCorrelation, readWorkResultRepairAttempt, workResultRepairCorrelation } from './workResultRepair.js'

/** The original successful native terminal is recoverable independently of its
 * later business acceptance. Every stored source still needs its canonical receipt. */
export async function readWorkflowTerminalReceiptLocked(sql: GraphTransactionSql,
  snapshot: AcceptedRepeatRunSnapshot, stored: StoredRepeatExecution) {
  const { run, version } = snapshot
  const { execution } = stored
  const candidates = (await sql.query<{ record: WorkflowNativeProofRecord; source_digest: string }>(
    `select record,source_digest from workflow_native_proofs where run_id=$1 and execution_id=$2
      and record#>>'{original,type}'='history'
      and record#>>'{original,history,terminalTurn,result,outcome}'='succeeded' order by proof_id for share`,
    [run.id, execution.id])).rows
  const command = workResultRepairCorrelation(execution.id, await readWorkResultRepairAttempt(sql, execution.id))
  const rows = candidates.filter(({ record }) => record.original.type === 'history'
    && record.original.history.correlationId === command)
  const conflict = (): never => {
    throw new DomainError('WORKFLOW_TERMINAL_SOURCE_CONFLICT', 'The original committed native terminal does not match this execution.', 409)
  }
  if (!rows.length || execution.state !== 'completed' || execution.result?.outcome !== 'succeeded') return conflict()
  for (const row of rows) {
    const proof = row.record
    if (proof.scope.runId !== run.id || proof.scope.workflowVersionId !== version.id
      || proof.scope.workspaceId !== run.workspaceId || proof.scope.workflowId !== run.workflowId
      || proof.scope.executionSemanticsVersion !== 3 || proof.original.type !== 'history'
      || proof.inputDigest !== stored.inputDigest || !sameRepeatValue(proof.ref, stored.ref)
      || !sameRepeatValue(proof.execution, repeatExecutionIdentity(execution))
      || proof.session.nativeSessionId !== execution.nativeSessionId || !proof.lane || !proof.closureGeneration
      || proof.commandId !== `execution:${execution.id}`
      || !sameRepeatValue(proof.original.history.terminalTurn?.result, execution.result)
      || row.source_digest !== repeatDigest(proof, 4 * 1024 * 1024)) return conflict()
    await assertWorkflowCorrelation(sql, execution.id, command)
    assertOriginalWorkflowTerminal(execution, proof.session, proof.original.history, command)
    const receipt = { scope: proof.scope, evidence: { sourceKind: 'native_event' as const,
      sourceId: proof.proofId, sourceRevision: '1' }, sourceDigest: row.source_digest, effect: null }
    await assertRepeatCanonicalReceiptLocked(sql, receipt)
    requireRepeatCanonicalReceiptBeforeCommit(sql, receipt)
  }
  return { proof: rows[0]!.record, sourceDigest: rows[0]!.source_digest }
}
