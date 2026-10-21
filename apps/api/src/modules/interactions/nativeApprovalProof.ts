import { DurableInteractionSchema, isSessionNativeInteraction, type DurableInteraction } from '@foreman-code/contracts'
import { canonicalGraphJson, GraphEvidenceSchema, GraphExecutionIdentitySchema, GraphIdSchema,
  GraphDigestSchema, RepeatOccurrenceIdentityV1Schema, RunGraphScopeSchema, type GraphEvidence,
  type GraphExecutionIdentity } from '@foreman-code/contracts/wave25'
import { z } from 'zod'
import { beforeGraphCommit, poisonGraphTransaction, type GraphTransactionSql } from '../run-graph/connection.js'
import { currentRunGraphPublication, graphSourceDigest } from '../run-graph/publication.js'
import { requireRepeatCanonicalReceiptBeforeCommit } from '../run-graph/repeatReceipts.js'
import type { WorkflowNativeProofRecord } from '../runs/workflowNativeProof.js'
import { readRepeatExecutionLocked } from '../runs/repeatExecutionRead.js'
import { readAcceptedRepeatRunLocked } from '../runs/repeatStartRead.js'
import { repeatExecutionIdentity, sameRepeatValue } from '../runs/repeatResolution.js'
import { matchingDeliveryEvidence } from './delivery.js'
import { nativeApprovalContext } from './nativeApprovalContext.js'
import { decisionDigest } from './wave25/publication.js'
import { DomainError } from '../errors.js'
import { APPROVAL_SETTLEMENT_PENDING_MESSAGE } from './repeatNativeEvidence.js'
import { assertWorkflowCorrelation } from '../runs/workResultRepair.js'

const AckSchema = z.object({
  scope: RunGraphScopeSchema, interaction: DurableInteractionSchema,
  requester: GraphExecutionIdentitySchema, occurrence: RepeatOccurrenceIdentityV1Schema.nullable(), inputDigest: GraphDigestSchema,
  acknowledgementId: GraphIdSchema, originalProofId: GraphIdSchema, originalProofDigest: GraphDigestSchema,
  nativeSource: GraphEvidenceSchema, nativeSourceDigest: GraphDigestSchema,
  publication: z.object({ evidence: GraphEvidenceSchema, sourceDigest: GraphDigestSchema, semanticDigest: GraphDigestSchema }).strict(),
}).strict()
export type WorkflowApprovalAck = z.infer<typeof AckSchema>
function pending(): never { throw new DomainError('APPROVAL_SETTLEMENT_PENDING', APPROVAL_SETTLEMENT_PENDING_MESSAGE, 409) }

/** The pending request is anchored in a coordinator-minted ORIGINAL history,
 * not in a body supplied to an interaction endpoint. Caller identity fields,
 * request/options/context and the pinned handler must all match that source. */
export async function assertPendingApprovalOriginalLocked(sql: GraphTransactionSql, i: DurableInteraction,
  proofId: string): Promise<WorkflowNativeProofRecord> {
  GraphIdSchema.parse(proofId)
  const row = (await sql.query<{ record: WorkflowNativeProofRecord; source_digest: string }>(
    'select record,source_digest from workflow_native_proofs where proof_id=$1 and run_id=$2 and execution_id=$3 for share',
    [proofId, i.runId, i.executionId])).rows[0]
  if (!row || graphSourceDigest(row.record) !== row.source_digest) return pending()
  const proof = row.record, scope = RunGraphScopeSchema.parse(proof.scope)
  const snapshot = await readAcceptedRepeatRunLocked(sql, i.runId)
  const stored = await readRepeatExecutionLocked(sql, snapshot, i.executionId)
  if (proof.proofId !== proofId || scope.runId !== i.runId || scope.workspaceId !== i.workspaceId
    || scope.workflowId !== i.workflowId || scope.workflowVersionId !== snapshot.version.id
    || i.graphThreadId !== i.runId || i.requestingAgentId !== stored.execution.agentId
    || !sameRepeatValue(proof.ref, stored.ref) || !sameRepeatValue(proof.execution, repeatExecutionIdentity(stored.execution))
    || proof.inputDigest !== stored.inputDigest || !sameRepeatValue(i.approval, snapshot.run.approval)
    || i.harness !== proof.session.harness || i.providerVersion !== proof.session.providerVersion
    || i.nativeSessionId !== proof.session.nativeSessionId || proof.original.type !== 'history'
    || !proof.lane || proof.commandId !== `execution:${i.executionId}`) return pending()
  const history = proof.original.history
  const requests = history.pendingInteractions.filter((request) => request.turn.nativeRequestId === i.nativeRequestId)
  if (requests.length !== 1) return pending()
  const request = requests[0]!
  if (!sameRepeatValue(request.session, proof.session)
    || !isSessionNativeInteraction(request) && request.turn.nativeTurnId !== proof.lane.providerId
    || request.nativeRequestType !== i.nativeRequestType || !sameRepeatValue(request.request, i.request)
    || !sameRepeatValue(request.responseOptions, i.responseOptions)
    || !sameRepeatValue(nativeApprovalContext(request, history.events), i.reviewContext)) return pending()
  const evidence: GraphEvidence = { sourceKind: 'native_event', sourceId: proofId, sourceRevision: '1' }
  await currentRunGraphPublication(sql, scope).assertSourceEnlisted(evidence, row.source_digest,
    graphSourceDigest({ evidence, facts: [], effect: null }))
  return proof
}

/** Once an interaction is saved, its first ORIGINAL pending source cannot be
 * replaced by another turn, repetition, native request or recovery generation. */
export async function assertSavedPendingApprovalOriginalLocked(sql: GraphTransactionSql,
  i: DurableInteraction): Promise<WorkflowNativeProofRecord> {
  const row = (await sql.query<{ approval_native_request_proof_id: string | null }>(
    'select approval_native_request_proof_id from durable_interactions where id=$1 and execution_id=$2 for share',
    [i.id, i.executionId])).rows[0]
  if (!row?.approval_native_request_proof_id) return pending()
  return assertPendingApprovalOriginalLocked(sql, i, row.approval_native_request_proof_id)
}

/** Private original-source verification. The proof row was minted solely by the
 * paired coordinator capture channel, with owner/session/lease/input checks.
 * Neither a delivered status nor the native acknowledgement ID is the proof. */
export async function readApprovalOriginalLocked(sql: GraphTransactionSql, i: DurableInteraction, proofId: string,
  source: GraphEvidence, requester: GraphExecutionIdentity) {
  GraphIdSchema.parse(proofId)
  const row = (await sql.query<{ record: WorkflowNativeProofRecord; source_digest: string }>(
    'select record,source_digest from workflow_native_proofs where proof_id=$1 and run_id=$2 and execution_id=$3 for share',
    [proofId, i.runId, i.executionId])).rows[0]
  if (!row || graphSourceDigest(row.record) !== row.source_digest) return pending()
  const proof = row.record, scope = RunGraphScopeSchema.parse(proof.scope)
  const snapshot = await readAcceptedRepeatRunLocked(sql, i.runId)
  const stored = await readRepeatExecutionLocked(sql, snapshot, i.executionId)
  if (proof.proofId !== proofId || scope.runId !== i.runId || scope.workspaceId !== i.workspaceId
    || scope.workflowId !== i.workflowId || scope.workflowVersionId !== snapshot.version.id
    || !sameRepeatValue(proof.ref, stored.ref) || !sameRepeatValue(proof.execution, requester)
    || !sameRepeatValue(requester, repeatExecutionIdentity(stored.execution)) || proof.inputDigest !== stored.inputDigest
    || proof.session.harness !== i.harness || proof.session.providerVersion !== i.providerVersion
    || proof.session.nativeSessionId !== i.nativeSessionId || proof.original.type !== 'history') return pending()
  const pendingSource = await assertSavedPendingApprovalOriginalLocked(sql, i)
  const history = proof.original.history, terminal = history.terminalTurn
  if (!terminal || !history.correlationId || history.correlationId !== terminal.correlationId
    || terminal.providerId !== history.nativeTurnId || !terminal.providerId || history.pendingInteraction
    || history.pendingInteractions.length || !proof.lane || proof.lane.providerId !== terminal.providerId
    || pendingSource.lane?.providerId !== terminal.providerId
    || !matchingDeliveryEvidence(i, proof.session, history)) return pending()
  await assertWorkflowCorrelation(sql, i.executionId, history.correlationId)
  // The source is the complete captured history receipt, not a rewritten wire
  // event. Cold recovery may read old connection events; their IDs remain old.
  // Authority is the exact rooted history + delivery proof under the CURRENT
  // captured lease, never the history's terminal enum or an empty pending list.
  if (!sameRepeatValue(source, { sourceKind: 'native_event', sourceId: proofId, sourceRevision: '1' })) return pending()

  const publication = currentRunGraphPublication(sql, scope)
  const evidence: GraphEvidence = { sourceKind: 'native_event', sourceId: proofId, sourceRevision: '1' }
  const semanticDigest = graphSourceDigest({ evidence, facts: [], effect: null })
  await publication.assertSourceEnlisted(evidence, row.source_digest, semanticDigest)
  return { proof, scope, originalDigest: row.source_digest, nativeSourceDigest: row.source_digest }
}

/** Compose the immutable ACK descriptor with the existing Worker-resumption
 * source. Its private provenance never enters public graph facts. */
export async function approvalAckRecord(sql: GraphTransactionSql, i: DurableInteraction, input: {
  proofId: string; source: GraphEvidence; requester: GraphExecutionIdentity; acknowledgementId: string;
  publication: WorkflowApprovalAck['publication'];
}): Promise<WorkflowApprovalAck> {
  const original = await readApprovalOriginalLocked(sql, i, input.proofId, input.source, input.requester)
  return AckSchema.parse({ scope: original.scope, interaction: i, requester: input.requester,
    occurrence: original.proof.ref.occurrence, inputDigest: original.proof.inputDigest,
    acknowledgementId: input.acknowledgementId, originalProofId: input.proofId,
    originalProofDigest: original.originalDigest, nativeSource: input.source,
    nativeSourceDigest: original.nativeSourceDigest, publication: input.publication })
}

export async function assertWorkflowApprovalAckLocked(sql: GraphTransactionSql, supplied: DurableInteraction,
  retain = true): Promise<WorkflowApprovalAck> {
  try {
    const current = DurableInteractionSchema.parse(supplied)
    const row = (await sql.query<{ state: string; approval_native_ack_id: string | null;
      approval_native_ack_record: unknown; approval_native_ack_source: unknown }>(
      `select state,approval_native_ack_id,approval_native_ack_record,approval_native_ack_source
       from interaction_graph_resumes where interaction_id=$1 for update`, [current.id])).rows[0]
    if (!row || row.state !== 'resumed' || !row.approval_native_ack_id || !current.graphInterruptId
      || current.status !== 'delivered' || current.deliveryState !== 'delivered') return pending()
    const ack = AckSchema.parse(row.approval_native_ack_record), i = ack.interaction
    if (ack.acknowledgementId !== row.approval_native_ack_id || !sameRepeatValue(ack.nativeSource, row.approval_native_ack_source)
      || i.id !== current.id || i.runId !== current.runId || i.executionId !== current.executionId
      || i.graphThreadId !== current.graphThreadId || i.graphInterruptId !== current.graphInterruptId
      || i.nativeSessionId !== current.nativeSessionId || i.nativeRequestId !== current.nativeRequestId
      || i.providerVersion !== current.providerVersion || i.harness !== current.harness
      || decisionDigest(i) !== decisionDigest(current)) return pending()
    const original = await readApprovalOriginalLocked(sql, i, ack.originalProofId, ack.nativeSource, ack.requester)
    if (original.originalDigest !== ack.originalProofDigest || original.nativeSourceDigest !== ack.nativeSourceDigest
      || !sameRepeatValue(original.scope, ack.scope) || !sameRepeatValue(original.proof.ref.occurrence, ack.occurrence)
      || original.proof.inputDigest !== ack.inputDigest) return pending()
    const fact = { type: 'worker.resumed', interactionId: i.id, requester: ack.requester, acknowledgementId: ack.acknowledgementId }
    if (ack.publication.sourceDigest !== graphSourceDigest({ next: i, source: ack.nativeSource, fact })
      || !sameRepeatValue(ack.publication.evidence, { sourceKind: 'native_event', sourceId: i.id, sourceRevision: String(i.revision) })) return pending()
    const publication = currentRunGraphPublication(sql, ack.scope)
    await publication.assertSourceEnlisted(ack.publication.evidence, ack.publication.sourceDigest, ack.publication.semanticDigest)
    const resume = (await sql.query<{ effect_digest: string }>(`select effect_digest from run_graph_effects
      where run_id=$1 and effect_kind='graph.resume' and entity_id=$2`, [i.runId, i.id])).rows[0]
    const digest = graphSourceDigest({ interactionId: i.id, runId: i.runId, executionId: i.executionId,
      graphThreadId: i.graphThreadId, graphInterruptId: i.graphInterruptId, decision: decisionDigest(i) })
    if (resume?.effect_digest !== digest) return pending()
    if (retain) {
      requireRepeatCanonicalReceiptBeforeCommit(sql, { scope: ack.scope, ...ack.publication, effect: null })
      const retained = canonicalGraphJson(ack)
      beforeGraphCommit(sql, async () => {
        if (canonicalGraphJson(await assertWorkflowApprovalAckLocked(sql, current, false)) !== retained) return pending()
      })
    }
    return ack
  } catch (error) { poisonGraphTransaction(sql); throw error }
}
