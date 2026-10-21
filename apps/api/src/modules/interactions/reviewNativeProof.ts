import { HarnessExecutionSchema, NativeSessionReferenceSchema, ReviewJobSchema, type NativeHarnessEvent, type ReviewJob } from '@foreman-code/contracts'
import { canonicalGraphJson, type NativeGraphObservation } from '@foreman-code/contracts/wave25'
import { REMOTE_NATIVE_SOURCE_LIMIT } from '@foreman-code/contracts/remote-workflow-physical'
import { DomainError } from '../errors.js'
import { beforeGraphCommit, type GraphTransactionSql } from '../run-graph/connection.js'
import { currentRunGraphPublication, hasRunGraphPublication, graphSourceDigest, type RunGraphPublication } from '../run-graph/publication.js'
import { requireRepeatCanonicalReceiptBeforeCommit } from '../run-graph/repeatReceipts.js'
import { normalizeNativeProducerEvent } from '../run-graph/nativeProducerNormalization.js'
import { nativeGraphSource } from '../run-graph/nativeIngestion.js'
import { readRepeatExecutionLocked } from '../runs/repeatExecutionRead.js'
import { readAcceptedRepeatRunLocked } from '../runs/repeatStartRead.js'
import { repeatDigest, repeatExecutionIdentity, sameRepeatValue, type RepeatNodeRef, type RepeatScope } from '../runs/repeatResolution.js'
import type { CapturedReviewNativeSource, ReviewNativeCapture, ReviewNativeVerificationPort } from './reviewNativeCapture.js'
import { readExecutionPlacement } from '../placement/persistence.js'
import { ReviewEvidenceTracker } from './reviewerEvidence.js'
import { requireLeaseAtCommit } from './wave25/context.js'
import { readWorkflowClosure } from './workflowClosure.js'

function fail(code = 'REVIEW_ORIGINAL_SOURCE_CONFLICT'): never {
  throw new DomainError(code, 'The reviewer source, saved pins, native generation, lease or canonical receipt does not match.', 409)
}
function jobIdentity(job: ReviewJob) {
  return { id: job.id, interactionId: job.interactionId, reviewerAgentId: job.reviewerAgentId,
    provider: job.provider, nativeSessionId: job.nativeSessionId, correlationId: job.correlationId }
}
export interface ReviewNativeProofRecord {
  proofId: string
  scope: RepeatScope
  ref: RepeatNodeRef
  execution: ReturnType<typeof repeatExecutionIdentity>
  inputDigest: string
  job: ReturnType<typeof jobIdentity>
  session: CapturedReviewNativeSource['session']
  original: CapturedReviewNativeSource['source']
  observedAt: string
  lifetimeGeneration: number
  closureGeneration: string
  lane: CapturedReviewNativeSource['lane']
  jobLease: { token: string; fence: string }
}
function proofEvidence(proofId: string) { return { sourceKind: 'native_event' as const, sourceId: proofId, sourceRevision: '1' } }
function sourceIdentity(record: ReviewNativeProofRecord) {
  return { scope: record.scope, ref: record.ref, execution: record.execution, inputDigest: record.inputDigest,
    job: record.job, session: record.session, original: record.original }
}
export function reviewSourceEvents(record: Pick<ReviewNativeProofRecord, 'original' | 'execution'>): NativeHarnessEvent[] {
  const events = record.original.type === 'event' ? [record.original.event]
    : record.original.type === 'history' ? record.original.history.events : []
  return events.map((event) => normalizeNativeProducerEvent({ ...event, executionId: record.execution.executionId }).event)
}
/** Readiness requires the original provider events rather than convenience terminal fields. */
export function reviewSourceReadiness(record: Pick<ReviewNativeProofRecord, 'original' | 'session' | 'job'>,
  providerId?: string): { live: boolean; terminalReady: boolean } {
  const tracker = new ReviewEvidenceTracker(record.session, record.job.correlationId, providerId)
  if (record.original.type === 'entry') return { live: false, terminalReady: false }
  if (record.original.type === 'event') {
    tracker.observeEvent(record.original.event)
    return { live: true, terminalReady: tracker.snapshot().terminal && !record.original.pending }
  }
  const history = { ...record.original.history }
  delete history.terminalTurn; delete history.terminalResult
  tracker.observeHistory(history)
  return { live: false, terminalReady: tracker.snapshot().terminal
    && !history.pendingInteraction && history.pendingInteractions.length === 0 }
}

/** Paired with the real coordinator channel during production construction. */
export class ReviewNativeProofServices {
  constructor(private readonly captures: ReviewNativeVerificationPort,
    private readonly verifyRemote?: (sql: GraphTransactionSql, capture: CapturedReviewNativeSource) => Promise<void>) {}

  private async verifyLocked(publication: RunGraphPublication, job: ReviewJob, capture: CapturedReviewNativeSource) {
    const sql = publication.sql
    const placement = await readExecutionPlacement(sql, capture.execution.id)
    if (placement?.hostRef.kind === 'device') {
      if (!this.verifyRemote) return fail('REMOTE_REVIEW_PHYSICAL_COMPOSITION_REQUIRED')
      await this.verifyRemote(sql, capture)
    }
    capture.assertCurrent()
    const snapshot = await readAcceptedRepeatRunLocked(sql, publication.scope.runId)
    const stored = await readRepeatExecutionLocked(sql, snapshot, capture.execution.id)
    if (!sameRepeatValue(repeatExecutionIdentity(stored.execution), repeatExecutionIdentity(capture.execution))
      || !sameRepeatValue(jobIdentity(job), jobIdentity(capture.job)) || job.leaseToken !== capture.job.leaseToken) return fail()
    const row = (await sql.query<{ record: unknown; execution_id: string; lease_fence: string; lease_expires_at: Date; live: boolean }>(
      `select record,execution_id,lease_fence::text,lease_expires_at,coalesce(lease_expires_at>clock_timestamp(),false) as live
       from review_jobs where id=$1 for update`, [job.id])).rows[0]
    const current = ReviewJobSchema.parse(row?.record)
    if (!row?.live || !row.lease_expires_at || row.execution_id !== stored.execution.id || current.leaseToken !== job.leaseToken
      || !sameRepeatValue(jobIdentity(current), jobIdentity(job))) return fail('REVIEW_JOB_LEASE_LOST')
    requireLeaseAtCommit(sql, row.lease_expires_at, 'REVIEW_JOB_LEASE_LOST')
    const native = (await sql.query<{ reference: unknown }>(
      'select reference from execution_native_sessions where execution_id=$1 for share', [stored.execution.id])).rows[0]
    if (!native || !sameRepeatValue(NativeSessionReferenceSchema.parse(native.reference), capture.session)) return fail()
    const lifetime = (await sql.query<{ generation: string; open: boolean }>(`select generation::text,
      closed_at is null and detached_at is null as open from execution_native_closures
      where execution_id=$1 order by generation desc limit 1 for update`, [stored.execution.id])).rows[0]
    if (!lifetime?.open || lifetime.generation !== capture.closureGeneration) return fail('NATIVE_LIFETIME_CHANGED')
    const lane = (await sql.query<{ owner_agent_id: string; harness: string; native_session_id: string;
      generation: string; token: string; correlation: string; provider_id: string | null; expires: Date; live: boolean }>(
      `select owner_agent_id,harness,native_session_id,record->>'connectionGeneration' as generation,
        record->>'leaseToken' as token,record->>'correlationId' as correlation,record->>'currentTurnOrMessageId' as provider_id,
        (record->>'leaseExpiresAt')::timestamptz as expires,
        coalesce((record->>'leaseExpiresAt')::timestamptz>clock_timestamp(),false) as live
       from native_session_lanes where id=$1 for update`, [capture.lane.id])).rows[0]
    if (!lane?.live || lane.owner_agent_id !== current.reviewerAgentId || lane.harness !== capture.session.harness
      || lane.native_session_id !== capture.session.nativeSessionId || lane.token !== capture.lane.token
      || lane.generation !== String(capture.lane.connectionGeneration) || lane.correlation !== job.correlationId
      || lane.provider_id !== null && capture.lane.providerId !== null && lane.provider_id !== capture.lane.providerId) return fail('SESSION_LANE_LEASE_LOST')
    requireLeaseAtCommit(sql, lane.expires, 'SESSION_LANE_LEASE_LOST')
    capture.assertCurrent()
    return { stored, fence: row.lease_fence }
  }

  async persistLocked(publication: RunGraphPublication, job: ReviewJob, value: ReviewNativeCapture): Promise<ReviewNativeProofRecord> {
    const capture = this.captures.read(value), { stored, fence } = await this.verifyLocked(publication, job, capture)
    const originalKey = capture.source.type === 'event'
      ? ['event', capture.source.event.connectionId ?? null, capture.source.event.sequence, repeatDigest(capture.source.pending)]
      : capture.source.type === 'history' ? ['history', repeatDigest(capture.source.history, REMOTE_NATIVE_SOURCE_LIMIT)] : ['entry']
    const proofId = `review-original:${repeatDigest([publication.scope, jobIdentity(job), repeatExecutionIdentity(stored.execution), originalKey]).slice(7)}`
    let record: ReviewNativeProofRecord = { proofId, scope: publication.scope as RepeatScope, ref: stored.ref,
      execution: repeatExecutionIdentity(stored.execution), inputDigest: stored.inputDigest, job: jobIdentity(job), session: capture.session,
      original: capture.source, observedAt: capture.observedAt, lifetimeGeneration: capture.lifetimeGeneration,
      closureGeneration: capture.closureGeneration, lane: capture.lane, jobLease: { token: job.leaseToken!, fence } }
    const sql = publication.sql
    const previous = (await sql.query<{ record: ReviewNativeProofRecord; source_digest: string }>(
      'select record,source_digest from review_native_proofs where proof_id=$1 for share', [proofId])).rows[0]
    if (previous) {
      if (repeatDigest(previous.record, REMOTE_NATIVE_SOURCE_LIMIT) !== previous.source_digest
        || canonicalGraphJson(sourceIdentity(previous.record), REMOTE_NATIVE_SOURCE_LIMIT)
          !== canonicalGraphJson(sourceIdentity(record), REMOTE_NATIVE_SOURCE_LIMIT)) return fail()
      record = previous.record // retain first original generation/time/lease, never relabel it
    } else {
      const recordJson = canonicalGraphJson(record, REMOTE_NATIVE_SOURCE_LIMIT)
      if ((await sql.query(`insert into review_native_proofs(proof_id,run_id,execution_id,job_id,record,source_digest,record_json)
        values($1,$2,$3,$4,$5::jsonb,$6,$7::text)`, [proofId, publication.scope.runId, stored.execution.id, job.id,
        recordJson, repeatDigest(record, REMOTE_NATIVE_SOURCE_LIMIT), recordJson])).rowCount !== 1) return fail()
    }
    const receipt = await publication.retainReviewSource(job.id, job.leaseToken!, proofId)
    requireRepeatCanonicalReceiptBeforeCommit(sql, { scope: record.scope, ...receipt, effect: null })
    beforeGraphCommit(sql, async () => { await this.verifyLocked(publication, job, capture) })
    return record
  }
}

export async function assertReviewOriginalProofLocked(sql: GraphTransactionSql, job: ReviewJob,
  observation: NativeGraphObservation, proofId: string): Promise<ReviewNativeProofRecord> {
  // Graph reads verify this inside a read-only repeatable-read cut, where a
  // row lock is both unavailable and unnecessary; writers still lock it.
  const lock = hasRunGraphPublication(sql, observation.scope) ? ' for share' : ''
  const row = (await sql.query<{ record: ReviewNativeProofRecord; source_digest: string }>(
    `select record,source_digest from review_native_proofs where proof_id=$1 and job_id=$2${lock}`, [proofId, job.id])).rows[0]
  if (!row || repeatDigest(row.record, REMOTE_NATIVE_SOURCE_LIMIT) !== row.source_digest || row.record.proofId !== proofId
    || !sameRepeatValue(row.record.job, jobIdentity(job)) || !sameRepeatValue(row.record.scope, observation.scope)
    || !sameRepeatValue(row.record.execution, observation.work.execution)
    || observation.work.workKind !== 'review' || observation.work.workId !== job.id
    || !reviewSourceEvents(row.record).some((event) => sameRepeatValue(nativeGraphSource({ ...event,
      executionId: row.record.execution.executionId }), observation.source))) return fail()
  const evidence = proofEvidence(proofId), semanticDigest = graphSourceDigest({ evidence, facts: [], effect: null })
  // Opening a publication re-reads the committed projection, which includes this
  // proof; enlistment is only checkable once the publication exists.
  if (!hasRunGraphPublication(sql, row.record.scope)) return row.record
  await currentRunGraphPublication(sql, row.record.scope).assertSourceEnlisted(evidence, row.source_digest, semanticDigest)
  requireRepeatCanonicalReceiptBeforeCommit(sql, { scope: row.record.scope, evidence,
    sourceDigest: row.source_digest, semanticDigest, effect: null })
  return row.record
}

/** A job JSON cleanup enum is never physical proof. No-submission is a positive
 * sealed reservation; closed is the original manager's latest durable receipt. */
export async function assertReviewCleanupProofLocked(sql: GraphTransactionSql, job: ReviewJob,
  executionId: string): Promise<void> {
  const cleanup = job.cleanup
  if (!cleanup || cleanup.nativeState === 'pending') return fail('REVIEW_NATIVE_SETTLEMENT_PENDING')
  const entry = (await sql.query<{ phase: string; record: { job: ReturnType<typeof jobIdentity> }; source_id: string | null; source_revision: string | null; source_digest: string | null }>(
    'select phase,record,source_id,source_revision::text,source_digest from review_native_entries where job_id=$1 and execution_id=$2 for update', [job.id, executionId])).rows[0]
  if (!entry || !sameRepeatValue(entry.record.job, jobIdentity(job))) return fail()
  if (cleanup.nativeState === 'not_started') {
    if (entry.phase !== 'not_submitted' || !entry.source_id || !entry.source_digest) return fail('REVIEW_SUBMISSION_UNCERTAIN')
    const snapshot = await readAcceptedRepeatRunLocked(sql, (await sql.query<{ run_id: string }>(
      'select run_id from harness_executions where id=$1', [executionId])).rows[0]!.run_id)
    requireRepeatCanonicalReceiptBeforeCommit(sql, { scope: { workspaceId: snapshot.run.workspaceId,
      workflowId: snapshot.run.workflowId, workflowVersionId: snapshot.run.workflowVersionId, runId: snapshot.run.id, executionSemanticsVersion: 3 },
    evidence: { sourceKind: 'cleanup', sourceId: entry.source_id, sourceRevision: entry.source_revision! }, sourceDigest: entry.source_digest, effect: null })
    return
  }
  if (entry.phase !== 'entered') return fail('REVIEW_SUBMISSION_UNCERTAIN')
  if (cleanup.nativeState === 'closed') {
    const execution = HarnessExecutionSchema.parse((await sql.query<{ record: unknown }>(
      'select record from harness_executions where id=$1 for update', [executionId])).rows[0]?.record)
    const closed = await readWorkflowClosure(sql, execution)
    if (!closed || closed.session.nativeSessionId !== job.nativeSessionId || closed.session.harness !== job.provider) return fail('REVIEW_NATIVE_SETTLEMENT_PENDING')
    return
  }
  const native = (await sql.query<{ approval_native_evidence: NativeGraphObservation; approval_original_proof_id: string | null }>(
    'select approval_native_evidence,approval_original_proof_id from review_jobs where id=$1', [job.id])).rows[0]
  if (!native?.approval_original_proof_id || native.approval_native_evidence?.kind !== 'terminal'
    || !native.approval_native_evidence.terminal.nativeSettled) return fail('REVIEW_NATIVE_SETTLEMENT_PENDING')
  await assertReviewOriginalProofLocked(sql, job, native.approval_native_evidence, native.approval_original_proof_id)
}

export { jobIdentity as reviewJobIdentity }

/** Checks durable original evidence before the coordinator closes a reviewer and
 * again at Run settlement. A caller-supplied terminal job is not authority. */
export async function assertReviewJobTerminalProofLocked(sql: GraphTransactionSql,
  job: ReviewJob, executionId: string): Promise<void> {
  const row = (await sql.query<{ record: unknown; execution_id: string; approval_native_evidence: NativeGraphObservation | null;
    approval_original_proof_id: string | null }>(`select record,execution_id,approval_native_evidence,approval_original_proof_id
    from review_jobs where id=$1 for update`, [job.id])).rows[0]
  const current = ReviewJobSchema.parse(row?.record)
  if (!row || row.execution_id !== executionId || !sameRepeatValue(current, job)) return fail()
  if (current.state === 'completed') {
    const observation = row.approval_native_evidence
    if (!row.approval_original_proof_id || !observation || observation.kind !== 'terminal'
      || !observation.terminal.nativeSettled || observation.terminal.outcome !== 'succeeded'
      || observation.submissionId !== current.providerTurnOrMessageId) return fail('REVIEW_NATIVE_SETTLEMENT_PENDING')
    await assertReviewOriginalProofLocked(sql, current, observation, row.approval_original_proof_id)
    return
  }
  if (current.state !== 'failed' || !current.cleanup?.completedAt
    || current.cleanup.credentialState === 'pending') return fail('REVIEW_NATIVE_SETTLEMENT_PENDING')
  await assertReviewCleanupProofLocked(sql, current, executionId)
  const credentials = (await sql.query<{ outstanding: boolean }>(`select exists(
    select 1 from worker_credential_bindings b left join management_principals p on p.id=b.principal_id
    where b.execution_id=$1 and (b.revoked_at is null or p.id is null or p.revoked_at is null)
  ) as outstanding`, [executionId])).rows[0]
  if (credentials?.outstanding !== false) return fail('REVIEW_CREDENTIAL_CLEANUP_PENDING')
}
