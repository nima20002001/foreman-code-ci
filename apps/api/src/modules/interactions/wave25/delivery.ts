import type { DurableInteraction, NativeHarnessEvent } from '@foreman-code/contracts'
import type pg from 'pg'
import type { GraphEffect } from '@foreman-code/contracts/wave25'
import { PostgresInteractionDeliveryRepository, type GraphResumeClaim } from '../deliveryPostgres.js'
import { observeNativeDispatch } from './dispatchWait.js'
import { INTERACTION_DELIVERY_LEASE_MS, matchingDeliveryEvidence,
  type InteractionDeliveryClaim, type NativeDeliveryOutcome } from '../delivery.js'
import { transact } from './transaction.js'
import { assertBudget, fail, isCurrentApprovalRun, lockInteraction, readContext, runFor, requireLeaseAtCommit } from './context.js'
import { decisionDigest, nextInteraction, publishInteraction } from './publication.js'
import type { GraphTransactionSql } from '../../run-graph/connection.js'
import { claimResume, finishResume, renewResume } from './resume.js'

interface Attempt { attempt: number; state: string; correlation_id: string; lease_owner: string | null;
  leased: boolean; delivery_fence: string; approval_write_started_at: Date | null; approval_connection_generation: string | null }
async function attemptFor(sql: GraphTransactionSql, id: string): Promise<Attempt | undefined> {
  return (await sql.query<Attempt>(`select attempt,state,correlation_id,lease_owner,
    coalesce(lease_expires_at>clock_timestamp(),false) as leased,delivery_fence::text,
    approval_write_started_at,approval_connection_generation::text from interaction_delivery_attempts
    where interaction_id=$1 order by attempt desc limit 1 for update`, [id])).rows[0]
}
async function settled(sql: GraphTransactionSql, interaction: DurableInteraction): Promise<boolean> {
  if (interaction.approval.handler === 'user') return true
  const result = await sql.query(`select 1 from review_jobs where interaction_id=$1 and reviewer_agent_id=$2
    and state='completed' and approval_native_evidence->>'kind'='terminal'
    and approval_native_evidence->'terminal'->>'outcome'='succeeded'
    and approval_native_evidence->'terminal'->>'nativeSettled'='true'`,
  [interaction.id, interaction.approval.designatedOrchestratorAgentId])
  return result.rowCount === 1
}
async function generationFor(sql: GraphTransactionSql, i: DurableInteraction): Promise<string> {
  const row = (await sql.query<{ generation: string }>(`select record->>'connectionGeneration' as generation
    from native_session_lanes where harness=$1 and native_session_id=$2 and owner_agent_id=$3`,
  [i.harness, i.nativeSessionId, i.requestingAgentId])).rows[0]
  if (!row) return fail('APPROVAL_SESSION_LANE_MISSING')
  return row.generation
}
async function ownAttempt(sql: GraphTransactionSql, claim: InteractionDeliveryClaim): Promise<{ current: DurableInteraction; attempt: Attempt; expiresAt: Date }> {
  const current = await lockInteraction(sql, claim.interaction.id), attempt = await attemptFor(sql, current.id)
  const lease = (await sql.query<{ delivery_token: string | null; delivery_fence: string; live: boolean; expires_at: Date }>(
    `select delivery_token,delivery_fence::text,delivery_lease_expires_at as expires_at,coalesce(delivery_lease_expires_at>clock_timestamp(),false) as live
     from durable_interactions where id=$1`, [current.id])).rows[0]
  if (!attempt || !lease?.live || lease.delivery_token !== claim.ownerToken || attempt.lease_owner !== claim.ownerToken
    || !attempt.leased || attempt.attempt !== claim.attempt || attempt.delivery_fence !== lease.delivery_fence
    || claim.deliveryFence !== undefined && claim.deliveryFence !== attempt.delivery_fence
    || claim.approvalConnectionGeneration !== undefined && claim.approvalConnectionGeneration !== attempt.approval_connection_generation
    || current.selectedOptionId !== claim.interaction.selectedOptionId || attempt.correlation_id !== claim.correlationId) return fail('DELIVERY_OWNER_LOST')
  if (claim.mode === 'submit' && attempt.approval_connection_generation !== await generationFor(sql, current)) return fail('GRAPH_STALE_GENERATION')
  return { current, attempt, expiresAt: lease.expires_at }
}
/** Same SQL-only native-write fence used by local dispatch and remote admission. */
export async function assertInteractionNativeDispatchLocked(sql: GraphTransactionSql, claim: InteractionDeliveryClaim): Promise<{ interaction: DurableInteraction; expiresAt: Date }> {
  const { current, attempt, expiresAt } = await ownAttempt(sql, claim)
  requireLeaseAtCommit(sql, expiresAt, 'DELIVERY_OWNER_LOST')
  await readContext(sql, current, true)
  await assertBudget(sql, current)
  if (claim.mode !== 'submit' || !attempt.approval_write_started_at
    || current.status !== 'delivery_pending' || current.deliveryState !== 'submitted'
    || !await settled(sql, current)) return fail('GRAPH_SUBMISSION_NOT_REPLAYABLE')
  return { interaction: current, expiresAt }
}
/** Retries an admitted remote response only after its original Worker proves non-entry:
 * the command is reserved but not entered, or was never reserved at all. */
export async function assertInteractionReservedRetryLocked(sql: GraphTransactionSql,
  claim: InteractionDeliveryClaim): Promise<void> {
  const { current, attempt, expiresAt } = await ownAttempt(sql, claim)
  requireLeaseAtCommit(sql, expiresAt, 'DELIVERY_OWNER_LOST')
  await readContext(sql, current, true)
  await assertBudget(sql, current)
  if (!attempt.approval_write_started_at || current.status !== 'delivery_pending'
    || !['submitted', 'uncertain'].includes(current.deliveryState) || !await settled(sql, current)) {
    return fail('GRAPH_SUBMISSION_NOT_REPLAYABLE')
  }
}
export class Wave25InteractionDeliveryRepository extends PostgresInteractionDeliveryRepository {
  constructor(private readonly approvalPool: pg.Pool) { super(approvalPool) }
  private async mode(id: string) { const runId = await runFor(this.approvalPool, 'interaction', id)
    return { runId, enabled: await isCurrentApprovalRun(this.approvalPool, runId) } }

  override async claim(id: string, ownerToken: string, reconcileOnly = false): Promise<InteractionDeliveryClaim | undefined> {
    const mode = await this.mode(id)

    return transact(this.approvalPool, mode.runId, async (publication) => {
      const sql = publication.sql, current = await lockInteraction(sql, id)
      if (!current.selectedOptionId || !['decided','delivery_pending','delivery_failed'].includes(current.status)) return undefined
      const context = await readContext(sql, current)
      const owned = await sql.query('select 1 from durable_interactions where id=$1 and delivery_lease_expires_at>clock_timestamp()', [id])
      if (owned.rowCount) return undefined
      const prior = await attemptFor(sql, id)
      if (prior?.leased) return undefined
      const reconcile = !!prior?.approval_write_started_at || ['submitted','uncertain'].includes(current.deliveryState)
        || !!prior && prior.approval_connection_generation === null
      if (!await settled(sql, current) || context.stopped && !prior?.approval_write_started_at) return undefined
      // A terminal execution cannot authorize a new native write. It may still
      // reconcile the exact already-started attempt from immutable evidence.
      if (!reconcile) await assertBudget(sql, current)
      if (reconcileOnly && !reconcile) return undefined
      const attempt = prior && reconcile ? prior.attempt : (prior?.attempt ?? 0) + 1
      const correlationId = prior && reconcile ? prior.correlation_id : `approval-${ownerToken}`
      const generation = await generationFor(sql, current)
      const fence = (await sql.query<{ delivery_fence: string }>(`update durable_interactions
        set delivery_owner=$2,delivery_token=$2,delivery_fence=delivery_fence+1,
          delivery_lease_expires_at=clock_timestamp()+($3::integer*interval '1 millisecond') where id=$1 returning delivery_fence::text`,
      [id, ownerToken, INTERACTION_DELIVERY_LEASE_MS])).rows[0]!.delivery_fence
      if (prior && reconcile) await sql.query(`update interaction_delivery_attempts set state='uncertain',lease_owner=$3,
        delivery_fence=$4::bigint,approval_connection_generation=coalesce(approval_connection_generation,$5::bigint),
        lease_expires_at=clock_timestamp()+($6::integer*interval '1 millisecond') where interaction_id=$1 and attempt=$2`,
      [id, attempt, ownerToken, fence, generation, INTERACTION_DELIVERY_LEASE_MS])
      else await sql.query(`insert into interaction_delivery_attempts(interaction_id,attempt,state,native_session_id,native_request_id,
        correlation_id,lease_owner,lease_expires_at,delivery_fence,approval_connection_generation)
        values($1,$2,'submitted',$3,$4,$5,$6,clock_timestamp()+($7::integer*interval '1 millisecond'),$8::bigint,$9::bigint)`,
      [id, attempt, current.nativeSessionId, current.nativeRequestId, correlationId, ownerToken, INTERACTION_DELIVERY_LEASE_MS, fence, generation])
      // No public revision or progress is created by acquiring a lease.
      return { interaction: current, attempt, ownerToken, correlationId, mode: reconcile ? 'reconcile' : 'submit',
        deliveryFence: fence, approvalConnectionGeneration: prior && reconcile ? prior.approval_connection_generation ?? generation : generation }
    })
  }

  /** Read only the exact approval attempt, correlation and retained provider
   * events. A later connection generation cannot be promoted into its receipt. */
  async persistedResponseEvidence(interaction: DurableInteraction) {
    if (interaction.harness !== 'codex') return undefined
    const request = interaction.request as Record<string, unknown>
    if (typeof request.itemId !== 'string' || typeof request.turnId !== 'string') return undefined
    const rows = await this.approvalPool.query<{ source_sequence: number; connection_id: string; record: Record<string, unknown> }>(
      `select e.source_sequence,e.connection_id,e.record
       from run_native_correlations c
       join interaction_delivery_attempts a on a.interaction_id=$7
         and a.approval_connection_generation=c.connection_generation and a.approval_write_started_at is not null
       join harness_native_events e on e.execution_id=c.execution_id and e.connection_id=c.connection_id
       where c.run_id=$1 and c.execution_id=$2 and c.work_kind='workflow' and c.work_id=$2
         and c.correlation_key=$3 and c.provider='codex' and c.native_session_id=$4
         and c.native_turn_id=$5 and c.native_request_id=$6 and c.interaction_id=$7
         and ((e.record->>'type' in ('interaction.pending','interaction.submitting','interaction.submitted','interaction.resolved')
               and e.record->'payload'->>'nativeRequestId'=$6)
           or (e.record->>'type'='item.completed' and e.record->'payload'->'item'->>'id'=$8))
       order by e.source_sequence limit 32`,
      [interaction.runId, interaction.executionId, `approval:${interaction.id}`, interaction.nativeSessionId,
        request.turnId, interaction.nativeRequestId, interaction.id, request.itemId],
    )
    const events: NativeHarnessEvent[] = rows.rows.flatMap((row) => {
      const type = row.record.type, occurredAt = row.record.occurredAt, payload = row.record.payload
      return typeof type === 'string' && typeof occurredAt === 'string' && payload !== null
        && typeof payload === 'object' && !Array.isArray(payload)
        ? [{ sequence: row.source_sequence, connectionId: row.connection_id, type, occurredAt,
            payload: payload as Record<string, unknown> }] : []
    })
    return matchingDeliveryEvidence(interaction, {
      harness: interaction.harness, providerVersion: interaction.providerVersion,
      nativeSessionId: interaction.nativeSessionId,
    }, { events, pendingInteractions: [] })
  }
  private async prepare(claim: InteractionDeliveryClaim): Promise<void> {
    await transact(this.approvalPool, claim.interaction.runId, async (publication) => {
      const { current, attempt, expiresAt } = await ownAttempt(publication.sql, claim)
      requireLeaseAtCommit(publication.sql, expiresAt, 'DELIVERY_OWNER_LOST')
      const context = await readContext(publication.sql, current, true)
      await assertBudget(publication.sql, current)
      if (claim.mode !== 'submit' || attempt.approval_write_started_at || !['pending', 'failed'].includes(current.deliveryState)
        || !await settled(publication.sql, current)) return fail('GRAPH_SUBMISSION_NOT_REPLAYABLE')
      const effect: GraphEffect = { identity: { kind: 'approval.deliver', entityId: current.id }, digest: decisionDigest(current) }
      const next = nextInteraction(current, { status: 'delivery_pending', deliveryState: 'submitted' })
      await publishInteraction(publication, context, current, next, { effect, guard: {
        expected: { scope: context.scope, effect: effect.identity, effectDigest: effect.digest,
          ownerId: claim.ownerToken, fence: attempt.delivery_fence, connectionGeneration: attempt.approval_connection_generation },
        readCurrentLocked: async (sql) => {
          const actual = await ownAttempt(sql, claim), authority = await readContext(sql, actual.current, true)
          await assertBudget(sql, actual.current)
          if (!await settled(sql, actual.current)) return fail('REVIEW_NOT_SETTLED')
          return { scope: authority.scope, effect: { kind: 'approval.deliver', entityId: actual.current.id },
            effectDigest: decisionDigest(actual.current), ownerId: actual.attempt.lease_owner!, fence: actual.attempt.delivery_fence,
            connectionGeneration: await generationFor(sql, actual.current), ownership: 'held', access: 'effect', security: 'valid',
            effectClosed: actual.current.status === 'canceled' || actual.current.deliveryState === 'delivered',
            submission: actual.attempt.approval_write_started_at ? 'uncertain' : 'not_submitted' }
        },
      }, mutate: async (sql) => {
        const changed = await sql.query(`update interaction_delivery_attempts set approval_write_started_at=clock_timestamp()
          where interaction_id=$1 and attempt=$2 and lease_owner=$3 and approval_write_started_at is null`,
        [current.id, claim.attempt, claim.ownerToken])
        if (changed.rowCount !== 1) return fail('GRAPH_SUBMISSION_NOT_REPLAYABLE')
      } })
    })
  }

  /** SQL-only dispatch check. The publication connection is released before
   * filesystem/provider work. Recheck after asynchronous preflight as well as
   * before entering the callback; a claimed attempt is never a replay permit. */
  async assertNativeDispatch(claim: InteractionDeliveryClaim): Promise<{ interaction: DurableInteraction; expiresAt: Date }> {
    return transact(this.approvalPool, claim.interaction.runId, async (publication) => {
      return assertInteractionNativeDispatchLocked(publication.sql, claim)
    })
  }

  /** Intent was committed by prepare(). Native session ownership and cancellation
   * remain with the existing SingleWriterSessionManager, not a held Run row lock.
   * Stop may now commit while I/O is in flight. The finish transaction rechecks
   * the delivery owner/generation; a lost or timed-out attempt is reconciliation-only. */
  private async nativeWrite(claim: InteractionDeliveryClaim,
    action: (interaction: DurableInteraction, signal: AbortSignal) => Promise<NativeDeliveryOutcome>,
    signal?: AbortSignal): Promise<NativeDeliveryOutcome> {
    const { interaction, expiresAt } = await this.assertNativeDispatch(claim)
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(INTERACTION_DELIVERY_LEASE_MS, expiresAt.getTime() - Date.now())))
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    return observeNativeDispatch(() => action(interaction, combined), combined)
  }

  override async finish(claim: InteractionDeliveryClaim,
    outcome: NativeDeliveryOutcome | ((interaction: DurableInteraction, signal: AbortSignal) => Promise<NativeDeliveryOutcome>),
    signal?: AbortSignal): Promise<DurableInteraction> {

    let result: NativeDeliveryOutcome
    if (typeof outcome === 'function') { await this.prepare(claim); result = await this.nativeWrite(claim, outcome, signal) }
    else result = outcome
    return transact(this.approvalPool, claim.interaction.runId, async (publication) => {
      const sql = publication.sql, { current, attempt, expiresAt } = await ownAttempt(sql, claim)
      requireLeaseAtCommit(sql, expiresAt, 'DELIVERY_OWNER_LOST')
      const context = await readContext(sql, current)
      const proof = result.state === 'delivered' && matchingDeliveryEvidence(current,
        { harness: current.harness, providerVersion: current.providerVersion, nativeSessionId: current.nativeSessionId },
        { events: [], pendingInteractions: [], responseDeliveries: result.evidence ? [result.evidence] : [] })
      // Neither a void respond() return nor a connection close is a delivery receipt.
      const state = result.state === 'delivered' && !proof || result.state === 'failed' && !!attempt.approval_write_started_at
        ? 'uncertain' : result.state
      const canceled = current.status === 'canceled'
      const next = nextInteraction(current, { status: canceled ? 'canceled' : state === 'delivered' ? 'delivered'
        : state === 'failed' ? 'delivery_failed' : 'delivery_pending',
      deliveryState: canceled && state !== 'delivered' ? 'failed' : state,
      ...(state === 'delivered' ? { deliveredAt: new Date().toISOString() } : {}) })
      await publishInteraction(publication, context, current, next, { mutate: async (transaction) => {
        await transaction.query(`update interaction_delivery_attempts set state=$4,evidence=$5::jsonb,error=$6,
          lease_expires_at=null where interaction_id=$1 and attempt=$2 and lease_owner=$3`,
        [current.id, claim.attempt, claim.ownerToken, state, JSON.stringify(result.evidence ?? null),
          state === 'uncertain' ? 'APPROVAL_NATIVE_DELIVERY_UNCERTAIN' : result.error ? 'APPROVAL_NATIVE_DELIVERY_FAILED' : null])
        await transaction.query(`update durable_interactions set delivery_owner=null,delivery_token=null,delivery_lease_expires_at=null
          where id=$1 and delivery_token=$2`, [current.id, claim.ownerToken])
        if (state === 'delivered' && !canceled && !context.stopped) await enqueueResume(transaction, next)
      } })
      return next
    })
  }

  async claimAtomicGraphResume(id: string, ownerToken: string): Promise<GraphResumeClaim | undefined> {
    const mode = await this.mode(id)

    return claimResume(this.approvalPool, mode.runId, id, ownerToken, true)
  }
  override async claimGraphResume(id: string, ownerToken: string): Promise<GraphResumeClaim | undefined> {
    const mode = await this.mode(id)
    return mode.enabled ? claimResume(this.approvalPool, mode.runId, id, ownerToken) : super.claimGraphResume(id, ownerToken)
  }
  override async renewGraphResume(claim: GraphResumeClaim): Promise<void> {

    return renewResume(this.approvalPool, claim)
  }
  override async finishGraphResume(claim: GraphResumeClaim, error?: string): Promise<void> {

    return finishResume(this.approvalPool, claim, error)
  }
}
export async function enqueueResume(sql: GraphTransactionSql, interaction: DurableInteraction): Promise<void> {
  await sql.query(`insert into interaction_graph_resumes(interaction_id,run_id,execution_id,graph_thread_id,graph_interrupt_id,delivery_revision,state)
    values($1,$2,$3,$4,$5,$6,'pending') on conflict(interaction_id) do nothing`,
  [interaction.id, interaction.runId, interaction.executionId, interaction.graphThreadId, interaction.graphInterruptId ?? null, interaction.revision])
}
