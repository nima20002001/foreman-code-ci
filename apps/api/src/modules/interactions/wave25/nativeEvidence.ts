import { assertReviewOriginalProofLocked } from '../reviewNativeProof.js'
import { DurableInteractionSchema, ReviewJobSchema } from '@foreman-code/contracts'
import {
  parseNativeGraphObservation, assertNativeGraphProjectionAuthority, sameGraphScope,
  canonicalGraphJson, type NativeGraphObservation,
} from '@foreman-code/contracts/wave25'
import type { NativeGraphProjectionGuard } from '../../run-graph/records.js'
import type { RunGraphPublication } from '../../run-graph/publication.js'
import { graphSourceDigest } from '../../run-graph/publication.js'
import type { GraphTransactionSql } from '../../run-graph/connection.js'
import { fail, readContext } from './context.js'
import { reviewFact, sourceForReview } from './publication.js'

/** A5 supplies a complete normalized observation and its EXISTING locked owner.
 * This consumer does not parse native frames, infer completion or acquire a runtime.
 * Run it in the same publication as A5's source/projection write. */
export async function recordReviewObservation(publication: RunGraphPublication,
  value: NativeGraphObservation, guard: NativeGraphProjectionGuard, originalProofId: string): Promise<void> {
  const observation = parseNativeGraphObservation(value)
  if (observation.work.workKind !== 'review' || !sameGraphScope(observation.scope, publication.scope)
    || canonicalGraphJson(guard.expected.key) !== canonicalGraphJson(observation.work)
    || guard.expected.connectionGeneration !== observation.connectionGeneration) return fail('GRAPH_SCOPE_MISMATCH')
  const currentAuthority = await guard.readCurrentLocked(publication.sql, publication.scope, observation.work)
  assertNativeGraphProjectionAuthority(guard.expected, currentAuthority)
  const row = (await publication.sql.query<{ record: unknown; revision: string; execution_id: string; approval_native_evidence: unknown }>(
    'select record,revision::text,execution_id,approval_native_evidence from review_jobs where id=$1 for update',
    [observation.work.workId])).rows[0]
  const job = ReviewJobSchema.parse(row?.record)
  if (row?.execution_id !== observation.work.execution.executionId || job.id !== observation.work.workId) return fail('REVIEW_JOB_IDENTITY_CONFLICT')
  // Liveness never overwrites semantic evidence and never creates a turn.
  if (observation.kind === 'transport') return
  if (!job.submittedAt) return fail('GRAPH_EVIDENCE_INVALID')
  await assertReviewOriginalProofLocked(publication.sql, job, observation, originalProofId)
  if (job.providerTurnOrMessageId && job.providerTurnOrMessageId !== observation.submissionId) return fail('REVIEW_JOB_IDENTITY_CONFLICT')
  const previous = row?.approval_native_evidence ? parseNativeGraphObservation(row.approval_native_evidence) : undefined
  if (previous && previous.kind !== 'transport') {
    if (previous.submissionId !== observation.submissionId) return fail('REVIEW_JOB_IDENTITY_CONFLICT')
    if (canonicalGraphJson(previous.source) === canonicalGraphJson(observation.source)) {
      if (canonicalGraphJson(previous) !== canonicalGraphJson(observation)) return fail('GRAPH_SOURCE_CONFLICT')
      return
    }
    if (previous.kind === 'terminal') {
      if (observation.kind !== 'terminal') return
      if (canonicalGraphJson(previous.terminal) !== canonicalGraphJson(observation.terminal)) return fail('GRAPH_TERMINAL_CONFLICT')
      return
    }
    if (observation.kind === 'submission' && previous.kind === 'submission') {
      if (previous.state === 'acknowledged' && observation.state !== 'acknowledged') return
      if (previous.sourceStreamId === observation.sourceStreamId
        && BigInt(observation.sourcePosition) <= BigInt(previous.sourcePosition)) return
    }
  }
  const interaction = (await publication.sql.query<{ record: unknown }>(
    'select record from durable_interactions where id=$1', [job.interactionId])).rows[0]
  const context = await readContext(publication.sql, DurableInteractionSchema.parse(interaction?.record))
  if (!sameGraphScope(context.scope, publication.scope) || context.reviewer?.id !== row.execution_id) return fail('REVIEW_JOB_IDENTITY_CONFLICT')
  // The snapshot derives acknowledgementId from this receipt. Publish that same
  // review projection in the receipt's transaction, before the later coordinator
  // business transition. A changed acknowledgement must never reuse a revision.
  const revision = String(BigInt(row.revision) + 1n)
  await publication.source({ evidence: sourceForReview(job, revision, observation.source),
    sourceDigest: graphSourceDigest({ job, nativeEvidence: observation, originalProofId }),
    facts: [reviewFact(context, job, revision, acknowledgementId(observation))] }, async (sql) => {
    const result = await sql.query(`update review_jobs set approval_native_evidence=$2::jsonb,approval_original_proof_id=$4,revision=revision+1
      where id=$1 and revision=$3::bigint`, [job.id, JSON.stringify(observation), row.revision, originalProofId])
    if (result.rowCount !== 1) return fail('REVISION_CONFLICT')
  })
}

export async function reviewEvidence(sql: GraphTransactionSql, jobId: string): Promise<NativeGraphObservation | undefined> {
  const row = (await sql.query<{ record: unknown; approval_native_evidence: unknown; approval_original_proof_id: string | null }>(
    'select record,approval_native_evidence,approval_original_proof_id from review_jobs where id=$1', [jobId])).rows[0]
  if (!row?.approval_native_evidence) return undefined
  const observation = parseNativeGraphObservation(row.approval_native_evidence)
  if (!row.approval_original_proof_id) return fail('REVIEW_ORIGINAL_SOURCE_REQUIRED')
  await assertReviewOriginalProofLocked(sql, ReviewJobSchema.parse(row.record), observation, row.approval_original_proof_id)
  return observation
}

export function acknowledgementId(observation: NativeGraphObservation | undefined): string | undefined {
  return observation && (observation.kind === 'terminal' && observation.terminal.nativeSettled
    || observation.kind === 'submission' && observation.state === 'acknowledged')
    ? `ack:${graphSourceDigest({ work: observation.work, source: observation.source }).slice(7)}` : undefined
}
