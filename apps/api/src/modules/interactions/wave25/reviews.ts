import type { ReviewNativeCapture } from '../reviewNativeCapture.js'
import { ReviewNativeProofServices, assertReviewCleanupProofLocked, assertReviewJobTerminalProofLocked } from '../reviewNativeProof.js'
import { reserveReviewNativeEntryLocked, reviewEntryPhaseLocked, transitionReviewNativeEntryLocked } from '../reviewNativeEntry.js'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { readWorkflowClosure } from '../workflowClosure.js'
import { approvalAttentionFacts } from './attention.js'
import { DurableInteractionSchema, ReviewJobSchema, type ReviewJob, type DurableInteraction, type NativeHarnessEvent } from '@foreman-code/contracts'
import type pg from 'pg'
import { sameWorkflowValue, type GraphEffect } from '@foreman-code/contracts/wave25'
import { beforeGraphCommit } from '../../run-graph/connection.js'
import { PostgresInteractionCoordinationRepository, type WriterFence } from '../coordination.js'
import { graphSourceDigest, type RunGraphPublication } from '../../run-graph/publication.js'
import { transact } from './transaction.js'
import { fail, isCurrentApprovalRun, readContext, runFor, requireLeaseAtCommit, type ApprovalContext } from './context.js'
import { acknowledgementId, reviewEvidence } from './nativeEvidence.js'
import { reviewFact, sourceForReview } from './publication.js'
import { assertWave25WorkerBinding } from './credentialAuthority.js'
import { stopForReviewFailure } from './stop.js'
import { runCleanupAllowed } from './cleanupAuthority.js'
import { renewReviewLease } from './reviewLease.js'
import { publicReviewRetirementFacts } from '../../run-graph/publicLifecycle.js'
import { appendReviewNativeGraphEvent, appendReviewNativeGraphHistory } from './reviewNativeGraph.js'
import { readRetainedRemoteReviewer } from '../retainedRemoteReviewer.js'
import { assertReviewerCheckoutAvailable } from '../../runs/worktreeReviewers.js'

function parseReviewJob(input: unknown): ReviewJob {
  return ReviewJobSchema.parse(JSON.parse(JSON.stringify(input)))
}

interface ReviewRow { lease_expires_at: Date | null; record: unknown; revision: string; lease_fence: string; lease_active: boolean;
  approval_connection_generation: string | null; execution_id: string; provider_version: string; working_directory: string }

async function rowFor(publication: RunGraphPublication, id: string): Promise<ReviewRow> {
  const row = (await publication.sql.query<ReviewRow>(`select record,revision::text,lease_fence::text,lease_expires_at,
    coalesce(lease_expires_at>clock_timestamp(),false) as lease_active,
    approval_connection_generation::text,execution_id,provider_version,working_directory
    from review_jobs where id=$1 for update`, [id])).rows[0]
  if (!row) return fail('REVIEW_JOB_NOT_FOUND')
  return row
}
async function contextFor(publication: RunGraphPublication, job: ReviewJob, active = false): Promise<ApprovalContext> {
  const found = (await publication.sql.query<{ record: unknown }>(
    'select record from durable_interactions where id=$1', [job.interactionId])).rows[0]
  return readContext(publication.sql, DurableInteractionSchema.parse(found?.record), active)
}
function settlementDigest(job: ReviewJob): string {
  return graphSourceDigest({ id: job.id, interactionId: job.interactionId, state: job.state,
    provider: job.provider, nativeSessionId: job.nativeSessionId, correlationId: job.correlationId })
}

/** Same queue/session lanes and ReviewJob authority; only current mutations use G1. */
export class Wave25InteractionCoordinationRepository extends PostgresInteractionCoordinationRepository {
  constructor(private readonly approvalPool: pg.Pool, private readonly nativeProofs?: ReviewNativeProofServices) { super(approvalPool) }
  assertOriginalNativeComposition(): void {
    if (!(this.nativeProofs instanceof ReviewNativeProofServices)) return fail('REVIEW_ORIGINAL_SOURCE_REQUIRED')
  }
  async assertReviewPhysicalSettlement(supplied: ReviewJob, executionId: string): Promise<void> {
    const { runId } = await this.subject('review', supplied.id)
    await transact(this.approvalPool, runId, async (publication) => {
      await assertReviewJobTerminalProofLocked(publication.sql, supplied, executionId)
    })
  }
  override async appendReviewNativeEvent(job: ReviewJob, event: NativeHarnessEvent,
    projection?: { writer: WriterFence; live: boolean; terminalReady: boolean; nativeCapture?: ReviewNativeCapture }): Promise<void> {
    await this.subject('review', job.id)

    if (!projection?.nativeCapture || !this.nativeProofs) return fail('REVIEW_ORIGINAL_SOURCE_REQUIRED')
    await appendReviewNativeGraphEvent(this.approvalPool, job, event,
      projection.writer, this.nativeProofs, projection.nativeCapture)
  }
  override async appendReviewNativeHistory(job: ReviewJob, events: readonly NativeHarnessEvent[],
    projection?: Parameters<PostgresInteractionCoordinationRepository['appendReviewNativeEvent']>[2]): Promise<void> {
    await this.subject('review', job.id)
    if (!projection?.nativeCapture || !this.nativeProofs) return fail('REVIEW_ORIGINAL_SOURCE_REQUIRED')
    await appendReviewNativeGraphHistory(this.approvalPool, job, events,
      projection.writer, this.nativeProofs, projection.nativeCapture)
  }
  private async subject(kind: 'interaction' | 'review' | 'execution', id: string) {
    const runId = await runFor(this.approvalPool, kind, id)
    return { runId, enabled: await isCurrentApprovalRun(this.approvalPool, runId) }
  }
  override async assertOrchestratorConnection(interaction: DurableInteraction, executionId: string) {

    const context = await readContext(this.approvalPool, interaction, true)
    if (context.reviewer?.id !== executionId) return fail('INTERACTION_ACCESS_DENIED')
    return { requestingNodeId: context.requester.workflowNodeId, orchestratorNodeId: context.reviewer.workflowNodeId }
  }
  override async assertReviewConnection(job: ReviewJob): Promise<void> {
    await this.subject('review', job.id)

    const found = (await this.approvalPool.query<{ record: unknown; execution_id: string; reference: unknown }>(
      `select i.record,j.execution_id,s.reference from review_jobs j join durable_interactions i on i.id=j.interaction_id
       join execution_native_sessions s on s.execution_id=j.execution_id where j.id=$1`, [job.id])).rows[0]
    const interaction = DurableInteractionSchema.parse(found?.record)
    const context = await readContext(this.approvalPool, interaction, true)
    if (!context.reviewer || found?.execution_id !== context.reviewer.id || context.reviewer.nativeSessionId !== job.nativeSessionId
      || interaction.id !== job.interactionId || interaction.approval.designatedOrchestratorAgentId !== job.reviewerAgentId) {
      return fail('REVIEW_JOB_IDENTITY_CONFLICT')
    }
  }
  override async ensureReviewJob(job: ReviewJob, supplied?: { executionId: string; workingDirectory: string; providerVersion: string }) {
    const mode = await this.subject('interaction', job.interactionId)

    if (!supplied) return fail('REVIEW_JOB_CONTEXT_MISSING')
    const accepted = parseReviewJob(job)
    if (accepted.state !== 'pending' || accepted.attempt !== 0) return fail('REVIEW_JOB_INITIAL_STATE_INVALID')
    return transact(this.approvalPool, mode.runId, async (publication) => {
      const context = await contextFor(publication, accepted, true)
      if (context.stopped || context.reviewer?.id !== supplied.executionId
        || context.reviewer.nativeSessionId !== accepted.nativeSessionId || context.reviewer.agentId !== accepted.reviewerAgentId) {
        return fail('REVIEWER_EXECUTION_NOT_READY')
      }
      const session = (await publication.sql.query<{ reference: { harness: string; providerVersion: string }; working_directory: string }>(
        `select s.reference,e.record->>'workingDirectory' as working_directory from execution_native_sessions s
         join harness_executions e on e.id=s.execution_id where e.id=$1`, [supplied.executionId])).rows[0]
      if (!session || session.reference.harness !== accepted.provider || session.reference.providerVersion !== supplied.providerVersion
        || session.working_directory !== supplied.workingDirectory) return fail('REVIEW_JOB_CONTEXT_MISSING')
      const old = (await publication.sql.query<{ record: unknown; execution_id: string; provider_version: string; working_directory: string }>(
        'select record,execution_id,provider_version,working_directory from review_jobs where interaction_id=$1 and reviewer_agent_id=$2',
        [accepted.interactionId, accepted.reviewerAgentId])).rows[0]
      if (old) {
        const existing = parseReviewJob(old.record)
        if (existing.provider !== accepted.provider || existing.nativeSessionId !== accepted.nativeSessionId
          || old.execution_id !== supplied.executionId || old.provider_version !== supplied.providerVersion
          || old.working_directory !== supplied.workingDirectory) return fail('REVIEW_JOB_IDENTITY_CONFLICT')
        return { job: existing, created: false }
      }
      await assertReviewerCheckoutAvailable(publication.sql, context.reviewer)
      await publication.source({ evidence: sourceForReview(accepted, '0'), sourceDigest: graphSourceDigest(accepted),
        facts: [reviewFact(context, accepted, '0'), ...await approvalAttentionFacts(publication.sql, context, { review: accepted })] }, async (sql) => {
        await sql.query(`insert into review_jobs(id,interaction_id,reviewer_agent_id,state,record,execution_id,working_directory,provider_version)
          values($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`, [accepted.id, accepted.interactionId, accepted.reviewerAgentId, accepted.state,
          JSON.stringify(accepted), supplied.executionId, supplied.workingDirectory, supplied.providerVersion])
        await reserveReviewNativeEntryLocked(publication, accepted, supplied.executionId)
      })
      return { job: accepted, created: true }
    })
  }
  override async claimReviewJob(id: string, owner: string, token: string, expiresAt: string): Promise<ReviewJob> {
    const mode = await this.subject('review', id)

    if (!owner || !token || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) return fail('LEASE_EXPIRY_INVALID')
    return transact(this.approvalPool, mode.runId, async (publication) => {
      await publication.sql.query(`select p.id from management_principals p join worker_credential_bindings b on b.principal_id=p.id
        join review_jobs j on j.execution_id=b.execution_id where j.id=$1 order by p.id for share of p`, [id])
      await publication.sql.query(`select b.principal_id from worker_credential_bindings b join review_jobs j on j.execution_id=b.execution_id
        where j.id=$1 order by b.principal_id for update of b`, [id])
      const row = await rowFor(publication, id), current = parseReviewJob(row.record)
      if (row.lease_active || current.state === 'completed' || current.state === 'failed' && current.cleanup?.completedAt
        || current.retryAfter && Date.parse(current.retryAfter) > Date.now()) return fail('REVIEW_JOB_NOT_CLAIMABLE')
      if (!current.submittedAt && (await publication.sql.query(`select 1 from review_jobs where execution_id=$1 and id<>$2
        and (state in ('submitted','acknowledged','uncertain') or state='failed' and record->'cleanup'->>'completedAt' is null
          or lease_expires_at>clock_timestamp()) limit 1`, [row.execution_id, id])).rowCount) return fail('REVIEW_JOB_NOT_CLAIMABLE')
      const context = await contextFor(publication, current)
      const state = ['submitted', 'acknowledged', 'uncertain', 'failed'].includes(current.state) ? current.state : 'leased'
      const next = parseReviewJob({ ...current, state, attempt: current.attempt + 1,
        leaseOwner: owner, leaseToken: token, leaseExpiresAt: expiresAt, retryAfter: undefined, updatedAt: new Date().toISOString() })
      const evidence = await reviewEvidence(publication.sql, id), ack = acknowledgementId(evidence)
      if (next.state === 'acknowledged' && !ack) return fail('REVIEW_ACKNOWLEDGEMENT_MISSING')
      const retained = current.acknowledgedAt && current.providerTurnOrMessageId && ack && context.reviewer
        ? await readRetainedRemoteReviewer(publication.sql, context.reviewer) : undefined
      if (retained && (!evidence || evidence.kind === 'transport'
        || evidence.submissionId !== current.providerTurnOrMessageId)) return fail('REVIEW_JOB_IDENTITY_CONFLICT')
      if (retained) beforeGraphCommit(publication.sql, async () => {
        const original = await readRetainedRemoteReviewer(publication.sql, context.reviewer!)
        if (!sameWorkflowValue(original, retained)) return fail('REVIEWER_AUTHORITY_LOST')
      })
      const revision = String(BigInt(row.revision) + 1n)
      await publication.source({ evidence: sourceForReview(next, revision, ack ? evidence?.source : undefined),
        sourceDigest: graphSourceDigest({ next, nativeEvidence: evidence ?? null }), facts: [reviewFact(context, next, revision, ack), ...await approvalAttentionFacts(publication.sql, context, { review: next })] }, async (sql) => {
        const result = await sql.query(`update review_jobs set state=$2,record=$3::jsonb,revision=revision+1,updated_at=clock_timestamp()
          where id=$1 and revision=$4::bigint and (lease_expires_at is null or lease_expires_at<=clock_timestamp())
            and $5::timestamptz>clock_timestamp()`, [id, next.state, JSON.stringify(next), row.revision, expiresAt])
        if (result.rowCount !== 1) return fail('REVIEW_JOB_NOT_CLAIMABLE')
        if (!current.submittedAt) await sql.query(`update worker_credential_bindings b set approval_review_job_id=$1,
          approval_review_lease_fence=j.lease_fence from review_jobs j where j.id=$1 and b.execution_id=j.execution_id
          and b.purpose='reviewer' and b.revoked_at is null and (b.approval_review_job_id is null or b.approval_review_job_id=j.id
            or exists(select 1 from review_jobs prior where prior.id=b.approval_review_job_id and prior.state='completed'
              and prior.approval_native_evidence->>'kind'='terminal' and prior.approval_native_evidence->'terminal'->>'nativeSettled'='true'))`, [id])
        if (retained) {
          // The original process can call MCP while its observation lease is reclaimed.
          const rebound = await sql.query(`update worker_credential_bindings b set approval_review_job_id=$1,
            approval_review_lease_fence=j.lease_fence from review_jobs j
            where j.id=$1 and b.principal_id=$2 and b.execution_id=j.execution_id
              and b.purpose='reviewer' and b.revoked_at is null and b.approval_native_session_id=$3
              and (b.approval_review_job_id is null or b.approval_review_job_id=j.id)
            returning b.principal_id`, [id, retained.principalId, current.nativeSessionId])
          if (rebound.rowCount !== 1) return fail('REVIEWER_CREDENTIAL_LOST')
        }
      })
      return next
    })
  }
  override async renewReviewJob(id: string, token: string, leaseMs: number): Promise<string> {
    await this.subject('review', id)

    return renewReviewLease(this.approvalPool, id, token, leaseMs)
  }
  override async transitionReviewJob(id: string, token: string, requested: ReviewJob['state'],
    fields: Parameters<PostgresInteractionCoordinationRepository['transitionReviewJob']>[3] = {},
    expected?: { revision: number; fence: number }): Promise<ReviewJob> {
    const mode = await this.subject('review', id)

    return transact(this.approvalPool, mode.runId, async (publication) => {
      const row = await rowFor(publication, id), current = parseReviewJob(row.record)
      if (!row.lease_active || current.leaseToken !== token || expected &&
        (String(expected.revision) !== row.revision || String(expected.fence) !== row.lease_fence)) return fail('REVIEW_JOB_LEASE_LOST')
      if (current.state === 'completed' || current.state === 'failed' && requested !== 'failed') return fail('REVIEW_TERMINAL_CONFLICT')
      if (current.providerTurnOrMessageId && fields.providerTurnOrMessageId
        && current.providerTurnOrMessageId !== fields.providerTurnOrMessageId) return fail('REVIEW_JOB_IDENTITY_CONFLICT')
      if (!row.lease_expires_at) return fail('REVIEW_JOB_LEASE_LOST')
      requireLeaseAtCommit(publication.sql, row.lease_expires_at, 'REVIEW_JOB_LEASE_LOST')
      const context = await contextFor(publication, current)
      if (row.execution_id !== context.reviewer?.id) return fail('REVIEW_JOB_IDENTITY_CONFLICT')
      // A drained observer releases its job without claiming another native writer.
      const releaseOnly = requested === current.state && fields.releaseLease === true
        && Object.keys(fields).length === 1
      let generation = row.approval_connection_generation
      if (fields.writerFence) {
        const lane = (await publication.sql.query<{ generation: string; correlation: string | null; owner_agent_id: string }>(
          `select record->>'connectionGeneration' as generation,record->>'correlationId' as correlation,owner_agent_id
           from native_session_lanes where id=$1 and harness=$3 and native_session_id=$4
             and record->>'leaseToken'=$2 and (record->>'leaseExpiresAt')::timestamptz>clock_timestamp() for update`,
          [fields.writerFence.id, fields.writerFence.token, current.provider, current.nativeSessionId])).rows[0]
        if (!lane || lane.owner_agent_id !== current.reviewerAgentId) return fail('SESSION_LANE_LEASE_LOST')
        if (requested === 'submitted') {
          if (current.submittedAt || current.providerTurnOrMessageId || current.acknowledgedAt) return fail('REVIEW_SUBMISSION_NOT_REPLAYABLE')
          if (lane.correlation !== current.correlationId || context.stopped) return fail('REVIEWER_AUTHORITY_LOST')
          generation = lane.generation
        } else if (generation !== null && generation !== lane.generation) {
          const observed = await reviewEvidence(publication.sql, id)
          if (!observed || observed.kind === 'transport' || observed.connectionGeneration !== lane.generation
            || observed.submissionId !== current.providerTurnOrMessageId) return fail('GRAPH_STALE_GENERATION')
          // Reconciliation of the same exact native work may adopt a qualified
          // current observation. An expired job or writer still cannot do this.
          generation = lane.generation
        }
      } else if (!releaseOnly && ['submitted', 'acknowledged', 'completed'].includes(requested)) {
        return fail('SESSION_LANE_LEASE_LOST')
      }
      const entryProof = requested === 'submitted' && !current.submittedAt
        ? this.nativeProofs && fields.nativeCapture
          ? await this.nativeProofs.persistLocked(publication, current, fields.nativeCapture)
          : fail('REVIEW_ORIGINAL_SOURCE_REQUIRED') : undefined
      const observation = await reviewEvidence(publication.sql, id)
      const ack = acknowledgementId(observation)
      let state = requested
      let cleanup = fields.cleanup ?? current.cleanup
      let error = fields.error ?? current.error
      if (requested === 'acknowledged' && !ack) state = current.acknowledgedAt ? 'uncertain' : 'submitted'
      if (requested === 'completed') {
        if (observation?.kind !== 'terminal' || !observation.terminal.nativeSettled) {
          state = 'uncertain'
          error = { code: 'REVIEW_SETTLEMENT_UNCERTAIN', message: 'Exact native terminal evidence is not persisted yet.' }
        } else if (observation.terminal.outcome !== 'succeeded') {
          state = 'failed'
          error = { code: 'REVIEW_NATIVE_FAILED', message: 'The native review terminated without a successful settlement.' }
          cleanup = cleanup ?? { nativeState: 'terminal', credentialState: 'pending', interruptState: 'not_sent' }
        }
      }
      if (state === 'submitted' && !current.submittedAt) {
        if (requested !== 'submitted') return fail('REVIEW_SUBMISSION_NOT_REPLAYABLE')
        const interaction = (await publication.sql.query<{ record: unknown }>(
          'select record from durable_interactions where id=$1', [current.interactionId])).rows[0]
        await readContext(publication.sql, DurableInteractionSchema.parse(interaction?.record), true)
      }
      if (state === 'failed' && !cleanup) cleanup = { nativeState: 'pending', credentialState: 'pending', interruptState: 'not_sent' }
      if (cleanup && state !== 'failed') return fail('REVIEW_CLEANUP_CONFLICT')
      if (cleanup?.nativeState === 'not_started' && (current.submittedAt || current.providerTurnOrMessageId || current.acknowledgedAt)) return fail('REVIEW_CLEANUP_CONFLICT')
      if (current.cleanup && cleanup) {
        const old = current.cleanup
        if (old.nativeState !== 'pending' && old.nativeState !== cleanup.nativeState
          || old.credentialState !== 'pending' && old.credentialState !== cleanup.credentialState
          || old.credentialPrincipalId && old.credentialPrincipalId !== cleanup.credentialPrincipalId
          || old.interruptState === 'acknowledged' && cleanup.interruptState !== 'acknowledged'
          || old.interruptState !== 'not_sent' && cleanup.interruptState === 'not_sent'
          || old.completedAt && old.completedAt !== cleanup.completedAt) return fail('REVIEW_CLEANUP_CONFLICT')
      }
      const now = new Date().toISOString()
      const releases = fields.releaseLease ?? ['completed', 'blocked_busy', 'blocked_disconnected', 'uncertain', 'failed'].includes(state)
      const next = parseReviewJob({ ...current, state, updatedAt: now,
        ...(state === 'submitted' ? { submittedAt: current.submittedAt ?? now } : {}),
        ...(state === 'acknowledged' ? { acknowledgedAt: current.acknowledgedAt ?? now } : {}),
        ...(state === 'completed' ? { completedAt: current.completedAt ?? now } : {}),
        ...(fields.providerTurnOrMessageId ? { providerTurnOrMessageId: fields.providerTurnOrMessageId } : {}),
        ...(cleanup ? { cleanup } : {}), ...(error ? { error } : {}),
        ...(fields.retryAfter ? { retryAfter: fields.retryAfter } : {}),
        ...(releases ? { leaseOwner: undefined, leaseToken: undefined, leaseExpiresAt: undefined } : {}),
      })
      if (cleanup?.credentialState === 'revoked') {
        const activeCredentials = await publication.sql.query(`select 1 from worker_credential_bindings b
          join management_principals p on p.id=b.principal_id where b.execution_id=$1
          and ($2::text is null or b.principal_id=$2) and (b.revoked_at is null or p.revoked_at is null) limit 1`,
        [row.execution_id, cleanup.credentialPrincipalId ?? null])
        if (activeCredentials.rowCount) return fail('REVIEW_CREDENTIAL_CLEANUP_PENDING')
      }
      const revision = String(BigInt(row.revision) + 1n)
      const source = { evidence: sourceForReview(next, revision, ack ? observation?.source : undefined),
        sourceDigest: graphSourceDigest({ next, nativeEvidence: observation ?? null }), facts: [reviewFact(context, next, revision, ack), ...await approvalAttentionFacts(publication.sql, context, { review: next }),
          ...publicReviewRetirementFacts(next, revision)] }
      const mutate = async () => {
        if (state === 'submitted' && !current.submittedAt) await transitionReviewNativeEntryLocked(
          publication.sql, current, row.execution_id, 'entered', source, entryProof)
        if (cleanup?.nativeState === 'not_started') await transitionReviewNativeEntryLocked(
          publication.sql, current, row.execution_id, 'not_submitted', source)
        // Positive terminal/closed/not-submitted cleanup always has independent
        // original native or sealed-entry proof; the cleanup enum is not proof.
        if (cleanup && cleanup.nativeState !== 'pending') await assertReviewCleanupProofLocked(
          publication.sql, next, row.execution_id)
        const result = await publication.sql.query(`update review_jobs set state=$2,record=$3::jsonb,revision=revision+1,
          approval_connection_generation=$7::bigint,updated_at=clock_timestamp()
          where id=$1 and revision=$4::bigint and lease_token=$5 and lease_fence=$6::bigint and lease_expires_at>clock_timestamp()`,
        [id, next.state, JSON.stringify(next), row.revision, token, row.lease_fence, generation])
        if (result.rowCount !== 1) return fail('REVIEW_JOB_LEASE_LOST')
      }
      if (['completed', 'failed'].includes(next.state) && !['completed', 'failed'].includes(current.state)) {
        const effect: GraphEffect = { identity: { kind: 'review.settle', entityId: next.id }, digest: settlementDigest(next) }
        await publication.effect({ ...source, effect }, { expected: { scope: context.scope, effect: effect.identity,
          effectDigest: effect.digest, ownerId: token, fence: row.lease_fence, connectionGeneration: generation },
          readCurrentLocked: async () => {
            const actual = await rowFor(publication, id), actualJob = parseReviewJob(actual.record)
            const lane = (await publication.sql.query<{ generation: string }>(
              "select record->>'connectionGeneration' as generation from native_session_lanes where harness=$1 and native_session_id=$2",
              [actualJob.provider, actualJob.nativeSessionId])).rows[0]
            return { scope: (await contextFor(publication, actualJob)).scope,
              effect: { kind: 'review.settle', entityId: actualJob.id },
              effectDigest: settlementDigest({ ...actualJob, state: next.state }), ownerId: actualJob.leaseToken ?? 'lost',
              fence: actual.lease_fence, connectionGeneration: generation === null ? null : lane?.generation ?? null,
              ownership: actual.lease_active ? 'held' : 'lost', access: 'effect', security: 'valid',
              effectClosed: ['completed', 'failed'].includes(actualJob.state), submission: actualJob.submittedAt ? 'uncertain' : 'not_submitted' }
          } }, mutate)
      } else await publication.source(source, mutate)
      if (next.state === 'failed') await stopForReviewFailure(publication, next, context)
      return next
    })
  }
  override async bindWorkflowSession(executionId: string, session: Parameters<PostgresInteractionCoordinationRepository['bindWorkflowSession']>[1]): Promise<void> {
    const mode = await this.subject('execution', executionId)

    await transact(this.approvalPool, mode.runId, async (publication) => {
      const sql = publication.sql
      const row = (await sql.query<{ agent_id: string; native_session_id: string | null }>(
        "select agent_id,record->>'nativeSessionId' as native_session_id from harness_executions where id=$1", [executionId])).rows[0]
      if (!row || row.native_session_id && row.native_session_id !== session.nativeSessionId) return fail('NATIVE_SESSION_IDENTITY_MISMATCH')
      const lane = (await sql.query<{ generation: string }>(`select record->>'connectionGeneration' as generation from native_session_lanes
        where harness=$1 and native_session_id=$2 and owner_agent_id=$3`, [session.harness, session.nativeSessionId, row.agent_id])).rows[0]
      if (!lane) return fail('APPROVAL_SESSION_LANE_MISSING')
      const bound = await sql.query(`insert into execution_native_sessions(execution_id,reference) values($1,$2::jsonb)
        on conflict(execution_id) do update set reference=execution_native_sessions.reference
        where execution_native_sessions.reference=excluded.reference returning execution_id`, [executionId, JSON.stringify(session)])
      if (bound.rowCount !== 1) return fail('NATIVE_SESSION_IDENTITY_MISMATCH')
      await sql.query(`update worker_credential_bindings set approval_native_session_id=$2,approval_connection_generation=$3::bigint
        where execution_id=$1 and purpose='workflow' and revoked_at is null and approval_native_session_id is null`,
      [executionId, session.nativeSessionId, lane.generation])
    })
  }
  override async workflowSession(executionId: string) {
    const session = await super.workflowSession(executionId), mode = await this.subject('execution', executionId)
    if (!session || !mode.enabled) return session
    const bindings = (await this.approvalPool.query<{ principal_id: string }>(
      "select principal_id from worker_credential_bindings where execution_id=$1 and purpose='reviewer' and revoked_at is null", [executionId])).rows
    let reviewerActive = false
    for (const binding of bindings) {
      try { await assertWave25WorkerBinding(this.approvalPool, binding.principal_id); reviewerActive = true; break } catch { /* ignore: no cached credential grants authority. */ }
    }
    return { ...session, reviewerActive }
  }

  override async nextReviewJob(reviewerAgentId: string): Promise<ReviewJob | undefined> {
    const result = await this.approvalPool.query<{ record: unknown }>(`select j.record from review_jobs j
      join durable_interactions i on i.id=j.interaction_id join runs r on r.id=i.run_id
      join workflow_versions v on v.id=r.workflow_version_id where j.reviewer_agent_id=$1
      and (j.state in ('pending','leased','blocked_busy','blocked_disconnected','submitted','acknowledged','uncertain')
        or j.state='failed' and j.record->'cleanup' is not null and j.record->'cleanup'->>'completedAt' is null)
      and (j.lease_expires_at is null or j.lease_expires_at<=clock_timestamp())
      and (j.record->>'retryAfter' is null or (j.record->>'retryAfter')::timestamptz<=clock_timestamp())
      order by case when v.execution_semantics_version=3 and (j.record->>'submittedAt' is not null
        or j.state in ('submitted','acknowledged','uncertain','failed')) then 0 else 1 end,j.updated_at,j.id limit 1`, [reviewerAgentId])
    return result.rows[0] ? parseReviewJob(result.rows[0].record) : undefined
  }

  override async reviewRunStopped(id: string): Promise<boolean> {
    const mode = await this.subject('review', id)

    return runCleanupAllowed(this.approvalPool, mode.runId)
  }

  override async finishStoppedReviews(runId: string, credentialsRequired: boolean, client?: pg.ClientBase): Promise<void> {

    // A runtime owner may pass its idle connection after native cleanup.
    // It may not pass an open/unknown transaction and start a second publication.
    const status = (client as (pg.ClientBase & { getTransactionStatus?: () => string | null }) | undefined)?.getTransactionStatus?.()
    if (client && status !== 'I') return fail('APPROVAL_EXCLUSIVE_PUBLICATION_REQUIRED',
      'Pass the existing G1 publication to finishStoppedReviewsInPublication; a raw client cannot open a nested publication.')
    await transact(this.approvalPool, runId, (publication) => this.finishStoppedReviewsInPublication(publication, credentialsRequired))
  }

  /** Existing caller contract: invoke only AFTER confirmed native closure. Actual
   * credential revocation is rechecked here; neither Stop nor cleanup intent alone
   * is treated as proof that a provider process closed. */
  async finishStoppedReviewsInPublication(publication: RunGraphPublication, credentialsRequired: boolean): Promise<void> {
    const runId = publication.scope.runId, sql = publication.sql
    if (!await runCleanupAllowed(sql, runId)) return fail('EXECUTION_NOT_STOPPED')
    if (credentialsRequired && (await sql.query(`select 1 from worker_credential_bindings b
      join management_principals p on p.id=b.principal_id where b.run_id=$1
      and (b.revoked_at is null or p.revoked_at is null) limit 1`, [runId])).rowCount) return fail('REVIEW_CREDENTIAL_CLEANUP_PENDING')
    const jobs = (await sql.query<{ id: string }>(`select j.id from review_jobs j join durable_interactions i on i.id=j.interaction_id
      where i.run_id=$1 and j.state<>'completed' and j.record->'cleanup'->>'completedAt' is null order by j.id`, [runId])).rows
    for (const { id } of jobs) {
      const row = await rowFor(publication, id), current = parseReviewJob(row.record), context = await contextFor(publication, current)
      const phase = await reviewEntryPhaseLocked(sql, current, row.execution_id)
      const nativeState = phase === 'reserved' || phase === 'not_submitted' ? 'not_started' as const : 'closed' as const
      if (nativeState === 'closed') {
        const execution = HarnessExecutionSchema.parse((await sql.query<{ record: unknown }>(
          'select record from harness_executions where id=$1 for update', [row.execution_id])).rows[0]?.record)
        if (!await readWorkflowClosure(sql, execution)) return fail('REVIEW_NATIVE_SETTLEMENT_PENDING')
      }
      const now = new Date().toISOString()
      const next = parseReviewJob({ ...current, state: 'failed', leaseOwner: undefined, leaseToken: undefined,
        leaseExpiresAt: undefined, retryAfter: undefined, updatedAt: now,
        error: current.error ?? { code: 'REVIEW_RUN_CLEANUP', message: 'Run cleanup ended the unsettled review.' },
        cleanup: { ...current.cleanup,
          nativeState,
          credentialState: credentialsRequired ? 'revoked' : 'not_required',
          interruptState: current.cleanup?.interruptState ?? 'not_sent', completedAt: current.cleanup?.completedAt ?? now } })
      const revision = String(BigInt(row.revision) + 1n)
      const input = { evidence: sourceForReview(next, revision), sourceDigest: graphSourceDigest(next),
        facts: [reviewFact(context, next, revision), ...await approvalAttentionFacts(publication.sql, context, { review: next }),
          ...publicReviewRetirementFacts(next, revision)] }
      const mutate = async () => {
        if (nativeState === 'not_started') await transitionReviewNativeEntryLocked(sql, current, row.execution_id, 'not_submitted', input)
        await assertReviewCleanupProofLocked(sql, next, row.execution_id)
        const result = await sql.query(`update review_jobs set state='failed',record=$2::jsonb,revision=revision+1,updated_at=clock_timestamp()
          where id=$1 and revision=$3::bigint`, [id, JSON.stringify(next), row.revision])
        if (result.rowCount !== 1) return fail('REVISION_CONFLICT')
      }
      if (current.state === 'failed') await publication.source(input, mutate)
      else {
        const effect: GraphEffect = { identity: { kind: 'review.settle', entityId: id }, digest: settlementDigest(next) }
        await publication.effect({ ...input, effect }, { expected: { scope: context.scope, effect: effect.identity, effectDigest: effect.digest,
          ownerId: runId, fence: row.revision, connectionGeneration: null }, readCurrentLocked: async () => {
          const actual = await rowFor(publication, id), subject = parseReviewJob(actual.record)
          const cleanupAllowed = await runCleanupAllowed(sql, runId)
          return { scope: context.scope, effect: { kind: 'review.settle', entityId: subject.id },
            effectDigest: settlementDigest({ ...subject, state: 'failed' }), ownerId: runId, fence: actual.revision,
            connectionGeneration: null, ownership: cleanupAllowed ? 'held' : 'lost', access: 'effect', security: 'valid',
            effectClosed: subject.state === 'completed', submission: 'settled' }
        } }, mutate)
      }
    }
  }
}
