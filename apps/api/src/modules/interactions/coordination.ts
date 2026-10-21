import { renewNativeLane } from './laneRenewal.js'
import { withTransaction, inTransaction } from '../../infrastructure/transaction.js'
import { DeviceHistoryGapSchema, type DeviceHistoryGap } from '@foreman-code/contracts/device-application'
import { DurableInteractionSchema, type DurableInteraction, IdSchema, TimestampSchema, NativeSessionLaneSchema, NativeSessionReferenceSchema, ReviewJobSchema, type NativeHarnessEvent, type NativeSessionReference, type NativeSessionLane, type ReviewJob } from '@foreman-code/contracts'
import type pg from 'pg'

import { interactionConnection } from './connection.js'
import { DomainError } from '../errors.js'
import { appendNativeEvent } from '../runs/nativeEvents.js'
import { assertOrchestratorGraphAuthority } from './graphAuthority.js'
import { pendingReviewCleanup } from './reviewPolicy.js'

// A submitted job may have reached the provider even when no acknowledgement was saved.
const recoverableJob = `(state in ('pending','leased','blocked_busy','blocked_disconnected','submitted','acknowledged','uncertain')
    or (state='failed' and record->'cleanup' is not null and record->'cleanup'->>'completedAt' is null))
  and (record->>'leaseExpiresAt' is null or (record->>'leaseExpiresAt')::timestamptz <= clock_timestamp())
  and (record->>'retryAfter' is null or (record->>'retryAfter')::timestamptz <= clock_timestamp())`

export interface WriterFence { id: string; token: string }
export interface ReviewNativeCapture { readonly executionId: string }
export interface LaneLeaseOwnership { owner: string; connectionGeneration: number }

function leaseInput(id: string, owner: string, token: string, expiresAt: string) {
  const input = {
    id: IdSchema.parse(id), owner: IdSchema.parse(owner), token: IdSchema.parse(token),
    expiresAt: new Date(TimestampSchema.parse(expiresAt)).toISOString(),
  }
  if (Date.parse(input.expiresAt) <= Date.now()) {
    throw new DomainError('LEASE_EXPIRY_INVALID', 'A new lease must expire in the future.', 400)
  }
  return input
}

/** Durable fencing primitives for HAP-05. They do not dispatch or route work. */
export class PostgresInteractionCoordinationRepository {
  constructor(private readonly pool: pg.Pool) {}

  private get queryConnection() { return interactionConnection.getStore() ?? this.pool }

  assertOrchestratorConnection(interaction: DurableInteraction, executionId: string) {
    return assertOrchestratorGraphAuthority(this.queryConnection, interaction, { executionId })
  }

  async assertReviewConnection(job: ReviewJob): Promise<void> {
    const result = await this.queryConnection.query<{ record: unknown; execution_id: string | null }>(
      `select i.record, j.execution_id from review_jobs j
       join durable_interactions i on i.id=j.interaction_id where j.id=$1`, [job.id],
    )
    const row = result.rows[0]
    const interaction = DurableInteractionSchema.safeParse(row?.record)
    if (!row?.execution_id || !interaction.success || interaction.data.id !== job.interactionId
      || interaction.data.approval.designatedOrchestratorAgentId !== job.reviewerAgentId) {
      throw new DomainError('INTERACTION_ACCESS_DENIED', 'The saved review assignment is unavailable.', 403)
    }
    await this.assertOrchestratorConnection(interaction.data, row.execution_id)
  }

  async reviewRunStopped(reviewJobId: string): Promise<boolean> {
    const result = await this.queryConnection.query(
      `select 1 from review_jobs j join harness_executions e on e.id=j.execution_id
       join runs r on r.id=e.run_id where j.id=$1 and (r.execution_state in ('completed','interrupted')
         or exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending))`, [reviewJobId],
    )
    return result.rowCount === 1
  }

  async hasUnsettledReview(executionId: string): Promise<boolean> {
    const result = await this.queryConnection.query(
      `select 1 from review_jobs where execution_id=$1 and state<>'completed'
       and (state<>'failed' or record->'cleanup'->>'completedAt' is null) limit 1`, [executionId],
    )
    return result.rowCount === 1
  }

  /** Called only AFTER Run Stop confirms all native closures and credential cleanup. */
  async finishStoppedReviews(runId: string, credentialsRequired: boolean, client?: pg.ClientBase): Promise<void> {
    await (client ?? this.queryConnection).query(
      `update review_jobs j set state='failed',revision=revision+1,updated_at=clock_timestamp(),
       record=(j.record - 'leaseOwner' - 'leaseToken' - 'leaseExpiresAt' - 'retryAfter') ||
         jsonb_build_object('state','failed','updatedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'error',coalesce(j.record->'error',jsonb_build_object('code','REVIEW_RUN_STOPPED','message','The Run stopped before the native review finished.')),
           'cleanup',coalesce(j.record->'cleanup','{}'::jsonb) || jsonb_build_object(
             'nativeState',case when j.record->'cleanup'->>'nativeState' in ('terminal','closed','not_started')
               then j.record->'cleanup'->>'nativeState' else 'closed' end,
             'credentialState',case when j.record->'cleanup'->>'credentialState' in ('revoked','not_required')
               then j.record->'cleanup'->>'credentialState' when $2 then 'revoked' else 'not_required' end,
             'interruptState',coalesce(j.record->'cleanup'->>'interruptState','not_sent'),
             'completedAt',coalesce(j.record->'cleanup'->>'completedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))))
       from harness_executions e where j.execution_id=e.id and e.run_id=$1
         and j.state<>'completed' and j.record->'cleanup'->>'completedAt' is null`, [runId, credentialsRequired],
    )
  }

  async bindWorkflowSession(executionId: string, session: NativeSessionReference): Promise<void> {
    const result = await this.queryConnection.query(
      `insert into execution_native_sessions(execution_id,reference) values ($1,$2::jsonb)
       on conflict (execution_id) do update set reference=execution_native_sessions.reference
       where execution_native_sessions.reference=excluded.reference returning execution_id`,
      [executionId, JSON.stringify(session)],
    )
    if (!result.rowCount) throw new DomainError('NATIVE_SESSION_IDENTITY_MISMATCH', 'The execution already owns another native session.', 409)
  }

  async finalizeWorkflowSession(executionId: string): Promise<void> {
    await this.queryConnection.query(
      'update execution_native_sessions set workflow_finalized_at=coalesce(workflow_finalized_at,now()) where execution_id=$1', [executionId],
    )
  }

  async workflowSession(executionId: string): Promise<{ session: NativeSessionReference; finalized: boolean; reviewerActive: boolean } | undefined> {
    const result = await this.queryConnection.query<{ reference: unknown; finalized: boolean; reviewer_active: boolean }>(
      `select reference,workflow_finalized_at is not null as finalized,
         exists (select 1 from worker_credential_bindings b where b.execution_id=s.execution_id
           and b.purpose='reviewer' and b.revoked_at is null) as reviewer_active
       from execution_native_sessions s where execution_id=$1`, [executionId],
    )
    const row = result.rows[0]
    return row ? { session: NativeSessionReferenceSchema.parse(row.reference), finalized: row.finalized, reviewerActive: row.reviewer_active } : undefined
  }

  async ensureReviewJob(job: ReviewJob, context?: { executionId: string; workingDirectory: string; providerVersion: string }): Promise<{ job: ReviewJob; created: boolean }> {
    const parsed = ReviewJobSchema.parse(job)
    const inserted = await this.queryConnection.query<{ record: unknown }>(
      `insert into review_jobs (id, interaction_id, reviewer_agent_id, state, record, execution_id, working_directory, provider_version)
       values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
       on conflict (interaction_id, reviewer_agent_id) do nothing returning record`,
      [parsed.id, parsed.interactionId, parsed.reviewerAgentId, parsed.state, JSON.stringify(parsed),
        context?.executionId ?? null, context?.workingDirectory ?? null, context?.providerVersion ?? null],
    )
    if (inserted.rows[0]) return { job: ReviewJobSchema.parse(inserted.rows[0].record), created: true }
    const current = await this.queryConnection.query<{ record: unknown }>(
      'select record from review_jobs where interaction_id=$1 and reviewer_agent_id=$2',
      [parsed.interactionId, parsed.reviewerAgentId],
    )
    const existing = ReviewJobSchema.parse(current.rows[0]?.record)
    if (existing.provider !== parsed.provider || existing.nativeSessionId !== parsed.nativeSessionId) {
      throw new DomainError('REVIEW_JOB_IDENTITY_CONFLICT', 'A review cannot move to a replacement native session.', 409)
    }
    return { job: existing, created: false }
  }

  async findReviewJob(interactionId: string, reviewerAgentId: string): Promise<ReviewJob | undefined> {
    const result = await this.queryConnection.query<{ record: unknown }>(
      'select record from review_jobs where interaction_id=$1 and reviewer_agent_id=$2',
      [interactionId, reviewerAgentId],
    )
    return result.rows[0] ? ReviewJobSchema.parse(result.rows[0].record) : undefined
  }

  async getReviewJobContext(id: string): Promise<{ executionId: string; workingDirectory: string; providerVersion: string }> {
    const result = await this.queryConnection.query<{ execution_id: string | null; working_directory: string | null; provider_version: string | null }>(
      'select execution_id,working_directory,provider_version from review_jobs where id=$1', [id],
    )
    const row = result.rows[0]
    if (!row?.execution_id || !row.working_directory || !row.provider_version) {
      throw new DomainError('REVIEW_JOB_CONTEXT_MISSING', 'The review job has no durable execution ownership context.', 409)
    }
    return { executionId: row.execution_id, workingDirectory: row.working_directory, providerVersion: row.provider_version }
  }

  async appendReviewNativeEvent(job: ReviewJob, event: NativeHarnessEvent,
    _projection?: { writer: WriterFence; live: boolean; terminalReady: boolean; nativeCapture?: ReviewNativeCapture }): Promise<void> {
    void _projection
    const result = await this.queryConnection.query<{ record: unknown; execution_id: string | null }>(
      'select record,execution_id from review_jobs where id=$1', [job.id],
    )
    const row = result.rows[0]
    const current = row ? ReviewJobSchema.parse(row.record) : undefined
    if (!row?.execution_id || !current || current.provider !== job.provider
      || current.nativeSessionId !== job.nativeSessionId || current.correlationId !== job.correlationId
      || current.reviewerAgentId !== job.reviewerAgentId || current.interactionId !== job.interactionId) {
      throw new DomainError('REVIEW_JOB_CONTEXT_MISSING', 'Native review history must match the durable reviewer execution and submission.', 409)
    }
    await appendNativeEvent(this.pool, { ...event, executionId: row.execution_id })
  }

  async appendReviewNativeHistory(job: ReviewJob, events: readonly NativeHarnessEvent[],
    projection?: Parameters<PostgresInteractionCoordinationRepository['appendReviewNativeEvent']>[2]): Promise<void> {
    for (const event of events) await this.appendReviewNativeEvent(job, event, projection)
  }

  async claimReviewJob(id: string, owner: string, token: string, leaseExpiresAt: string): Promise<ReviewJob> {
    const input = leaseInput(id, owner, token, leaseExpiresAt)
    return withTransaction(this.pool, async (client) => {
      const found = await client.query<{ record: unknown }>(
        `select record from review_jobs where id=$1 and
         ${recoverableJob} and $2::timestamptz > clock_timestamp() for update`, [input.id, input.expiresAt],
      )
      const current = found.rows[0] ? ReviewJobSchema.parse(found.rows[0].record) : undefined
      if (!current) throw new DomainError('REVIEW_JOB_NOT_CLAIMABLE', 'The review job is already owned or completed.', 409)
      const next = ReviewJobSchema.parse({
        ...current, state: ['submitted', 'acknowledged', 'uncertain', 'failed'].includes(current.state) ? current.state : 'leased', attempt: current.attempt + 1, leaseOwner: input.owner,
        leaseToken: input.token, leaseExpiresAt: input.expiresAt, retryAfter: undefined,
        updatedAt: new Date().toISOString(), error: current.cleanup ? current.error : undefined,
      })
      await client.query(
        `update review_jobs set state=$3,revision=revision+1,record=$2::jsonb,updated_at=now() where id=$1`,
        [id, JSON.stringify(next), next.state],
      )
      return next
    })
  }

  async nextReviewJob(reviewerAgentId: string): Promise<ReviewJob | undefined> {
    const result = await this.queryConnection.query<{ record: unknown }>(
      `select record from review_jobs where reviewer_agent_id=$1 and
       ${recoverableJob}
       order by updated_at,id limit 1`, [reviewerAgentId],
    )
    return result.rows[0] ? ReviewJobSchema.parse(result.rows[0].record) : undefined
  }

  async reviewJobAgents(): Promise<string[]> {
    const result = await this.queryConnection.query<{ reviewer_agent_id: string }>(
      `select distinct reviewer_agent_id from review_jobs where ${recoverableJob}`,
    )
    return result.rows.map((row) => row.reviewer_agent_id)
  }

  async isReviewPending(interactionId: string, reviewerAgentId: string): Promise<boolean> {
    const result = await this.queryConnection.query(
      `select id from durable_interactions where id=$1 and status='pending'
       and record->'approval'->>'handler'='orchestrator'
       and record->'approval'->>'designatedOrchestratorAgentId'=$2`, [interactionId, reviewerAgentId],
    )
    return result.rowCount === 1
  }

  async reviewDecisionDelivered(interactionId: string, reviewerAgentId: string): Promise<boolean> {
    const result = await this.queryConnection.query(
      `select id from durable_interactions where id=$1 and status='delivered'
       and record->>'deliveryState'='delivered'
       and record->'approval'->>'handler'='orchestrator'
       and record->'approval'->>'designatedOrchestratorAgentId'=$2`, [interactionId, reviewerAgentId],
    )
    return result.rowCount === 1
  }

  async assertReviewJobLease(id: string, token: string): Promise<void> {
    const result = await this.queryConnection.query(
      `select id from review_jobs where id=$1 and record->>'leaseToken'=$2
       and (record->>'leaseExpiresAt')::timestamptz > clock_timestamp()`, [id, token],
    )
    if (!result.rowCount) throw new DomainError('REVIEW_JOB_LEASE_LOST', 'The review job lease expired or changed owners.', 409)
  }

  async renewReviewJob(id: string, token: string, leaseMs: number): Promise<string> {
    const result = await this.queryConnection.query<{ expires_at: string }>(
      `update review_jobs set revision=revision+1, updated_at=clock_timestamp(),
       record=jsonb_set(record, '{leaseExpiresAt}', to_jsonb(to_char(
         (clock_timestamp()+($3 * interval '1 millisecond')) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
       where id=$1 and record->>'leaseToken'=$2
       and (record->>'leaseExpiresAt')::timestamptz > clock_timestamp()
       returning record->>'leaseExpiresAt' as expires_at`, [id, token, leaseMs],
    )
    if (result.rowCount !== 1) throw new DomainError('REVIEW_JOB_LEASE_LOST', 'An expired review lease cannot be renewed.', 409)
    return result.rows[0]!.expires_at
  }

  async transitionReviewJob(id: string, leaseToken: string, state: ReviewJob['state'], fields: {
    providerTurnOrMessageId?: string; error?: ReviewJob['error']; cleanup?: ReviewJob['cleanup']; nativeCapture?: ReviewNativeCapture; writerFence?: WriterFence; releaseLease?: boolean; retryAfter?: string
  } = {}, expected?: { revision: number; fence: number }): Promise<ReviewJob> {
    return withTransaction(this.pool, async (client) => {
      const found = await client.query<{ record: unknown; revision: string; lease_fence: string; lease_active: boolean }>(
        `select record,revision::text,lease_fence::text,
           coalesce(lease_expires_at > clock_timestamp(),false) as lease_active
         from review_jobs where id=$1 for update`, [id],
      )
      const row = found.rows[0]
      const current = row ? ReviewJobSchema.parse(row.record) : undefined
      if (!row?.lease_active || !current || current.leaseToken !== leaseToken
        || (expected && (Number(row.revision) !== expected.revision || Number(row.lease_fence) !== expected.fence))) {
        throw new DomainError('REVIEW_JOB_LEASE_LOST', 'The review job revision or lease is no longer owned.', 409)
      }
      if (current.providerTurnOrMessageId && fields.providerTurnOrMessageId
        && current.providerTurnOrMessageId !== fields.providerTurnOrMessageId) {
        throw new DomainError('REVIEW_JOB_IDENTITY_CONFLICT', 'The review job is already bound to another provider turn or message.', 409)
      }
      // Every terminal failure has a recovery owner. Missing ACKs and failed
      // attachment never constitute native closure evidence.
      if (state === 'failed' && !current.cleanup && !fields.cleanup) {
        fields = { ...fields, cleanup: pendingReviewCleanup() }
      }
      if ((fields.cleanup && state !== 'failed') || (current.cleanup && state !== 'failed')
        || (fields.cleanup?.nativeState === 'not_started'
          && Boolean(current.submittedAt || current.acknowledgedAt || current.providerTurnOrMessageId))
        || (current.cleanup?.credentialPrincipalId && fields.cleanup?.credentialPrincipalId !== undefined
          && current.cleanup.credentialPrincipalId !== fields.cleanup.credentialPrincipalId)
        || (current.cleanup && fields.cleanup && (
          (current.cleanup.nativeState !== 'pending' && current.cleanup.nativeState !== fields.cleanup.nativeState)
          || (current.cleanup.credentialState !== 'pending' && current.cleanup.credentialState !== fields.cleanup.credentialState)
          || (current.cleanup.credentialPrincipalId && !fields.cleanup.credentialPrincipalId)
          || (current.cleanup.interruptState !== 'not_sent' && fields.cleanup.interruptState === 'not_sent')
          || (current.cleanup.interruptState === 'acknowledged' && fields.cleanup.interruptState !== 'acknowledged')
          || (current.cleanup.completedAt && current.cleanup.completedAt !== fields.cleanup.completedAt)))) {
        throw new DomainError('REVIEW_CLEANUP_CONFLICT', 'A failed review cannot restart or lose its cleanup evidence.', 409)
      }
      if (fields.writerFence) {
        const owned = await client.query(
          `select id from native_session_lanes where id=$1 and record->>'leaseToken'=$2
           and (record->>'leaseExpiresAt')::timestamptz > clock_timestamp() for update`,
          [fields.writerFence.id, fields.writerFence.token],
        )
        if (!owned.rowCount) throw new DomainError('SESSION_LANE_LEASE_LOST', 'The native writer is no longer owned.', 409)
      }
      const now = new Date().toISOString()
      const releases = fields.releaseLease ?? ['completed', 'blocked_busy', 'blocked_disconnected', 'uncertain', 'failed'].includes(state)
      const next = ReviewJobSchema.parse({
        ...current, state, updatedAt: now,
        ...(state === 'submitted' ? { submittedAt: current.submittedAt ?? now } : {}),
        ...(state === 'acknowledged' ? { acknowledgedAt: current.acknowledgedAt ?? now } : {}),
        ...(state === 'completed' ? { completedAt: current.completedAt ?? now } : {}),
        ...(fields.providerTurnOrMessageId ? { providerTurnOrMessageId: fields.providerTurnOrMessageId } : {}),
        ...(fields.error && !current.cleanup ? { error: fields.error } : {}),
        ...(fields.cleanup ? { cleanup: fields.cleanup } : {}),
        ...(fields.retryAfter ? { retryAfter: fields.retryAfter } : {}),
        ...(releases ? { leaseOwner: undefined, leaseToken: undefined, leaseExpiresAt: undefined } : {}),
      })
      const updated = await client.query(
        `update review_jobs set state=$2,revision=revision+1,record=$3::jsonb,updated_at=now()
         where id=$1 and revision=$4 and lease_token=$5 and lease_fence=$6
           and lease_expires_at > clock_timestamp()
           and ($7::text is null or exists (
             select 1 from native_session_lanes where id=$7 and record->>'leaseToken'=$8
               and (record->>'leaseExpiresAt')::timestamptz > clock_timestamp()))`,
        [id, state, JSON.stringify(next), row.revision, leaseToken, row.lease_fence, fields.writerFence?.id ?? null, fields.writerFence?.token ?? null],
      )
      if (updated.rowCount !== 1) throw new DomainError('REVIEW_JOB_LEASE_LOST', 'The review job lease expired during its transition.', 409)
      return next
    })
  }

  /** Compatibility entry point for the earlier owner/token/attempt fencing contract. */
  async updateReviewJob(input: {
    id: string; owner: string; token: string; attempt: number
    state: 'submitted' | 'acknowledged' | 'completed' | 'uncertain' | 'failed'
    providerTurnOrMessageId?: string
  }): Promise<ReviewJob> {
    const current = await this.queryConnection.query<{ record: unknown }>(
      'select record from review_jobs where id=$1', [input.id],
    )
    const job = current.rows[0] ? ReviewJobSchema.parse(current.rows[0].record) : undefined
    if (!job || job.leaseOwner !== input.owner || job.leaseToken !== input.token || job.attempt !== input.attempt) {
      throw new DomainError('REVIEW_JOB_LEASE_LOST', 'The review job lease is no longer owned by this worker.', 409)
    }
    return this.transitionReviewJob(input.id, input.token, input.state, {
      ...(input.providerTurnOrMessageId ? { providerTurnOrMessageId: input.providerTurnOrMessageId } : {}),
    })
  }

  async ensureLane(lane: NativeSessionLane): Promise<NativeSessionLane> {
    const parsed = NativeSessionLaneSchema.parse(lane)
    const result = await this.queryConnection.query<{ record: unknown }>(
      `insert into native_session_lanes (id,harness,native_session_id,owner_agent_id,revision,record)
       values ($1,$2,$3,$4,$5,$6::jsonb)
       on conflict (harness,native_session_id) do update set native_session_id=excluded.native_session_id
       returning record`,
      [parsed.id, parsed.harness, parsed.nativeSessionId, parsed.ownerAgentId, parsed.revision, JSON.stringify(parsed)],
    )
    const current = NativeSessionLaneSchema.parse(result.rows[0]?.record)
    if (current.ownerAgentId !== parsed.ownerAgentId) throw new DomainError('SESSION_LANE_OWNER_CONFLICT', 'The native session belongs to another Agent.', 409)
    return current
  }

  async claimLane(id: string, expectedRevision: number, owner: string, token: string, leaseExpiresAt: string, correlationId: string): Promise<NativeSessionLane> {
    const input = leaseInput(id, owner, token, leaseExpiresAt)
    IdSchema.parse(correlationId)
    // Lease ownership precedes idle preflight. bindLaneTurn publishes a new
    // correlation only after that preflight succeeds.
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new DomainError('REVISION_INVALID', 'Expected revision must be a nonnegative integer.', 400)
    const result = await this.queryConnection.query<{ record: unknown }>(
      `update native_session_lanes set revision=revision+1, updated_at=now(),
         record=jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(record,
           '{revision}', to_jsonb((revision+1)::bigint)), '{leaseOwner}', to_jsonb($3::text)),
           '{leaseToken}', to_jsonb($4::text)), '{leaseExpiresAt}', to_jsonb(to_char($5::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),
           '{observedStatus}', '"busy"'::jsonb)
       where id=$1 and revision=$2 and $5::timestamptz > clock_timestamp() and (
         record->>'leaseExpiresAt' is null or (record->>'leaseExpiresAt')::timestamptz <= clock_timestamp())
       returning record`, [input.id, expectedRevision, input.owner, input.token, input.expiresAt],
    )
    if (!result.rows[0]) throw new DomainError('SESSION_LANE_BUSY', 'The native session lane is busy or stale.', 409)
    return NativeSessionLaneSchema.parse(result.rows[0].record)
  }

  async getLane(harness: NativeSessionLane['harness'], nativeSessionId: string): Promise<NativeSessionLane | undefined> {
    const result = await this.queryConnection.query<{ record: unknown }>(
      'select record from native_session_lanes where harness=$1 and native_session_id=$2', [harness, nativeSessionId],
    )
    return result.rows[0] ? NativeSessionLaneSchema.parse(result.rows[0].record) : undefined
  }

  async bindLaneTurn(fence: WriterFence, correlationId: string): Promise<void> {
    // The caller owns the writer lease throughout this read and the mutation.
    // Native idleness cannot erase a failed review's outstanding cleanup duties.
    const cleanup = await this.queryConnection.query(
      `select l.id from native_session_lanes l join review_jobs j
         on j.record->>'provider'=l.harness and j.record->>'nativeSessionId'=l.native_session_id
       where l.id=$1 and j.state='failed' and j.record->'cleanup' is not null
         and j.record->'cleanup'->>'completedAt' is null limit 1`, [fence.id],
    )
    if (cleanup.rowCount) throw new DomainError('SESSION_LANE_BUSY', 'Reviewer cleanup is still unresolved.', 409)
    const result = await this.queryConnection.query(
      `update native_session_lanes set revision=revision+1, updated_at=clock_timestamp(),
       record=jsonb_set(jsonb_set(record - 'currentTurnOrMessageId', '{revision}', to_jsonb((revision+1)::bigint)),
         '{correlationId}', to_jsonb($3::text))
       where id=$1 and record->>'leaseToken'=$2
       and (record->>'leaseExpiresAt')::timestamptz > clock_timestamp()`, [fence.id, fence.token, correlationId],
    )
    if (result.rowCount !== 1) throw new DomainError('SESSION_LANE_LEASE_LOST', 'The native writer is no longer owned.', 409)
  }

  async acknowledgeLaneTurn(fence: WriterFence, correlationId: string, providerId: string): Promise<void> {
    IdSchema.parse(correlationId)
    IdSchema.parse(providerId)
    const result = await this.queryConnection.query(
      `update native_session_lanes set revision=revision+1, updated_at=clock_timestamp(),
       record=jsonb_set(jsonb_set(record, '{revision}', to_jsonb((revision+1)::bigint)),
         '{currentTurnOrMessageId}', to_jsonb($4::text))
       where id=$1 and record->>'leaseToken'=$2
         and (record->>'leaseExpiresAt')::timestamptz > clock_timestamp()
         and record->>'correlationId'=$3
         and (record->>'currentTurnOrMessageId' is null or record->>'currentTurnOrMessageId'=$4)`,
      [fence.id, fence.token, correlationId, providerId],
    )
    if (result.rowCount === 1) return
    await this.assertLaneLease(fence.id, fence.token)
    throw new DomainError('NATIVE_TURN_IDENTITY_CONFLICT', 'The acknowledged turn differs from the owned writer.', 409)
  }

  async recordSkippedEvents(fence: WriterFence, correlationId: string, gap: DeviceHistoryGap): Promise<void> {
    const payload = { ...DeviceHistoryGapSchema.parse(gap), correlationId: IdSchema.parse(correlationId) }
    await this.assertLaneLease(fence.id, fence.token)
    // Observation loss belongs to activity, not the provider's source-sequence namespace.
    // Lock the Run before its activity trigger takes the per-Run advisory lock.
    await this.queryConnection.query(`insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
      select e.run_id,'backend','native_events_skipped',e.id,clock_timestamp(),$4::jsonb
      from native_session_lanes l
      join execution_native_sessions s on s.reference->>'nativeSessionId'=l.native_session_id
        and s.reference->>'harness'=l.harness and s.workflow_finalized_at is null
      join harness_executions e on e.id=s.execution_id
      join runs r on r.id=e.run_id
      where l.id=$1 and l.record->>'leaseToken'=$2 and l.record->>'correlationId'=$3
        and (l.record->>'leaseExpiresAt')::timestamptz > clock_timestamp()
        and not exists(select 1 from run_activity a where a.run_id=e.run_id and a.harness_execution_id=e.id
          and a.kind='native_events_skipped' and a.payload=$4::jsonb)
      for key share of r`,
    [fence.id, fence.token, correlationId, JSON.stringify(payload)])
    await this.assertLaneLease(fence.id, fence.token)
  }

  async assertLaneLease(id: string, token: string, ownership?: LaneLeaseOwnership): Promise<void> {
    const result = await this.queryConnection.query(
      `select id from native_session_lanes where id=$1 and record->>'leaseToken'=$2
       and (record->>'leaseExpiresAt')::timestamptz > clock_timestamp()
       and ($3::text is null or (record->>'leaseOwner'=$3
         and (record->>'connectionGeneration')::bigint=$4))`,
      [id, token, ownership?.owner ?? null, ownership?.connectionGeneration ?? null],
    )
    if (!result.rowCount) throw new DomainError('SESSION_LANE_LEASE_LOST', 'The native writer lease expired or changed owners.', 409)
  }

  async renewLane(id: string, token: string, leaseMs: number, ownership?: LaneLeaseOwnership): Promise<string> {
    return renewNativeLane(this.queryConnection, id, token, leaseMs, ownership)
  }

  async releaseLane(id: string, leaseToken: string, observed: {
    observedStatus: NativeSessionLane['observedStatus']; currentTurnOrMessageId?: string; connectionGeneration?: number
  }): Promise<NativeSessionLane> {
    return inTransaction(this.pool, interactionConnection.getStore(), async (client) => {
      const found = await client.query<{ record: unknown }>(
        `select record from native_session_lanes where id=$1 and record->>'leaseToken'=$2
         and (record->>'leaseExpiresAt')::timestamptz > clock_timestamp() for update`, [id, leaseToken],
      )
      const current = found.rows[0] ? NativeSessionLaneSchema.parse(found.rows[0].record) : undefined
      if (!current || current.leaseToken !== leaseToken) throw new DomainError('SESSION_LANE_LEASE_LOST', 'The native session lane lease is no longer owned.', 409)
      const next = NativeSessionLaneSchema.parse({
        ...current, revision: current.revision + 1, observedStatus: observed.observedStatus,
        observedAt: new Date().toISOString(), connectionGeneration: observed.connectionGeneration ?? current.connectionGeneration,
        ...(observed.currentTurnOrMessageId ? { currentTurnOrMessageId: observed.currentTurnOrMessageId } : { currentTurnOrMessageId: undefined }),
        leaseOwner: undefined, leaseToken: undefined, leaseExpiresAt: undefined,
        // A retained provider turn ID is useful only with the correlation that
        // owns it. Keep the completed pair for the next idle preflight; a lane
        // with no provider identity may become fully unbound.
        correlationId: observed.observedStatus === 'idle' && !observed.currentTurnOrMessageId
          ? undefined : current.correlationId,
      })
      const updated = await client.query(
        `update native_session_lanes set revision=$2,record=$3::jsonb,updated_at=now()
         where id=$1 and record->>'leaseToken'=$4
         and (record->>'leaseExpiresAt')::timestamptz > clock_timestamp()`,
        [id, next.revision, JSON.stringify(next), leaseToken],
      )
      if (updated.rowCount !== 1) throw new DomainError('SESSION_LANE_LEASE_LOST', 'The native writer expired during release.', 409)
      return next
    })
  }
}
