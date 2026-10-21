import { isDeepStrictEqual } from 'node:util'
import type { HarnessExecution } from '@foreman-code/contracts'
import { ArtifactAttemptSchema } from '@foreman-code/contracts/artifact-edges'
import { TransferContextSchema, VerifiedTransferReceiptSchema } from '@foreman-code/contracts/byte-transfer'
import { parseWorkHandoffArtifactResult } from '@foreman-code/contracts/wave25'
import { parseWorkflowArtifactResult } from '@foreman-code/contracts/workflow-artifact-result'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import { digest } from '../../files/tools/context.js'
import { DomainError } from '../../errors.js'
import { readDispatchIntent } from '../../placement/persistence.js'
import { beforeGraphCommit, type GraphTransactionSql } from '../../run-graph/connection.js'
import { readRepeatExecutionLocked } from '../repeatPostgres.js'
import { readAcceptedRepeatRunLocked } from '../repeatStartRead.js'
import { assertSettlementLocked } from '../repeatSettlementServices.js'
import type { RunOwnership } from '../ownership.js'
import { readWorkflowTerminalReceiptLocked } from '../workflowTerminalReceipt.js'
import type { PostgresArtifactPublicationAuthority } from './nativeArtifactAuthority.js'
import type { NativeArtifactOutputs } from './nativeArtifactOutputs.js'
import { readReconciledDispatchIntent } from './persistence.js'
import { WorkflowArtifactResultAdoption } from './workflowArtifactResultAdoption.js'

const unavailable = () => new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE',
  'The committed original artifact terminal, publication or closure is unavailable.', 409)

/** Recover adoption from immutable original native/publication receipts after
 * positive physical settlement. No manager, source path, credential, native turn
 * or file revision is recreated. Canonical bytes are reread by the same adopter. */
export async function recoverWorkflowArtifactOutputs(input: {
  owner: RunOwnership
  execution: HarnessExecution
  authority: PostgresArtifactPublicationAuthority
  outputs: Pick<NativeArtifactOutputs, 'acceptOutput'>
}): Promise<void> {
  const { owner, execution, authority } = input
  if (execution.state !== 'completed' || execution.result?.outcome !== 'succeeded') return
  owner.assertOwned()
  const read = async (sql: GraphTransactionSql) => {
    const snapshot = await readAcceptedRepeatRunLocked(sql, owner.runId)
    const node = snapshot.version.definition.nodes.find((item) => item.id === execution.workflowNodeId)
    if (!node || node.kind === 'job' || !node.artifactOutputs) return undefined
    if (snapshot.stopRequested || snapshot.cleanupPending || snapshot.run.executionState === 'completed') throw unavailable()
    const stored = await readRepeatExecutionLocked(sql, snapshot, execution.id)
    if (!isDeepStrictEqual(stored.execution, execution)) throw unavailable()
    const original = await readDispatchIntent(sql, execution.id)
    const intent = original && await readReconciledDispatchIntent(sql, original.operationId, true)
    if (!intent || intent.runId !== owner.runId || intent.nodeId !== node.id
      || intent.technicalAttempt !== execution.attempt || intent.inputDigest !== stored.inputDigest) throw unavailable()
    const receipt = (await sql.query<{ receipt: unknown }>(
      'select receipt from remote_execution_receipts where operation_id=$1 for share', [intent.operationId])).rows[0]
    if (!receipt) throw unavailable()
    const remote = RemoteOperationReceiptSchema.parse(receipt.receipt)
    if (remote.terminal?.artifactValidationError) {
      throw new DomainError('WORKFLOW_ARTIFACT_OUTPUTS_CONFLICT',
        'The original native result failed artifact validation after physical closure.', 409)
    }
    const source = await readWorkflowTerminalReceiptLocked(sql, snapshot, stored)
    await assertSettlementLocked(sql, snapshot.run, [execution.id], owner)
    let mappings
    if (snapshot.version.definition.handoffs) {
      mappings = parseWorkHandoffArtifactResult(execution.result, node.artifactOutputs).artifactOutputs
    } else if (node.choice) {
      mappings = parseWorkflowArtifactResult(execution.result, node.artifactOutputs, node.choice).artifactOutputs
    } else {
      mappings = parseWorkflowArtifactResult(execution.result, node.artifactOutputs).artifactOutputs
    }
    const publication = (await sql.query<{ transfer_receipt: unknown }>(
      `select record->'transferReceipt' as transfer_receipt from file_tool_publications
        where owner_principal_id=$1 and request_id=$2 for share`,
      [snapshot.run.authorizationPrincipalId, `fil05:remote:${digest(mappings.outputs[0]!.commandId)}`])).rows[0]
    if (!publication) throw unavailable()
    const transfer = VerifiedTransferReceiptSchema.parse(publication.transfer_receipt).intent
    const accepted = await authority.resolveWorkflowContext(ArtifactAttemptSchema.parse({
      workspaceId: snapshot.run.workspaceId, workflowId: snapshot.run.workflowId, runId: owner.runId,
      nodeId: node.id, executionId: execution.id, attemptId: intent.attemptId, placementHash: intent.bindingHash,
    }), TransferContextSchema.parse({ mainId: transfer.mainId, deviceId: transfer.deviceId,
      workerInstallationId: transfer.workerInstallationId, keyRevision: transfer.keyRevision,
      authorizationRevision: transfer.authorizationRevision, bootId: transfer.bootId,
      connectionEpoch: transfer.connectionEpoch }), sql)
    await authority.authorize(accepted, sql)
    return { accepted, version: snapshot.version, execution: stored.execution, remote, ...source }
  }
  const current = () => owner.oneShotConnection().transaction(async (sql) => {
    const result = await read(sql)
    if (result) beforeGraphCommit(sql, async () => {
      if (!isDeepStrictEqual(await read(sql), result)) throw unavailable()
    })
    return result
  })
  const original = await current()
  if (!original) return
  await new WorkflowArtifactResultAdoption({ readVerified: async (accepted) => {
    const verify = async () => {
      const latest = await current()
      if (!latest || !isDeepStrictEqual(latest.accepted, accepted)) throw unavailable()
      return latest
    }
    const latest = await verify()
    return { version: latest.version, execution: latest.execution, proof: latest.proof,
      sourceDigest: latest.sourceDigest, remote: latest.remote, assertCurrent: async () => { await verify() },
      publicationContext: commandId => authority.resolvePublicationContext(accepted, commandId) }
  } }, input.outputs).adoptOriginalOutputs(original.accepted)
}
