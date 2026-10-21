import { readWorkflowClosure } from '../workflowClosure.js'
import { assertReviewJobTerminalProofLocked } from '../reviewNativeProof.js'
import { createHash } from 'node:crypto'
import { approvalAttentionFacts } from './attention.js'
import { DurableInteractionSchema, ReviewJobSchema, type DurableInteraction, type ReviewJob,
  type InteractionResponseValue } from '@foreman-code/contracts'
import {
  GraphInteractionSchema, GraphReviewSchema, type GraphEffect, type GraphEvidence, type GraphFact,
} from '@foreman-code/contracts/wave25'
import { graphSourceDigest, type RunGraphPublication, type GraphEffectGuard } from '../../run-graph/publication.js'
import type { GraphTransactionSql } from '../../run-graph/connection.js'
import { identity, fail, lockInteraction, readContext, type ApprovalContext } from './context.js'
import { publicReviewUnsettled } from '../../run-graph/publicLifecycle.js'
import { runCleanupAllowed } from './cleanupAuthority.js'

export function interactionFact(context: ApprovalContext, interaction: DurableInteraction,
  resumeState: 'not_started' | 'pending' | 'unknown' = interaction.status === 'canceled' ? 'unknown' : interaction.deliveryState === 'delivered' ? 'pending' : 'not_started'): GraphFact {
  return { type: 'interaction.state', interaction: GraphInteractionSchema.parse({
    interactionId: interaction.id, revision: String(interaction.revision), requester: identity(context.requester),
    ...(context.reviewer ? { reviewer: identity(context.reviewer), approvalRelationshipId: context.relationshipId } : {}),
    handler: interaction.approval.handler, status: interaction.status, deliveryState: interaction.deliveryState, resumeState,
    ...(interaction.selectedOptionId ? { selectedOptionId: interaction.selectedOptionId, decision: interaction.selectedSemantic } : {}),
  }) }
}
export function reviewFact(context: ApprovalContext, job: ReviewJob, revision: string, acknowledgementId?: string): GraphFact {
  if (!context.reviewer || !context.relationshipId) return fail('APPROVAL_DIRECT_CONNECTION_REQUIRED')
  return { type: 'review.state', review: GraphReviewSchema.parse({
    reviewJobId: job.id, interactionId: job.interactionId, relationshipId: context.relationshipId,
    requester: identity(context.requester), reviewer: identity(context.reviewer), revision, leaseAttempt: job.attempt, state: job.state,
    nativeCleanup: job.cleanup?.nativeState ?? (job.state === 'completed' ? 'terminal' : job.submittedAt ? 'pending' : 'not_started'),
    // A successful job uses a Run-lifetime reviewer credential, not a per-job token.
    credentialCleanup: job.cleanup?.credentialState ?? 'not_required',
    ...(acknowledgementId ? { acknowledgementId } : {}),
  }) }
}
export function nextInteraction(previous: DurableInteraction, fields: Partial<DurableInteraction>): DurableInteraction {
  if (!Number.isSafeInteger(previous.revision + 1)) return fail('APPROVAL_REVISION_EXHAUSTED')
  return DurableInteractionSchema.parse(JSON.parse(JSON.stringify({ ...previous, ...fields, revision: previous.revision + 1, updatedAt: new Date().toISOString() })))
}
export function decisionDigest(interaction: DurableInteraction, optionId = interaction.selectedOptionId,
  response?: InteractionResponseValue): string {
  const option = interaction.responseOptions.find((item) => item.optionId === optionId)
  if (!option) return fail('INTERACTION_OPTION_INVALID')
  const saved = interaction.nativeResponse
  let values = response
  if (values === undefined && saved && typeof saved === 'object' && !Array.isArray(saved)) values = saved.response
  return graphSourceDigest({ interactionId: interaction.id, executionId: interaction.executionId,
    harness: interaction.harness, providerVersion: interaction.providerVersion, nativeSessionId: interaction.nativeSessionId,
    nativeRequestId: interaction.nativeRequestId, nativeRequestType: interaction.nativeRequestType,
    optionId: option.optionId, semantic: option.semantic,
    ...(values !== undefined ? { response: values } : {}) })
}
export async function writeInteraction(sql: GraphTransactionSql, previous: DurableInteraction, next: DurableInteraction): Promise<void> {
  const result = await sql.query(`update durable_interactions set status=$2,revision=$3,record=$4::jsonb,updated_at=clock_timestamp()
    where id=$1 and revision=$5`, [next.id, next.status, next.revision, JSON.stringify(next), previous.revision])
  if (result.rowCount !== 1) return fail('REVISION_CONFLICT')
}
export async function publishInteraction(publication: RunGraphPublication, context: ApprovalContext,
  previous: DurableInteraction, next: DurableInteraction, options: {
    resumeState?: 'not_started' | 'pending' | 'unknown'; effect?: GraphEffect; guard?: GraphEffectGuard; mutate?: (sql: GraphTransactionSql) => Promise<void>
  } = {}): Promise<void> {
  const source = { evidence: { sourceKind: 'interaction' as const, sourceId: next.id, sourceRevision: String(next.revision) },
    sourceDigest: graphSourceDigest(next), facts: [interactionFact(context, next, next.status === 'canceled' ? 'unknown' : options.resumeState),
      ...await approvalAttentionFacts(publication.sql, context, { interaction: next }),
      ...(next.kind === 'work_direction' && next.status === 'delivered' ? [{
        type: 'exchange.retired' as const, exchangeKind: 'interaction' as const,
        exchangeId: next.id, finalRevision: String(next.revision),
      }] : [])] }
  const write = async (sql: GraphTransactionSql) => { await writeInteraction(sql, previous, next); await options.mutate?.(sql) }
  if (options.effect) {
    if (!options.guard) return fail('GRAPH_AUTHORITY_INVALID')
    await publication.effect({ ...source, effect: options.effect }, options.guard, write)
  } else await publication.source(source, write)
  if (next.status === 'canceled') await retireCanceledInteraction(publication, context, next)
}
export function sourceForReview(job: ReviewJob, revision: string, nativeEvidence?: GraphEvidence): GraphEvidence {
  // A4's derived review transition has its own source identity. The actual native
  // observation remains A5-owned and is included in the source digest by the caller.
  return { sourceKind: nativeEvidence ? 'native_event' : job.cleanup ? 'cleanup' : 'review', sourceId: job.id, sourceRevision: revision }
}

/** A durable source receipt, not a prunable journal lookup or a dynamic cleanup
 * predicate. Every receipt commits with the final state AND retirement below.
 * SQL callers use the durable_interactions alias `i`. SHA-256 keeps source IDs
 * bounded even for a maximum-length interaction ID; PostgreSQL's built-in
 * sha256(bytea) hashes the same UTF-8 bytes as canceledRetirementSourceId. */
export const CANCELED_INTERACTION_RETIRED_SQL = `exists (
  select 1 from run_graph_sources s join run_graph_sources original
    on original.run_id=s.run_id and original.source_kind='interaction'
    and original.source_id=i.id and original.source_revision=i.revision
    and original.source_digest=s.source_digest
  where s.run_id=i.run_id and s.source_kind='cleanup'
    and s.source_id='canceled-interaction-' || encode(sha256(convert_to(i.id,'UTF8')),'hex')
    and s.source_revision=i.revision
)`
export function canceledRetirementSourceId(id: string): string {
  return 'canceled-interaction-' + createHash('sha256').update(id, 'utf8').digest('hex')
}

/** Cancellation is negative authority, not proof of delivery failure, native
 * acknowledgement or process closure. In particular, Stop/cleanup intent alone
 * cannot discard the exchange. Review cleanup must also be settled. */
async function cancellationRetirable(sql: GraphTransactionSql, context: ApprovalContext,
  interaction: DurableInteraction, nativeClosed: boolean): Promise<boolean> {
  if (interaction.status !== 'canceled') return false
  if (interaction.kind === 'work_direction') return context.stopped
  if (!nativeClosed) {
    if (context.stopped || interaction.deliveryState !== 'not_started') return false
    const outstanding = await sql.query(`select 1 where
      exists(select 1 from interaction_delivery_attempts where interaction_id=$1)
      or exists(select 1 from interaction_graph_resumes where interaction_id=$1)`, [interaction.id])
    if (outstanding.rowCount) return false
  }
  if (nativeClosed && !await readWorkflowClosure(sql, context.requester)) return false
  const jobs = await sql.query<{ record: unknown; execution_id: string }>(
    'select record,execution_id from review_jobs where interaction_id=$1 order by id for update', [interaction.id])
  for (const { record, execution_id } of jobs.rows) {
    const job = ReviewJobSchema.parse(record)
    if (publicReviewUnsettled(job) || job.cleanup?.nativeState === 'pending' || job.cleanup?.credentialState === 'pending') return false
    await assertReviewJobTerminalProofLocked(sql, job, execution_id)
  }
  return true
}

/** Ordinary authoritative request cancellation; no caller can supply a closure
 * flag. Repeated cancellation can revisit an exchange after its review settles. */
export async function retireCanceledInteraction(publication: RunGraphPublication, context: ApprovalContext,
  interaction: DurableInteraction): Promise<void> {
  if (await cancellationRetirable(publication.sql, context, interaction, false)) {
    await publishCanceledRetirement(publication, context, interaction)
  }
}
async function publishCanceledRetirement(publication: RunGraphPublication, context: ApprovalContext,
  interaction: DurableInteraction): Promise<void> {
  const revision = String(interaction.revision)
  await publication.source({ evidence: { sourceKind: 'cleanup', sourceId: canceledRetirementSourceId(interaction.id), sourceRevision: revision },
    sourceDigest: graphSourceDigest(interaction), facts: [interactionFact(context, interaction),
      { type: 'exchange.retired', exchangeKind: 'interaction', exchangeId: interaction.id, finalRevision: revision }] }, async (sql) => {
    // No new decision, resume or native effect, and no fabricated acknowledgement.
    if ((await sql.query("select 1 from durable_interactions where id=$1 and run_id=$2 and status='canceled' and revision=$3",
      [interaction.id, publication.scope.runId, interaction.revision])).rowCount !== 1) return fail('REVISION_CONFLICT')
  })
}

/** Compose ONLY after finishStoppedReviewsInPublication, whose existing caller
 * contract requires confirmed native closure and whose SQL checks verify Run
 * cleanup authority and credential revocation. This does not perform or infer
 * cleanup. Attempts/resume records remain unchanged as historical evidence. */
export async function retireCanceledInteractionsAfterCleanup(publication: RunGraphPublication): Promise<void> {
  const { sql, scope } = publication
  if (!await runCleanupAllowed(sql, scope.runId)) return fail('EXECUTION_NOT_STOPPED')
  const rows = await sql.query<{ id: string }>(`select i.id from durable_interactions i
    where i.run_id=$1 and i.status='canceled' and not (${CANCELED_INTERACTION_RETIRED_SQL}) order by i.id`, [scope.runId])
  for (const { id } of rows.rows) {
    const current = await lockInteraction(sql, id), context = await readContext(sql, current)
    if (await cancellationRetirable(sql, context, current, true)) await publishCanceledRetirement(publication, context, current)
  }
}
