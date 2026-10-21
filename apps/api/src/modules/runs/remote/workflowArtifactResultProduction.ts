import { isDeepStrictEqual as same } from 'node:util'
import type { TransferContext } from '@foreman-code/contracts/byte-transfer'
import { RemoteOperationReceiptSchema, remoteWorkflowTurnId } from '@foreman-code/contracts/remote-execution'
import type { AcceptedArtifactPublication } from '../../files/distributed/publication.js'
import { DomainError } from '../../errors.js'
import type { WorkflowNativeCapture, WorkflowNativeVerificationPort } from '../../interactions/workflowNativeCapture.js'
import { readAcceptedPlacement, readDispatchIntent } from '../../placement/persistence.js'
import { assertGraphTransaction, beforeGraphCommit, didGraphTransactionCommit, type GraphTransactionSql } from '../../run-graph/connection.js'
import { assertRepeatCanonicalReceiptLocked, requireRepeatCanonicalReceiptBeforeCommit } from '../../run-graph/repeatReceipts.js'
import { readRepeatExecutionLocked } from '../repeatPostgres.js'
import { readAcceptedRepeatRunLocked } from '../repeatStartRead.js'
import { repeatDigest, repeatExecutionIdentity } from '../repeatResolution.js'
import { readWorkResultRepairAttempt, workResultRepairCorrelation } from '../workResultRepair.js'
import type { RepeatNativeEvidence } from '../repeatNativeRepository.js'
import type { RunOwnership } from '../ownership.js'
import type { WorkflowNativeProofRecord } from '../workflowNativeProof.js'
import type { PostgresArtifactPublicationAuthority } from './nativeArtifactAuthority.js'
import { readReconciledDispatchIntent } from './persistence.js'
import type { WorkflowArtifactResultSourcePort } from './workflowArtifactResultAdoption.js'

export interface WorkflowArtifactTerminalPorts {
  artifactTerminalContext(sql: GraphTransactionSql, owner: RunOwnership, capture: WorkflowNativeCapture,
    proof: WorkflowNativeProofRecord): Promise<TransferContext>
  assertArtifactTerminal(sql: GraphTransactionSql, owner: RunOwnership, capture: WorkflowNativeCapture,
    proof: WorkflowNativeProofRecord): Promise<void>
  assertAdoptedArtifacts(sql: GraphTransactionSql, owner: RunOwnership, capture: WorkflowNativeCapture): Promise<void>
}
interface Retained {
  sql: GraphTransactionSql
  capture: WorkflowNativeCapture
  proof: WorkflowNativeProofRecord
  accepted: AcceptedArtifactPublication
}
const unavailable = (): never => { throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE',
  'The committed original native terminal and its accepted artifact context are unavailable.', 409) }

/** Private Main producer. Only the actual proof writer can retain a capture;
 * caller JSON, an uncommitted row or a latest terminal cannot create authority. */
export function createProductionWorkflowArtifactResultSource(ports: {
  captures: WorkflowNativeVerificationPort
  physical: WorkflowArtifactTerminalPorts
  authority: Pick<PostgresArtifactPublicationAuthority, 'resolveWorkflowContext' | 'resolvePublicationContext' | 'authorize'>
}) {
  const originals = new WeakMap<RepeatNativeEvidence, Retained>()
  const executions = new Map<string, Retained>()
  const verify = async (sql: GraphTransactionSql, entry: Retained) => {
    assertGraphTransaction(sql)
    const { capture, proof, accepted } = entry
    capture.owner.assertOwned()
    const snapshot = await readAcceptedRepeatRunLocked(sql, proof.scope.runId)
    const stored = await readRepeatExecutionLocked(sql, snapshot, proof.execution.executionId)
    if (snapshot.stopRequested || snapshot.cleanupPending || snapshot.version.id !== proof.scope.workflowVersionId
      || !same(stored.ref, proof.ref) || !same(repeatExecutionIdentity(stored.execution), proof.execution)
      || stored.inputDigest !== proof.inputDigest || stored.execution.nativeSessionId !== proof.session.nativeSessionId
      || proof.original.type !== 'history' || !same(stored.execution.result, proof.original.history.terminalTurn?.result)) return unavailable()
    const row = (await sql.query<{ record: WorkflowNativeProofRecord; source_digest: string }>(
      'select record,source_digest from workflow_native_proofs where proof_id=$1 and run_id=$2 and execution_id=$3 for share',
      [proof.proofId, proof.scope.runId, proof.execution.executionId])).rows[0]
    if (!row || !same(row.record, proof) || row.source_digest !== repeatDigest(proof, 4 * 1024 * 1024)) return unavailable()
    const receipt = { scope: proof.scope, evidence: { sourceKind: 'native_event' as const,
      sourceId: proof.proofId, sourceRevision: '1' }, sourceDigest: row.source_digest, effect: null }
    await assertRepeatCanonicalReceiptLocked(sql, receipt)
    requireRepeatCanonicalReceiptBeforeCommit(sql, receipt)
    const caller = await ports.authority.authorize(accepted, sql)
    if (!same(caller.context, accepted.context)) return unavailable()
    // This physical port verifies the retained ORIGINAL terminal and positive
    // closure, rather than demanding a replacement/live process after cleanup.
    await ports.physical.assertArtifactTerminal(sql, capture.owner, capture, proof)
    const remoteRow = (await sql.query<{ receipt: unknown }>(
      'select receipt from remote_execution_receipts where operation_id=$1 for share',
      [(await readDispatchIntent(sql, capture.execution.id))?.operationId])).rows[0]
    if (!remoteRow || proof.original.type !== 'history') return unavailable()
    const remote = RemoteOperationReceiptSchema.parse(remoteRow.receipt)
    const correlationId = proof.original.history.correlationId
    if (!correlationId || remoteWorkflowTurnId(remote, correlationId) !== proof.lane?.providerId) return unavailable()
    const repairAttempt = await readWorkResultRepairAttempt(sql, capture.execution.id)
    if (correlationId !== workResultRepairCorrelation(capture.execution.id, repairAttempt)) return unavailable()
    capture.owner.assertOwned()
    return { version: snapshot.version, resultProtocol: snapshot.run.resultProtocol, execution: stored.execution, proof: structuredClone(proof),
      sourceDigest: row.source_digest, remote }
  }
  const source: WorkflowArtifactResultSourcePort = {
    async readVerified(accepted) {
      const entry = executions.get(accepted.attempt.executionId)
      if (!entry || !didGraphTransactionCommit(entry.sql) || !same(entry.accepted, accepted)) return unavailable()
      const current = () => entry.capture.owner.oneShotConnection().transaction(async sql => {
        if (executions.get(accepted.attempt.executionId) !== entry || !didGraphTransactionCommit(entry.sql)) return unavailable()
        const result = await verify(sql, entry)
        beforeGraphCommit(sql, async () => { await verify(sql, entry) })
        return result
      })
      return { ...await current(), assertCurrent: async () => { await current() },
        publicationContext: commandId => ports.authority.resolvePublicationContext(accepted, commandId) }
    },
  }
  return {
    source,
    async assertLaunchDeclarationLocked(sql: GraphTransactionSql, executionId: string, runId: string): Promise<void> {
      assertGraphTransaction(sql)
      const snapshot = await readAcceptedRepeatRunLocked(sql, runId)
      const stored = await readRepeatExecutionLocked(sql, snapshot, executionId)
      const node = snapshot.version.definition.nodes.find(item => item.id === stored.ref.nodeId)
      if (!node) return unavailable()
      const placement = await readAcceptedPlacement(sql, runId, node.id)
      if (placement && node.kind !== 'job' && node.artifactOutputs
        && (placement.payload.kind !== 'agent' || !same(placement.payload.artifactOutputs, node.artifactOutputs))) {
        return unavailable()
      }
    },
    async retainOriginalLocked(sql: GraphTransactionSql, evidence: RepeatNativeEvidence, raw: WorkflowNativeProofRecord): Promise<void> {
      assertGraphTransaction(sql)
      const proof = structuredClone(raw), capture = ports.captures.read(evidence)
      if (proof.original.type !== 'history' || proof.original.history.terminalTurn?.result.outcome !== 'succeeded') return
      const snapshot = await readAcceptedRepeatRunLocked(sql, proof.scope.runId)
      const stored = await readRepeatExecutionLocked(sql, snapshot, capture.execution.id)
      // A first-terminal normalizer may truthfully fail a successful native
      // envelope. Its retained original is evidence, not accepted artifacts.
      if (stored.execution.state === 'completed' && stored.execution.result?.outcome !== 'succeeded') return
      const node = snapshot.version.definition.nodes.find(item => item.id === proof.ref.nodeId)
      if (!node || node.kind === 'job' || !node.artifactOutputs) return
      if (!same(capture.source, proof.original) || !same(capture.session, proof.session)
        || !same(repeatExecutionIdentity(capture.execution), proof.execution) || capture.owner.runId !== proof.scope.runId) return unavailable()
      const original = await readDispatchIntent(sql, capture.execution.id)
      const intent = original && await readReconciledDispatchIntent(sql, original.operationId, true)
      if (!intent || intent.runId !== proof.scope.runId || intent.nodeId !== proof.ref.nodeId
        || intent.inputDigest !== proof.inputDigest || intent.technicalAttempt !== capture.execution.attempt) return unavailable()
      const terminal = (await sql.query<{ receipt: unknown }>(
        'select receipt from remote_execution_receipts where operation_id=$1 for share', [intent.operationId])).rows[0]
      const remote = terminal ? RemoteOperationReceiptSchema.parse(terminal.receipt) : undefined
      if (!remote?.terminal || remote.terminal.artifactValidationError) return
      const transfer = await ports.physical.artifactTerminalContext(sql, capture.owner, capture, proof)
      const accepted = await ports.authority.resolveWorkflowContext({ workspaceId: proof.scope.workspaceId,
        workflowId: proof.scope.workflowId, runId: proof.scope.runId, nodeId: proof.ref.nodeId,
        executionId: capture.execution.id, attemptId: intent.attemptId, placementHash: intent.bindingHash }, transfer, sql)
      const previous = executions.get(capture.execution.id)
      if (previous && didGraphTransactionCommit(previous.sql) && (!same(previous.proof, proof) || !same(previous.accepted, accepted))) return unavailable()
      const entry = previous && didGraphTransactionCommit(previous.sql) ? previous : { sql, capture, proof, accepted: structuredClone(accepted) }
      originals.set(evidence, entry)
      executions.set(capture.execution.id, entry)
    },
    acceptedAfterCommit(evidence: RepeatNativeEvidence): AcceptedArtifactPublication | undefined {
      const entry = originals.get(evidence)
      if (!entry) return undefined
      if (!didGraphTransactionCommit(entry.sql)) return unavailable()
      return structuredClone(entry.accepted)
    },
    async assertAdoptedAfterCommit(evidence: RepeatNativeEvidence): Promise<void> {
      const entry = originals.get(evidence)
      if (!entry || !didGraphTransactionCommit(entry.sql)) return unavailable()
      await entry.capture.owner.oneShotConnection().transaction(async sql => {
        await verify(sql, entry)
        await ports.physical.assertAdoptedArtifacts(sql, entry.capture.owner, entry.capture)
      })
    },
  }
}
