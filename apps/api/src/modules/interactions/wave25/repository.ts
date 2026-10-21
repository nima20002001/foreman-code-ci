import type { ReviewNativeProofServices } from '../reviewNativeProof.js'
import type { DurableInteraction } from '@foreman-code/contracts'
import type pg from 'pg'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { PostgresInteractionRepository } from '../postgres.js'
import { Wave25InteractionCoordinationRepository } from './reviews.js'
import { Wave25InteractionDeliveryRepository } from './delivery.js'
import { decide } from './decisions.js'
import { transact } from './transaction.js'
import { fail, isCurrentApprovalRun, lockInteraction, readContext, runFor } from './context.js'
import { CANCELED_INTERACTION_RETIRED_SQL, nextInteraction, publishInteraction, retireCanceledInteraction, retireCanceledInteractionsAfterCleanup } from './publication.js'
import type { RunGraphPublication } from '../../run-graph/publication.js'
import { runCleanupAllowed } from './cleanupAuthority.js'
import { WorkDirectionRepository } from '../workDirection.js'

/** Current approval repository: every product mutation joins canonical G1.
 * The base provides shared bounded reads and native lane primitives only. */
export class Wave25InteractionRepository extends PostgresInteractionRepository {
  override readonly delivery: Wave25InteractionDeliveryRepository
  override readonly coordination: Wave25InteractionCoordinationRepository
  readonly directions: WorkDirectionRepository
  constructor(private readonly approvalPool: pg.Pool, nativeProofs?: ReviewNativeProofServices) {
    super(approvalPool)
    this.delivery = new Wave25InteractionDeliveryRepository(approvalPool)
    this.coordination = new RetiringInteractionCoordinationRepository(approvalPool, nativeProofs)
    this.directions = new WorkDirectionRepository(approvalPool)
  }
  usesAtomicApproval(runId: string): Promise<boolean> { return isCurrentApprovalRun(this.approvalPool, runId) }
  private async mode(id: string) { const runId = await runFor(this.approvalPool, 'interaction', id)
    return { runId, enabled: await isCurrentApprovalRun(this.approvalPool, runId) } }
  override async create(input: DurableInteraction): Promise<{ interaction: DurableInteraction; created: boolean }> {
    void input
    return fail('APPROVAL_ORIGINAL_SOURCE_REQUIRED',
      'Native requests are created atomically by the owned original-source writer, not by caller JSON.')
  }
  override async decide(input: Parameters<PostgresInteractionRepository['decide']>[0]) {
    const mode = await this.mode(input.id)

    if (!input.principal) return fail('INTERACTION_ACCESS_DENIED')
    if (input.beforeCommit) return fail('APPROVAL_RAW_AUDIT_CALLBACK_REJECTED',
      'The V3 repository records its audit on the G1 transaction; a raw-client callback cannot join that transaction.')
    return decide(this.approvalPool, mode.runId, { id: input.id, optionId: input.optionId, expectedRevision: input.expectedRevision,
      nativeResponse: input.nativeResponse, principal: input.principal,
      ...(input.source ? { source: input.source } : {}),
      ...(input.signal ? { signal: input.signal } : {}) })
  }
  override async bindGraphInterrupt(id: string, graphInterruptId: string): Promise<DurableInteraction> {
    const mode = await this.mode(id)

    return transact(this.approvalPool, mode.runId, async (publication) => {
      const current = await lockInteraction(publication.sql, id)
      if (current.graphInterruptId) {
        if (current.graphInterruptId !== graphInterruptId) return fail('INTERACTION_INTERRUPT_CONFLICT')
        return current
      }
      const next = nextInteraction(current, { graphInterruptId }), context = await readContext(publication.sql, current)
      await publishInteraction(publication, context, current, next, { mutate: async (sql) => {
        await sql.query(`update interaction_graph_resumes set graph_interrupt_id=$2,revision=revision+1,updated_at=clock_timestamp()
          where interaction_id=$1 and graph_interrupt_id is null`, [id, graphInterruptId])
      } })
      return next
    })
  }
  override async cancelPendingForExecution(executionId: string, nativeRequestIds?: readonly string[]): Promise<void> {
    const runId = await runFor(this.approvalPool, 'execution', executionId)

    await transact(this.approvalPool, runId, async (publication) => {
      if (!nativeRequestIds && !(await publication.sql.query(
        "select 1 from harness_executions where id=$1 and record->>'state'='completed'", [executionId])).rowCount) return fail('APPROVAL_TERMINAL_EVIDENCE_REQUIRED')
      const ids = (await publication.sql.query<{ id: string }>(`select i.id from durable_interactions i where i.execution_id=$1
        and (i.status='pending' or i.status='canceled' and not (${CANCELED_INTERACTION_RETIRED_SQL}))
        and ($2::text[] is null or i.native_request_id=any($2)) order by i.id`, [executionId, nativeRequestIds ?? null])).rows
      for (const { id } of ids) {
        const current = await lockInteraction(publication.sql, id), context = await readContext(publication.sql, current)
        if (current.status === 'canceled') await retireCanceledInteraction(publication, context, current)
        else await publishInteraction(publication, context, current, nextInteraction(current, { status: 'canceled' }))
      }
    })
  }
  override async cancelPendingForRun(runId: string): Promise<number> {

    return transact(this.approvalPool, runId, async (publication) => {
      const sql = publication.sql
      if (!await runCleanupAllowed(sql, runId)) return fail('EXECUTION_NOT_STOPPED')
      // A committed graph.resume consumes the checkpoint; it is not Worker
      // acknowledgement. Stop must still cancel that exposed obligation. The
      // existing mutation below preserves resumed outboxes and delivery evidence,
      // and retirement remains gated by confirmed native/resource cleanup.
      const rows = (await sql.query<{ id: string }>(`select i.id from durable_interactions i
        left join interaction_graph_resumes g on g.interaction_id=i.id where i.run_id=$1
        and (i.status<>'canceled' or not (${CANCELED_INTERACTION_RETIRED_SQL}))
        and not (i.status='delivered' and (g.approval_native_ack_id is not null
          or i.record->>'kind' is not distinct from 'work_direction')) order by i.id`, [runId])).rows
      let canceled = 0
      for (const { id } of rows) {
        const current = await lockInteraction(sql, id), context = await readContext(sql, current)
        if (current.status === 'canceled') {
          await retireCanceledInteraction(publication, context, current)
          continue
        }
        canceled += 1
        // Cancellation never proves a submitted/uncertain response failed.
        const next = nextInteraction(current, { status: 'canceled', deliveryState: current.deliveryState === 'not_started' ? 'not_started'
          : current.deliveryState === 'delivered' ? 'delivered'
            : current.deliveryState === 'submitted' || current.deliveryState === 'uncertain' ? 'uncertain' : 'failed' })
        await publishInteraction(publication, context, current, next, { resumeState: 'unknown', mutate: async (transaction) => {
          // The private attempt keeps the same uncertainty as the public record.
          await transaction.query(`update interaction_delivery_attempts set state=case when state='submitted' then 'uncertain' else state end,
            lease_expires_at=null where interaction_id=$1`, [id])
          await transaction.query(`update interaction_graph_resumes set state='canceled',lease_owner=null,lease_token=null,lease_expires_at=null,
            revision=revision+1,updated_at=clock_timestamp() where interaction_id=$1 and state<>'resumed'`, [id])
          await transaction.query(`update durable_interactions set delivery_fence=delivery_fence+1,delivery_owner=null,
            delivery_token=null,delivery_lease_expires_at=null where id=$1`, [id])
        } })
      }
      return canceled
    })
  }
  override async recordReconciliation(...args: Parameters<PostgresInteractionRepository['recordReconciliation']>) {
    const [id, expectedRevision, evidence, lease] = args, mode = await this.mode(id)

    canonicalGraphJson(evidence, 32768)
    return transact(this.approvalPool, mode.runId, async (publication) => {
      const sql = publication.sql, current = await lockInteraction(sql, id)
      if (current.revision !== expectedRevision) return fail('REVISION_CONFLICT')
      if (!lease || !(await sql.query(`select 1 from durable_interactions where id=$1 and delivery_owner=$2
        and delivery_token=$3 and delivery_fence=$4 and delivery_lease_expires_at>clock_timestamp()`,
      [id, lease.owner, lease.token, lease.fence])).rowCount) return fail('DELIVERY_LEASE_LOST')
      if (current.nativeSessionId !== evidence.nativeSessionId || current.nativeRequestId !== evidence.nativeRequestId) return fail('INTERACTION_IDENTITY_CONFLICT')
      if (current.deliveryState === 'delivered' || current.status === 'canceled') return current
      if (evidence.attempt !== undefined && !(await sql.query(`select 1 from interaction_delivery_attempts where interaction_id=$1 and attempt=$2
        and ($3::text is null or correlation_id=$3)`, [id, evidence.attempt, evidence.correlationId ?? null])).rowCount) return fail('DELIVERY_ATTEMPT_STALE')
      const context = await readContext(sql, current), next = nextInteraction(current, {})
      await publishInteraction(publication, context, current, next, { mutate: async (transaction) => {
        await transaction.query(`insert into interaction_reconciliation_evidence
          (interaction_id,attempt,delivery_fence,native_session_id,native_request_id,correlation_id,outcome,evidence,error)
          values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`, [id, evidence.attempt ?? null, lease.fence,
          current.nativeSessionId, current.nativeRequestId, evidence.correlationId ?? null, evidence.outcome,
          JSON.stringify({ source: evidence.source, harness: current.harness, providerVersion: current.providerVersion, details: evidence.details }),
          JSON.stringify(evidence.error ?? null)])
      } })
      // An observation is not delivery or permission to replay a native action.
      return next
    })
  }
  override async updateDelivery(...args: Parameters<PostgresInteractionRepository['updateDelivery']>) {
    void args
    return fail('APPROVAL_QUALIFIED_DELIVERY_REQUIRED')
  }
  override async reconcileDelivery(...args: Parameters<PostgresInteractionRepository['reconcileDelivery']>) {
    void args
    return fail('APPROVAL_QUALIFIED_DELIVERY_REQUIRED')
  }
  override async beginDeliveryAttempt(...args: Parameters<PostgresInteractionRepository['beginDeliveryAttempt']>) {
    void args
    return fail('APPROVAL_QUALIFIED_DELIVERY_REQUIRED')
  }
  override async finishDeliveryAttempt(...args: Parameters<PostgresInteractionRepository['finishDeliveryAttempt']>) {
    void args
    return fail('APPROVAL_QUALIFIED_DELIVERY_REQUIRED')
  }
  override async settleDeliveryAttempt(...args: Parameters<PostgresInteractionRepository['settleDeliveryAttempt']>) {
    void args
    return fail('APPROVAL_QUALIFIED_DELIVERY_REQUIRED')
  }
}

/** Keep the existing coordinator's native-closure/credential checks and virtual
 * dispatch. Both its own transaction and caller-owned publications reach this
 * hook; interaction retirement joins the SAME final review-cleanup batch. */
class RetiringInteractionCoordinationRepository extends Wave25InteractionCoordinationRepository {
  override async finishStoppedReviewsInPublication(publication: RunGraphPublication, credentialsRequired: boolean): Promise<void> {
    // Preserve the interaction-before-review child lock order in this shared
    // publication; the later retirement helper only re-reads these same locks.
    await publication.sql.query("select id from durable_interactions where run_id=$1 and status='canceled' order by id for update", [publication.scope.runId])
    await super.finishStoppedReviewsInPublication(publication, credentialsRequired)
    await retireCanceledInteractionsAfterCleanup(publication)
  }
}
