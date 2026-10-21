import { randomUUID } from 'node:crypto'
import type { ExecutionResult } from '@foreman-code/contracts'
import { RemoteOperationReceiptSchema, type RemoteOperationReceipt } from '@foreman-code/contracts/remote-execution'
import type { AcceptedArtifactPublication } from '../../files/distributed/publication.js'
import { repeatDigest } from '../repeatResolution.js'

export function artifactWorkflowReceipt(accepted: AcceptedArtifactPublication, result: ExecutionResult): RemoteOperationReceipt {
  const { attempt, transferContext, context } = accepted
  const { connectionEpoch: _connectionEpoch, ...connection } = transferContext
  void _connectionEpoch
  return RemoteOperationReceiptSchema.parse({ schemaVersion: 1,
    intent: { schemaVersion: 1, protocolVersion: 1, mainId: transferContext.mainId,
      runId: attempt.runId, nodeId: attempt.nodeId, executionId: attempt.executionId, occurrenceId: null,
      occurrenceIndex: 0, technicalAttempt: 1, attemptId: attempt.attemptId, operationId: randomUUID(),
      bindingHash: attempt.placementHash, inputDigest: repeatDigest({}), owner: { grantId: 'owner', epoch: '1' } },
    connection: { ...connection, connectionGeneration: 1 },
    workerIncarnationId: randomUUID(), sequence: 1, phase: 'confirmed_terminal',
    native: { sessionId: context.nativeSessionId, turnId: context.turnId, processIdentityDigest: 'a'.repeat(64) },
    turnInput: { correlationId: `execution:${attempt.executionId}`, promptDigest: 'b'.repeat(64),
      sessionMode: 'regular', deferSettlement: true },
    terminal: { kind: 'completed', result, closureEvidenceDigest: 'c'.repeat(64) },
    entryAttempted: true, turnEntryAttempted: true, stopFence: false, controls: [] })
}

export function completeResultRepair(receipt: RemoteOperationReceipt, turnId: string): string {
  if (!receipt.native?.turnId) throw new Error('A preceding native turn is required')
  const previousInput = receipt.turnInput ?? { correlationId: `execution:${receipt.intent.executionId}`,
    promptDigest: 'b'.repeat(64), sessionMode: 'regular' as const, deferSettlement: true as const }
  const repairs = receipt.resultRepairs ??= []
  repairs.push({ previousInput, previousTurnId: receipt.native.turnId, afterSequence: repairs.length + 1 })
  const retries = receipt.nativeTurnRetries ??= []
  retries.push({ previousTurnId: receipt.native.turnId, turnId })
  const correlationId = `execution:${receipt.intent.executionId}:result-repair:${repairs.length}`
  receipt.native.turnId = turnId
  receipt.turnInput = { ...previousInput, correlationId }
  receipt.sequence++
  RemoteOperationReceiptSchema.parse(receipt)
  return correlationId
}
