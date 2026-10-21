import { canonicalGraphJson, type GraphEvidence } from '@foreman-code/contracts/wave25'
import type { ReviewJob } from '@foreman-code/contracts'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { RunGraphPublication } from '../run-graph/publication.js'
import { readRepeatExecutionLocked } from '../runs/repeatPostgres.js'
import { readAcceptedRepeatRunLocked } from '../runs/repeatStartRead.js'
import { repeatExecutionIdentity, sameRepeatValue } from '../runs/repeatResolution.js'
import { DomainError } from '../errors.js'
import { reviewJobIdentity, type ReviewNativeProofRecord } from './reviewNativeProof.js'

function conflict(): never {
  throw new DomainError('REVIEW_SUBMISSION_UNCERTAIN', 'The exact review entry is not a new reserved command. Do not replay a provider prompt.', 409)
}
export async function reserveReviewNativeEntryLocked(publication: RunGraphPublication, job: ReviewJob, executionId: string): Promise<void> {
  const snapshot = await readAcceptedRepeatRunLocked(publication.sql, publication.scope.runId)
  const stored = await readRepeatExecutionLocked(publication.sql, snapshot, executionId)
  const record = { scope: publication.scope, job: reviewJobIdentity(job), ref: stored.ref,
    execution: repeatExecutionIdentity(stored.execution), inputDigest: stored.inputDigest }
  const recordJson = canonicalGraphJson(record)
  if ((await publication.sql.query(`insert into review_native_entries(job_id,run_id,execution_id,phase,record,record_json)
    values($1,$2,$3,'reserved',$4::jsonb,$5::text)`, [job.id, publication.scope.runId, executionId, recordJson, recordJson])).rowCount !== 1) return conflict()
}
export async function reviewEntryPhaseLocked(sql: GraphTransactionSql, job: ReviewJob, executionId: string): Promise<string> {
  const row = (await sql.query<{ phase: string; record: { job: ReturnType<typeof reviewJobIdentity> } }>(
    'select phase,record from review_native_entries where job_id=$1 and execution_id=$2 for update', [job.id, executionId])).rows[0]
  if (!row || !sameRepeatValue(row.record.job, reviewJobIdentity(job))) return conflict()
  return row.phase
}
/** Invoked in the SAME mutation and publication as the review state change.
 * A recorded submitted state never authorizes resubmission after unknown COMMIT. */
export async function transitionReviewNativeEntryLocked(sql: GraphTransactionSql, job: ReviewJob, executionId: string,
  phase: 'entered' | 'not_submitted', source: { evidence: GraphEvidence; sourceDigest: string }, proof?: ReviewNativeProofRecord): Promise<void> {
  const current = await reviewEntryPhaseLocked(sql, job, executionId)
  if (current === phase && phase === 'not_submitted') return // immutable first sealed receipt remains authoritative
  if (current !== 'reserved' || job.submittedAt || job.acknowledgedAt || job.providerTurnOrMessageId) return conflict()
  if (phase === 'entered' && (!proof || proof.original.type !== 'entry'
    || proof.execution.executionId !== executionId || !sameRepeatValue(proof.job, reviewJobIdentity(job)))) return conflict()
  const changed = await sql.query(`update review_native_entries set phase=$3,entry_proof_id=$4,
    source_id=$5,source_revision=$6::bigint,source_digest=$7
    where job_id=$1 and execution_id=$2 and phase='reserved'`, [job.id, executionId, phase, proof?.proofId ?? null,
    source.evidence.sourceId, source.evidence.sourceRevision, source.sourceDigest])
  if (changed.rowCount !== 1) return conflict()
}
