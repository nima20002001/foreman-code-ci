import { isDeepStrictEqual as same } from 'node:util'
import { HarnessExecutionSchema, type HarnessExecution } from '@foreman-code/contracts'
import { ArtifactAttemptSchema } from '@foreman-code/contracts/artifact-edges'
import { TransferContextSchema } from '@foreman-code/contracts/byte-transfer'
import { RemoteOperationReceiptSchema, remoteWorkflowTurnId, remoteWorkflowHasTurn } from '@foreman-code/contracts/remote-execution'
import { workflowArtifactDigestsByOutputKey } from '@foreman-code/contracts/workflow-artifact-result'
import type { AcceptedWorkflowRunV3, WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { DomainError } from '../../errors.js'
import { assertOriginalWorkflowTerminal } from '../../interactions/workflowTerminalSource.js'
import { readDispatchIntent } from '../../placement/persistence.js'
import { assertGraphTransaction, beforeGraphCommit, poisonGraphTransaction, type GraphTransactionSql } from '../../run-graph/connection.js'
import { assertRepeatCanonicalReceiptLocked, requireRepeatCanonicalReceiptBeforeCommit } from '../../run-graph/repeatReceipts.js'
import { assertRepeatExecution, repeatDigest, repeatExecutionIdentity } from '../repeatResolution.js'
import type { WorkflowNativeProofRecord } from '../workflowNativeProof.js'
import type { PostgresArtifactPublicationAuthority } from './nativeArtifactAuthority.js'
import { assertNativeArtifactOutputLive, readNativeArtifactOutput } from './nativeArtifactOutputPostgres.js'
import { readReconciledDispatchIntent } from './persistence.js'
import { readWorkResultRepairAttempt, workResultRepairCorrelation } from '../workResultRepair.js'
import { workflowArtifactResult } from '../workflowCoordinationResult.js'

const pending = (): never => { throw new DomainError('WORKFLOW_ARTIFACT_OUTPUTS_PENDING',
  'The complete original artifact publications must be durably bound before accepting success.', 409) }
const conflict = (): never => { throw new DomainError('WORKFLOW_ARTIFACT_OUTPUTS_CONFLICT',
  'The original artifact publications differ from the saved execution and native result.', 409) }

/** Main-owned SQL-only gate. Adoption and canonical byte reads have already
 * completed outside G1. No process, transfer, credential, publication or output
 * is created here; replay resamples the same durable facts and current grants. */
export function createWorkflowArtifactOutputsGate(mainId: string,
  authority: Pick<PostgresArtifactPublicationAuthority,
    'resolveWorkflowContext' | 'resolvePublicationContext' | 'authorizePublication'>) {
  const verify = async (sql: GraphTransactionSql, run: AcceptedWorkflowRunV3,
    version: WorkflowVersionV3, supplied: HarnessExecution) => {
    const execution = HarnessExecutionSchema.parse(supplied)
    const node = version.definition.nodes.find(node => node.id === execution.workflowNodeId)
    if (node?.kind === 'job' || !node?.artifactOutputs) return
    if (execution.state !== 'completed' || execution.result?.outcome !== 'succeeded'
      || execution.runId !== run.id || version.id !== run.workflowVersionId
      || version.workspaceId !== run.workspaceId || version.workflowId !== run.workflowId) return conflict()
    const original = await readDispatchIntent(sql, execution.id)
    const intent = original && await readReconciledDispatchIntent(sql, original.operationId, true)
    if (!intent) return pending()
    if (intent.mainId !== mainId || intent.runId !== run.id || intent.nodeId !== node.id
      || intent.technicalAttempt !== execution.attempt || intent.inputDigest !== repeatDigest(execution.input)) return conflict()
    const receiptRow = (await sql.query<{ receipt: unknown }>(
      'select receipt from remote_execution_receipts where operation_id=$1 for share', [intent.operationId])).rows[0]
    if (!receiptRow) return pending()
    const remote = RemoteOperationReceiptSchema.parse(receiptRow.receipt)
    if (remote.terminal?.artifactValidationError) return conflict()
    const correlationId = remote.turnInput?.correlationId ?? `execution:${execution.id}`
    const providerId = remoteWorkflowTurnId(remote, correlationId)
    if (!providerId) return conflict()
    const repairAttempt = await readWorkResultRepairAttempt(sql, execution.id)
    if (correlationId !== workResultRepairCorrelation(execution.id, repairAttempt)) return conflict()
    const producer = ArtifactAttemptSchema.parse({ workspaceId: run.workspaceId, workflowId: run.workflowId,
      runId: run.id, nodeId: node.id, executionId: execution.id, attemptId: intent.attemptId, placementHash: intent.bindingHash })
    const rows = (await sql.query<{ record: WorkflowNativeProofRecord; source_digest: string }>(
      `select record,source_digest from workflow_native_proofs where run_id=$1 and execution_id=$2
       and record#>>'{original,type}'='history' and record#>>'{original,history,terminalTurn,result,outcome}'='succeeded'
       order by proof_id for share`, [run.id, execution.id])).rows
    const finalProofs = rows.filter(({ record }) => record.original.type === 'history'
      && record.original.history.correlationId === correlationId
      && record.original.history.terminalTurn?.providerId === providerId)
    if (!finalProofs.length) return pending()
    for (const { record: proof, source_digest } of finalProofs) {
      if (proof.original.type !== 'history' || proof.scope.runId !== run.id || proof.scope.workspaceId !== run.workspaceId
        || proof.scope.workflowId !== run.workflowId || proof.scope.workflowVersionId !== version.id
        || proof.inputDigest !== intent.inputDigest || !same(proof.execution, repeatExecutionIdentity(execution))
        || proof.session.nativeSessionId !== execution.nativeSessionId || !proof.lane || !proof.closureGeneration
        || proof.commandId !== `execution:${execution.id}` || source_digest !== repeatDigest(proof, 4 * 1024 * 1024)
        || !same(proof.original.history.terminalTurn?.result, execution.result)) return conflict()
      assertRepeatExecution(version, proof.scope, proof.ref, execution)
      assertOriginalWorkflowTerminal(execution, proof.session, proof.original.history, correlationId)
      const receipt = { scope: proof.scope, evidence: { sourceKind: 'native_event' as const, sourceId: proof.proofId, sourceRevision: '1' },
        sourceDigest: source_digest, effect: null }
      await assertRepeatCanonicalReceiptLocked(sql, receipt)
      requireRepeatCanonicalReceiptBeforeCommit(sql, receipt)
    }
    let mappings
    try {
      mappings = workflowArtifactResult(execution.result, version, node.id, run.resultProtocol).outputs
    } catch { return conflict() }
    const native = remote.native
    if (!same(remote.intent, intent) || !same(remote.terminal?.result, execution.result)
      || !native?.turnId || native.sessionId !== execution.nativeSessionId) return conflict()
    if (finalProofs.some(({ record }) => record.lane?.providerId !== native.turnId)) return conflict()
    let accepted: Awaited<ReturnType<typeof authority.resolveWorkflowContext>> | undefined
    const digests: { outputKey: string; sha256: string }[] = []
    for (const mapping of mappings) {
      const output = await readNativeArtifactOutput(sql, mainId, producer, mapping.outputKey)
      if (!output) return pending()
      if (output.commandId !== mapping.commandId || output.nativeIdentity.nativeSessionId !== execution.nativeSessionId
        || !output.nativeIdentity.turnId || !remoteWorkflowHasTurn(remote,
          output.nativeIdentity.nativeSessionId, output.nativeIdentity.turnId)) return conflict()
      await assertNativeArtifactOutputLive(sql, mainId, output)
      if (!accepted) {
        const transfer = output.transferReceipt.intent
        accepted = await authority.resolveWorkflowContext(producer, TransferContextSchema.parse({ mainId: transfer.mainId,
          deviceId: transfer.deviceId, workerInstallationId: transfer.workerInstallationId, keyRevision: transfer.keyRevision,
          authorizationRevision: transfer.authorizationRevision, bootId: transfer.bootId, connectionEpoch: transfer.connectionEpoch }), sql)
      }
      const publication = await authority.resolvePublicationContext(accepted, mapping.commandId, sql)
      const caller = await authority.authorizePublication(publication, sql)
      if (caller.principal.id !== output.publication.ownerPrincipalId || caller.binding !== output.publication.binding
        || !same(caller.context, publication.context) || caller.context.turnId !== output.nativeIdentity.turnId) return conflict()
      digests.push({ outputKey: mapping.outputKey, sha256: output.pins.sha256 })
    }
    if (!same(remote.terminal?.artifactDigests, workflowArtifactDigestsByOutputKey(digests))) return conflict()
  }
  return async function assertWorkflowArtifactOutputsLocked(sql: GraphTransactionSql, run: AcceptedWorkflowRunV3,
    version: WorkflowVersionV3, execution: HarnessExecution): Promise<void> {
    assertGraphTransaction(sql)
    try {
      await verify(sql, run, version, execution)
      beforeGraphCommit(sql, async () => {
        try { await verify(sql, run, version, execution) } catch (error) { poisonGraphTransaction(sql); throw error }
      })
    } catch (error) { poisonGraphTransaction(sql); throw error }
  }
}
