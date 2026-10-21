import type { TransferContext } from '@foreman-code/contracts/byte-transfer'
import type { WorkflowNativeCapture } from '../../interactions/workflowNativeCapture.js'
import type { GraphTransactionSql } from '../../run-graph/connection.js'
import type { RepeatNativeEvidence } from '../repeatNativeRepository.js'
import type { WorkflowNativeProofRecord } from '../workflowNativeProof.js'
import { WorkflowNativeFileContextAdmission, type WorkflowNativeFileContextPorts } from './workflowNativeFileContext.js'

/** Called only after the original proof is stored, on that same open G1. */
export function createProductionWorkflowFileContexts(mainId: string, ports: WorkflowNativeFileContextPorts & {
  transferContext(capture: WorkflowNativeCapture): TransferContext | undefined
}) {
  const admission = new WorkflowNativeFileContextAdmission(mainId, ports)
  return async (sql: GraphTransactionSql, evidence: RepeatNativeEvidence, proof: WorkflowNativeProofRecord): Promise<void> => {
    const capture = ports.captures.read(evidence)
    if (capture.session.harness !== 'codex' || !capture.lane?.providerId
      || !['running', 'waiting'].includes(capture.execution.state)
      || capture.source.type !== 'event' && capture.source.type !== 'history'
      || capture.source.type === 'event' && capture.source.event.type !== 'turn.started'
      || capture.source.type === 'history' && capture.source.history.terminalTurn) return
    const transfer = ports.transferContext(capture)
    if (!transfer) return // Only an original active distributed device publisher can admit context.
    await admission.resolveOrAdmitLocked(sql, evidence, proof, transfer)
  }
}
