import { DurableInteractionSchema, type DurableInteraction } from '@foreman-code/contracts'
import { beginTransaction, commitTransaction, rollbackAfterFailure } from '../../infrastructure/transaction.js'
import type pg from 'pg'

import { interactionConnection } from './connection.js'
import { DomainError } from '../errors.js'
import { RUN_CLEANUP_BOUNDARY_SQL } from './wave25/cleanupAuthority.js'
import {
  INTERACTION_DELIVERY_LEASE_MS,
  matchingDeliveryEvidence,
  type InteractionDeliveryClaim,
  type NativeDeliveryOutcome,
} from './delivery.js'

interface AttemptRow {
  attempt: number
  state: NativeDeliveryOutcome['state'] | 'submitted'
  correlation_id: string
  lease_owner: string | null
  leased: boolean
}

export interface GraphResumeClaim {
  interaction: DurableInteraction
  ownerToken: string
  /** Stops the claimant's renewal; the Run owner calls it before its transaction locks the claim. */
  release?(): Promise<void>
}

/** Owns delivery fencing and its transactional graph-resume outbox, not decisions. */
export class PostgresInteractionDeliveryRepository {
  constructor(private readonly pool: pg.Pool) {}

  private async transaction<T>(action: (client: pg.PoolClient, signal: AbortSignal) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    const controller = new AbortController()
    const lost = () => controller.abort(new DomainError('DELIVERY_OWNER_LOST', 'The delivery database owner disconnected.', 409))
    client.on('error', lost)
    client.on('end', lost)
    try {
      await beginTransaction(client)
      const result = await action(client, controller.signal)
      controller.signal.throwIfAborted()
      await commitTransaction(client)
      return result
    } catch (error) {
      if (await rollbackAfterFailure(client)) lost()
      throw error
    } finally {
      client.removeListener('error', lost)
      client.removeListener('end', lost)
      client.release(controller.signal.aborted)
    }
  }

  private async locked(client: pg.PoolClient, id: string, skipLocked = false): Promise<DurableInteraction | undefined> {
    const found = await client.query<{ record: unknown }>(
      `select record from durable_interactions where id=$1 for update${skipLocked ? ' skip locked' : ''}`, [id],
    )
    return found.rows[0] ? DurableInteractionSchema.parse(found.rows[0].record) : undefined
  }

  private async write(client: pg.PoolClient, current: DurableInteraction, state: DurableInteraction['deliveryState']): Promise<DurableInteraction> {
    const now = new Date().toISOString()
    const next = DurableInteractionSchema.parse({
      ...current, revision: current.revision + 1, deliveryState: state,
      status: state === 'delivered' ? 'delivered' : state === 'failed' ? 'delivery_failed' : 'delivery_pending',
      ...(state === 'delivered' ? { deliveredAt: now } : {}), updatedAt: now,
    })
    await client.query(
      'update durable_interactions set status=$2,revision=$3,record=$4::jsonb,updated_at=now() where id=$1',
      [next.id, next.status, next.revision, JSON.stringify(next)],
    )
    if (state === 'delivered') await this.enqueueGraphResume(client, next.id)
    return next
  }

  async enqueueGraphResume(client: pg.PoolClient, id: string): Promise<void> {
    await client.query(
      `insert into interaction_graph_resumes
         (interaction_id,run_id,execution_id,graph_thread_id,graph_interrupt_id,delivery_revision,state)
       select id,run_id,execution_id,record->>'graphThreadId',record->>'graphInterruptId',revision,'pending'
       from durable_interactions where id=$1 on conflict (interaction_id) do nothing`, [id],
    )
  }

  /** No connection is retained while attaching a provider; the durable lease owns that work. */
  async claim(id: string, ownerToken: string, reconcileOnly = false): Promise<InteractionDeliveryClaim | undefined> {
    return this.transaction(async (client) => {
      const current = await this.locked(client, id, true)
      if (!current || !current.selectedOptionId || !['delivery_pending', 'delivery_failed', 'decided'].includes(current.status)) return undefined
      const lease = await client.query<{ active: boolean }>(
        'select coalesce(delivery_lease_expires_at > clock_timestamp(),false) as active from durable_interactions where id=$1', [id],
      )
      if (lease.rows[0]?.active) return undefined
      const budget = await client.query<{ stopped_at: Date | null }>(
        'select stopped_at from approval_execution_state where execution_id=$1', [current.executionId],
      )
      if (!budget.rows[0] || budget.rows[0].stopped_at) return undefined
      const found = await client.query<AttemptRow>(
        `select attempt,state,correlation_id,lease_owner,
           coalesce(lease_expires_at > clock_timestamp(),false) as leased
         from interaction_delivery_attempts where interaction_id=$1 order by attempt desc limit 1`, [id],
      )
      const previous = found.rows[0]
      if (previous?.leased) return undefined
      // Recover the old split-write crash window without losing a durable receipt.
      if (previous?.state === 'delivered') {
        await this.write(client, current, 'delivered')
        return undefined
      }
      // A lost owner is never permission to resend. Old unfenced failure records
      // also lack trustworthy provenance and must be reconciled, not replayed.
      const mode = previous?.state === 'submitted' || previous?.state === 'uncertain'
        || current.deliveryState === 'submitted' || current.deliveryState === 'uncertain'
        || (current.deliveryState === 'failed' && !previous?.lease_owner) ? 'reconcile' : 'submit'
      if (reconcileOnly && mode !== 'reconcile') return undefined
      const state = mode === 'reconcile' ? 'uncertain' : 'submitted'
      const correlationId = previous && mode === 'reconcile' ? previous.correlation_id : `approval-${ownerToken}`
      const attempt = previous && mode === 'reconcile' ? previous.attempt : (previous?.attempt ?? 0) + 1
      if (previous && mode === 'reconcile') {
        await client.query(
          `update interaction_delivery_attempts set state='uncertain',lease_owner=$3,
             lease_expires_at=clock_timestamp()+($4::integer * interval '1 millisecond')
           where interaction_id=$1 and attempt=$2`, [id, attempt, ownerToken, INTERACTION_DELIVERY_LEASE_MS],
        )
      } else {
        await client.query(
          `insert into interaction_delivery_attempts
           (interaction_id,attempt,state,native_session_id,native_request_id,correlation_id,lease_owner,lease_expires_at)
           values ($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+($8::integer * interval '1 millisecond'))`,
          [id, attempt, state, current.nativeSessionId, current.nativeRequestId, correlationId, ownerToken, INTERACTION_DELIVERY_LEASE_MS],
        )
      }
      await client.query(
        `update durable_interactions set delivery_owner=$2,delivery_token=$2,delivery_fence=delivery_fence+1,
           delivery_lease_expires_at=clock_timestamp()+($3::integer * interval '1 millisecond') where id=$1`,
        [id, ownerToken, INTERACTION_DELIVERY_LEASE_MS],
      )
      const interaction = await this.write(client, current, state)
      return { interaction, attempt, ownerToken, correlationId, mode }
    })
  }

  /**
   * The execution row is the Stop linearization point. Stop's UPDATE cannot
   * complete while a native write is in progress; a Stop that wins first blocks
   * the write. The attempt + interaction + resume intent commit together.
   */
  async finish(
    claim: InteractionDeliveryClaim,
    outcome: NativeDeliveryOutcome | ((interaction: DurableInteraction, signal: AbortSignal) => Promise<NativeDeliveryOutcome>),
    signal?: AbortSignal,
  ): Promise<DurableInteraction> {
    return this.transaction(async (client, ownerSignal) => {
      const combined = signal ? AbortSignal.any([signal, ownerSignal]) : ownerSignal
      const writing = typeof outcome === 'function'
      if (writing) {
        const budget = await client.query<{ stopped_at: Date | null; exhausted: boolean }>(
          `select stopped_at, active_elapsed_ms +
             coalesce(extract(epoch from (clock_timestamp()-active_started_at))*1000,0) >= active_timeout_ms as exhausted
           from approval_execution_state where execution_id=$1 for update`, [claim.interaction.executionId],
        )
        if (!budget.rows[0] || budget.rows[0].stopped_at) throw new DomainError('EXECUTION_STOPPED', 'A stopped execution cannot accept approval delivery.', 409)
        if (budget.rows[0].exhausted) throw new DomainError('EXECUTION_ACTIVE_TIMEOUT', 'The execution exhausted its active-time budget.', 409)
      }
      const current = await this.locked(client, claim.interaction.id)
      if (!current || !['delivery_pending', 'delivery_failed', 'decided'].includes(current.status)
        || current.selectedOptionId !== claim.interaction.selectedOptionId) {
        throw new DomainError('DELIVERY_ATTEMPT_STALE', 'The interaction no longer accepts this delivery owner.', 409)
      }
      const lease = await client.query<{ delivery_token: string | null }>(
        'select delivery_token from durable_interactions where id=$1', [current.id],
      )
      if (lease.rows[0]?.delivery_token !== claim.ownerToken) {
        throw new DomainError('DELIVERY_OWNER_LOST', 'The interaction delivery fence belongs to another owner.', 409)
      }
      const owned = await client.query<AttemptRow>(
        `select attempt,state,correlation_id,lease_owner,
           coalesce(lease_expires_at > clock_timestamp(),false) as leased
         from interaction_delivery_attempts where interaction_id=$1 and attempt=$2 and lease_owner=$3
           and state in ('submitted','uncertain') for update`, [current.id, claim.attempt, claim.ownerToken],
      )
      const attempt = owned.rows[0]
      if (!attempt || (writing && (!attempt.leased || attempt.state !== 'submitted' || claim.mode !== 'submit'))) {
        throw new DomainError('DELIVERY_OWNER_LOST', 'The native delivery lease is no longer owned.', 409)
      }
      // Native exceptions must be converted by the callback, not by this transaction:
      // a database failure after a successful write is an uncertain commit, not a failed send.
      if (writing) combined.throwIfAborted()
      const result = typeof outcome === 'function' ? await interactionConnection.run(client, () => outcome(current, combined)) : outcome
      if ((claim.mode === 'reconcile' || attempt.state === 'uncertain') && result.state === 'failed') {
        throw new DomainError('DELIVERY_OUTCOME_UNCERTAIN', 'Reconciliation cannot turn an uncertain write into permission to resend.', 409)
      }
      if (!writing && result.state === 'delivered' && !matchingDeliveryEvidence(current, {
        harness: current.harness, providerVersion: current.providerVersion, nativeSessionId: current.nativeSessionId,
      }, { events: [], pendingInteractions: [], responseDeliveries: result.evidence ? [result.evidence] : [] })) {
        throw new DomainError('DELIVERY_EVIDENCE_REQUIRED', 'Reconciliation requires a qualified receipt for this exact native response.', 409)
      }
      await client.query(
        `update interaction_delivery_attempts set state=$4,error=$5,evidence=$6::jsonb,lease_expires_at=null
         where interaction_id=$1 and attempt=$2 and lease_owner=$3`,
        [current.id, claim.attempt, claim.ownerToken, result.state, result.error ?? null, JSON.stringify(result.evidence ?? null)],
      )
      const delivered = await this.write(client, current, result.state)
      await client.query(
        'update durable_interactions set delivery_owner=null,delivery_token=null,delivery_lease_expires_at=null where id=$1', [current.id],
      )
      return delivered
    })
  }

  async claimGraphResume(id: string, ownerToken: string): Promise<GraphResumeClaim | undefined> {
    return this.transaction(async (client) => {
      const current = await this.locked(client, id, true)
      if (!current || current.deliveryState !== 'delivered') return undefined
      await this.enqueueGraphResume(client, id)
      const terminal = await client.query<{ stopped: boolean; completed: boolean }>(
        `select b.stopped_at is not null as stopped,r.execution_state='completed' as completed
         from approval_execution_state b left join runs r on r.id=$2 where b.execution_id=$1`,
        [current.executionId, current.runId],
      )
      if (terminal.rows[0]?.stopped || terminal.rows[0]?.completed) {
        await client.query(
          `update interaction_graph_resumes set state=$2,lease_owner=null,lease_token=null,lease_expires_at=null,revision=revision+1,
             completed_at=now(),updated_at=now() where interaction_id=$1 and state in ('pending','resuming','blocked')`,
          [id, terminal.rows[0].stopped ? 'canceled' : 'resumed'],
        )
        return undefined
      }
      // Binding may happen after native delivery. Do not consume the intent or
      // pass the stale object originally returned by decide() to the graph.
      if (!current.graphInterruptId) return undefined
      const claimed = await client.query(
        `update interaction_graph_resumes set state='resuming',lease_owner=$2,lease_token=$2,lease_fence=lease_fence+1,revision=revision+1,
           lease_expires_at=clock_timestamp()+($3::integer * interval '1 millisecond'),
           attempt=attempt+1,updated_at=now()
         where interaction_id=$1 and state in ('pending','resuming','blocked')
           and (lease_expires_at is null or lease_expires_at<=clock_timestamp())`,
        [id, ownerToken, INTERACTION_DELIVERY_LEASE_MS],
      )
      return claimed.rowCount === 1 ? { interaction: current, ownerToken } : undefined
    })
  }

  async renewGraphResume(claim: GraphResumeClaim): Promise<void> {
    const result = await this.pool.query(
      `update interaction_graph_resumes set lease_expires_at=clock_timestamp()+($3::integer * interval '1 millisecond'),
         updated_at=now() where interaction_id=$1 and lease_owner=$2 and lease_token=$2 and state='resuming'
         and lease_expires_at>clock_timestamp()`,
      [claim.interaction.id, claim.ownerToken, INTERACTION_DELIVERY_LEASE_MS],
    )
    if (result.rowCount !== 1) throw new DomainError('GRAPH_RESUME_OWNER_LOST', 'The graph-resume intent is no longer owned.', 409)
  }

  async finishGraphResume(claim: GraphResumeClaim, error?: string): Promise<void> {
    const result = await this.pool.query(
      `update interaction_graph_resumes set state=$3,last_error=$4,lease_owner=null,lease_token=null,lease_expires_at=null,revision=revision+1,
         completed_at=case when $3='resumed' then now() else null end,updated_at=now()
       where interaction_id=$1 and lease_owner=$2 and lease_token=$2 and state='resuming' and lease_expires_at>clock_timestamp()`,
      [claim.interaction.id, claim.ownerToken, error === undefined ? 'resumed' : 'pending', error ?? null],
    )
    if (result.rowCount !== 1) throw new DomainError('GRAPH_RESUME_OWNER_LOST', 'The graph-resume intent is no longer owned.', 409)
  }

  async cancelForRun(client: pg.PoolClient, runId: string): Promise<void> {
    await client.query(
      `update interaction_delivery_attempts a set state='uncertain',lease_expires_at=null
       from durable_interactions d where a.interaction_id=d.id and d.run_id=$1 and a.state='submitted'`, [runId],
    )
    await client.query(
      `update interaction_graph_resumes g set state='canceled',lease_owner=null,lease_token=null,lease_expires_at=null,revision=g.revision+1,updated_at=now()
       from durable_interactions d where g.interaction_id=d.id and d.run_id=$1 and g.state in ('pending','resuming','blocked')`, [runId],
    )
  }

  async recoveryCandidates(input: { afterId?: string; limit: number }): Promise<DurableInteraction[]> {
    const result = await this.pool.query<{ record: unknown }>(
      `select d.record from durable_interactions d
       left join interaction_graph_resumes g on g.interaction_id=d.id
       where ($1::text is null or d.id>$1) and (
         (d.status='delivery_pending' and not exists (
           select 1 from interaction_delivery_attempts a where a.interaction_id=d.id and a.lease_expires_at>clock_timestamp()))
         -- A failure before native dispatch began is definitely unsent: retry it while its Run is open.
         or (d.status='delivery_failed' and d.record->>'kind' is distinct from 'work_direction'
           and d.record->>'deliveryState'='failed' and not exists (
           select 1 from interaction_delivery_attempts a where a.interaction_id=d.id
             and (a.approval_write_started_at is not null or a.lease_expires_at>clock_timestamp()))
           and exists (select 1 from runs r where r.id=d.run_id and not ${RUN_CLEANUP_BOUNDARY_SQL}))
         or (d.record->>'kind' is distinct from 'work_direction' and d.record->>'deliveryState'='delivered' and (g.interaction_id is null or
           (g.state in ('pending','resuming','blocked') and (g.lease_expires_at is null or g.lease_expires_at<=clock_timestamp())))))
       order by d.id limit $2`, [input.afterId ?? null, input.limit],
    )
    return result.rows.map((row) => DurableInteractionSchema.parse(row.record))
  }
}
