import { readActivityAcknowledgment } from './activityAcknowledgment.js'
import { withTransaction, beginTransaction, commitTransaction, rollbackAfterFailure } from '../../infrastructure/transaction.js'
import {
  DurableInteractionSchema,
  InteractionRecoveryQuerySchema,
  type DurableInteraction,
  type InteractionRecoveryQuery,
  type NativeHarnessEvent,
} from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type pg from 'pg'
import type { ManagementScope } from '@foreman-code/contracts/management'

import { DomainError } from '../errors.js'
import { requireRespondableInteraction } from '../access/appPolicy.js'
import { lockActiveWorkerPrincipal, requireActiveWorkerBinding } from '../access/workerLifecycle.js'
import { PostgresInteractionDeliveryRepository } from './deliveryPostgres.js'
import { appendNativeEvent } from '../runs/nativeEvents.js'
import { assertOrchestratorGraphAuthority } from './graphAuthority.js'
import { interactionConnection } from './connection.js'
import {
  assertDeliveryLease, assertInteractionRevision, interactionTransaction, lockInteraction,
  type DeliveryFailure, type InteractionLease, type LockedInteraction, type ReconciliationEvidence,
} from './persistence.js'

type DecisionResult = { interaction: DurableInteraction; replayed: boolean }
interface DeliveryUpdate {
  lease?: InteractionLease
  error?: DeliveryFailure
}
import { PostgresInteractionCoordinationRepository } from './coordination.js'

interface InteractionQuery {
  workspaceId?: string | undefined
  workflowId?: string | undefined
  runId?: string | undefined
  handler?: DurableInteraction['approval']['handler'] | undefined
  status?: DurableInteraction['status'] | undefined
  afterId?: string | undefined
  scopes?: ManagementScope[] | undefined
  limit: number
}
// Bound JSON scopes enforce authorization BEFORE LIMIT, including run-only grants.
const VISIBLE_SCOPE = `($8::jsonb is null or exists (
  select 1 from jsonb_array_elements($8::jsonb) allowed
  where (not (allowed ? 'workspaceIds') or (allowed->'workspaceIds') ? workspace_id)
    and (not (allowed ? 'workflowIds') or (allowed->'workflowIds') ? workflow_id)
    and (not (allowed ? 'runIds') or (allowed->'runIds') ? run_id)
))`

/** Transactional durable interaction primitives; routing/dispatch intentionally lives elsewhere. */
export class PostgresInteractionRepository {
  activityAcknowledgment(interaction: DurableInteraction) { return readActivityAcknowledgment(this.pool, interaction) }

  readonly delivery: PostgresInteractionDeliveryRepository
  readonly coordination: PostgresInteractionCoordinationRepository

  constructor(private readonly pool: pg.Pool) {
    this.delivery = new PostgresInteractionDeliveryRepository(pool)
    this.coordination = new PostgresInteractionCoordinationRepository(pool)
  }

  assertOrchestratorConnection(
    interaction: Parameters<typeof assertOrchestratorGraphAuthority>[1],
    reviewer: Parameters<typeof assertOrchestratorGraphAuthority>[2] = {},
  ) {
    return assertOrchestratorGraphAuthority(interactionConnection.getStore() ?? this.pool, interaction, reviewer)
  }

  async create(input: DurableInteraction): Promise<{ interaction: DurableInteraction; created: boolean }> {
    const interaction = DurableInteractionSchema.parse(input)
    const result = await this.pool.query<{ record: unknown }>(
      `insert into durable_interactions
       (id, workspace_id, workflow_id, run_id, execution_id, requesting_agent_id, harness,
        native_session_id, native_request_id, status, revision, record)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
       on conflict (harness, native_session_id, native_request_id) do nothing
       returning record`,
      [interaction.id, interaction.workspaceId, interaction.workflowId, interaction.runId,
        interaction.executionId, interaction.requestingAgentId, interaction.harness,
        interaction.nativeSessionId, interaction.nativeRequestId, interaction.status,
        interaction.revision, JSON.stringify(interaction)],
    )
    if (result.rows[0]) return { interaction: DurableInteractionSchema.parse(result.rows[0].record), created: true }
    const existing = await this.pool.query<{ record: unknown }>(
      `select record from durable_interactions
       where harness=$1 and native_session_id=$2 and native_request_id=$3`,
      [interaction.harness, interaction.nativeSessionId, interaction.nativeRequestId],
    )
    const persisted = DurableInteractionSchema.parse(existing.rows[0]?.record)
    if (persisted.executionId !== interaction.executionId || persisted.requestingAgentId !== interaction.requestingAgentId
      || persisted.runId !== interaction.runId || persisted.workflowId !== interaction.workflowId
      || persisted.workspaceId !== interaction.workspaceId || persisted.providerVersion !== interaction.providerVersion
      || persisted.graphThreadId !== interaction.graphThreadId) {
      throw new DomainError('INTERACTION_IDENTITY_CONFLICT', 'The native request identity is already bound to another execution.', 409)
    }
    return { interaction: persisted, created: false }
  }

  async getNativeRequest(executionId: string, harness: string, nativeSessionId: string,
    nativeRequestId: string): Promise<DurableInteraction | undefined> {
    const row = (await this.pool.query<{ record: unknown }>(`select record from durable_interactions
      where execution_id=$1 and harness=$2 and native_session_id=$3 and native_request_id=$4`,
    [executionId, harness, nativeSessionId, nativeRequestId])).rows[0]
    if (!row) return undefined
    const value = DurableInteractionSchema.parse(row.record)
    if (value.executionId !== executionId || value.harness !== harness || value.nativeSessionId !== nativeSessionId
      || value.nativeRequestId !== nativeRequestId) throw new DomainError('INTERACTION_IDENTITY_CONFLICT',
      'The native request readback does not match its physical identity.', 409)
    return value
  }
  async get(id: string): Promise<DurableInteraction | undefined> {
    const result = await this.pool.query<{ record: unknown }>('select record from durable_interactions where id=$1', [id])
    return result.rows[0] ? DurableInteractionSchema.parse(result.rows[0].record) : undefined
  }

  async getForExecution(executionId: string): Promise<DurableInteraction | undefined> {
    const result = await this.pool.query<{ record: unknown }>(
      `select record from durable_interactions where execution_id=$1
       order by created_at desc, id desc limit 1`, [executionId],
    )
    return result.rows[0] ? DurableInteractionSchema.parse(result.rows[0].record) : undefined
  }

  async bindGraphInterrupt(id: string, graphInterruptId: string): Promise<DurableInteraction> {
    return withTransaction(this.pool, async (client) => {
      const found = await client.query<{ record: unknown }>('select record from durable_interactions where id=$1 for update', [id])
      const current = found.rows[0] ? DurableInteractionSchema.parse(found.rows[0].record) : undefined
      if (!current) throw new DomainError('INTERACTION_NOT_FOUND', 'The interaction was not found.', 404)
      if (current.graphInterruptId && current.graphInterruptId !== graphInterruptId) {
        throw new DomainError('INTERACTION_INTERRUPT_CONFLICT', 'The interaction is already bound to another graph interrupt.', 409)
      }
      if (current.graphInterruptId) return current
      const next = DurableInteractionSchema.parse({
        ...current, graphInterruptId, revision: current.revision + 1, updatedAt: new Date().toISOString(),
      })
      const updated = await client.query(
        'update durable_interactions set revision=$2,record=$3::jsonb,updated_at=now() where id=$1 and revision=$4',
        [id, next.revision, JSON.stringify(next), current.revision],
      )
      if (updated.rowCount !== 1) throw new DomainError('REVISION_CONFLICT', 'The interaction changed while binding its graph interrupt.', 409)
      return next
    })
  }

  async list(input: InteractionQuery): Promise<DurableInteraction[]> {
    const result = await this.pool.query<{ record: unknown }>(
      `select record from durable_interactions
       where ($1::text is null or workspace_id=$1) and ($2::text is null or workflow_id=$2)
         and ($3::text is null or run_id=$3) and ($4::text is null or record->'approval'->>'handler'=$4)
         and ($5::text is null or status=$5) and ($6::text is null or id>$6)
         and ${VISIBLE_SCOPE}
       order by id limit $7`,
      [input.workspaceId ?? null, input.workflowId ?? null, input.runId ?? null, input.handler ?? null,
        input.status ?? null, input.afterId ?? null, input.limit, input.scopes ? JSON.stringify(input.scopes) : null],
    )
    return result.rows.map((row) => DurableInteractionSchema.parse(row.record))
  }

  async pendingCounts(input: Omit<InteractionQuery, 'limit'>): Promise<{ pendingCount: number; pendingByWorkflow: Record<string, number> }> {
    const result = await this.pool.query<{ workflow_id: string; pending_count: string }>(
      `select workflow_id, count(*)::text as pending_count from durable_interactions
       where status='pending' and ($1::text is null or workspace_id=$1)
         and ($2::text is null or workflow_id=$2) and ($3::text is null or run_id=$3)
         and ($4::text is null or record->'approval'->>'handler'=$4)
         and ${VISIBLE_SCOPE.replaceAll('$8', '$5')}
       group by workflow_id`,
      [input.workspaceId ?? null, input.workflowId ?? null, input.runId ?? null, input.handler ?? null,
        input.scopes ? JSON.stringify(input.scopes) : null],
    )
    const pendingByWorkflow = Object.fromEntries(result.rows.map((row) => [row.workflow_id, Number(row.pending_count)]))
    return { pendingByWorkflow, pendingCount: Object.values(pendingByWorkflow).reduce((sum, count) => sum + count, 0) }
  }

  async listPending(input: { workspaceId?: string; workflowId?: string; afterId?: string; limit: number }): Promise<DurableInteraction[]> {
    const result = await this.pool.query<{ record: unknown }>(
      `select record from durable_interactions
       where status='pending' and ($1::text is null or workspace_id=$1)
         and ($2::text is null or workflow_id=$2) and ($3::text is null or id>$3)
       order by id limit $4`, [input.workspaceId ?? null, input.workflowId ?? null, input.afterId ?? null, input.limit],
    )
    return result.rows.map((row) => DurableInteractionSchema.parse(row.record))
  }

  /** Compatibility recovery view retained for the scoped HAP-02 callers. */
  async listRecoverableDeliveries(input: InteractionRecoveryQuery): Promise<DurableInteraction[]> {
    const query = InteractionRecoveryQuerySchema.parse(input)
    const result = await this.pool.query<{ record: unknown }>(
      `select record from durable_interactions where workspace_id=$1
         and ($2::text is null or workflow_id=$2) and ($3::text is null or run_id=$3)
         and ($4::text is null or id>$4)
         and (($5='send' and ((status='decided' and record->>'deliveryState'='not_started')
           or (status='delivery_pending' and record->>'deliveryState'='pending')))
           or ($5='reconcile' and ((status='delivery_pending' and record->>'deliveryState' in ('submitted','uncertain'))
             or (status='delivery_failed' and record->>'deliveryState'='failed'))))
       order by id limit $6`,
      [query.workspaceId, query.workflowId ?? null, query.runId ?? null, query.afterId ?? null, query.mode, query.limit],
    )
    return result.rows.map((row) => DurableInteractionSchema.parse(row.record))
  }

  async decide(input: {
    id: string; optionId: string; expectedRevision: number; nativeResponse: unknown; auditReference?: string
    principal?: ManagementPrincipal
    source?: 'http' | 'mcp'
    signal?: AbortSignal
    beforeCommit?(client: pg.PoolClient, result: DecisionResult): Promise<void>
  }): Promise<DecisionResult> {
    const response = DurableInteractionSchema.shape.nativeResponse.unwrap().parse(input.nativeResponse)
    const client = await this.pool.connect()
    let committing = false
    let releaseError: Error | undefined
    try {
      await beginTransaction(client)
      let principal: ManagementPrincipal | undefined
      let targetRunId: string | undefined
      if (input.principal) {
        const target = await client.query<{ run_id: string }>('select run_id from durable_interactions where id=$1', [input.id])
        targetRunId = target.rows[0]?.run_id
        principal = await lockActiveWorkerPrincipal(client, input.principal, targetRunId, 'update')
      }
      const found = await client.query<{ record: unknown }>('select record from durable_interactions where id=$1 for update', [input.id])
      const current = found.rows[0] ? DurableInteractionSchema.parse(found.rows[0].record) : undefined
      if (!current) throw new DomainError('INTERACTION_NOT_FOUND', 'The interaction was not found.', 404)
      if (principal) {
        requireRespondableInteraction(principal, current)
        if (current.runId !== targetRunId) throw new DomainError('INTERACTION_NOT_FOUND', 'The interaction was not found.', 404)
      }
      await assertOrchestratorGraphAuthority(client, current, principal ? { principalId: principal.id } : {})
      if (current.status === 'canceled') throw new DomainError('INTERACTION_CANCELED', 'The interaction was canceled.', 409)
      if (current.status !== 'pending') {
        if (current.selectedOptionId === input.optionId) {
          const result = { interaction: current, replayed: true }
          await input.beforeCommit?.(client, result)
          if (principal) await requireActiveWorkerBinding(client, principal.id)
          committing = true
          await commitTransaction(client)
          return result
        }
        throw new DomainError('INTERACTION_ALREADY_DECIDED', 'The interaction already has a different decision.', 409)
      }
      if (current.revision !== input.expectedRevision) throw new DomainError('REVISION_CONFLICT', 'The interaction changed since it was read.', 409, { currentRevision: current.revision })
      const option = current.responseOptions.find((candidate) => candidate.optionId === input.optionId)
      if (!option) throw new DomainError('INTERACTION_OPTION_INVALID', 'The response option is not valid for this interaction.', 409)
      const now = new Date().toISOString()
      const next = DurableInteractionSchema.parse({
        ...current, revision: current.revision + 1, status: 'delivery_pending',
        selectedOptionId: option.optionId, selectedSemantic: option.semantic,
        nativeResponse: principal ? { optionId: option.optionId, semantic: option.semantic } : response, deliveryState: 'pending',
        ...(input.auditReference ? { auditReference: input.auditReference } : {}),
        decidedAt: now, updatedAt: now,
      })
      const updated = await client.query(
        `update durable_interactions set status=$2, revision=$3, record=$4::jsonb, updated_at=now()
         where id=$1 and revision=$5`, [next.id, next.status, next.revision, JSON.stringify(next), current.revision],
      )
      if (updated.rowCount !== 1) throw new DomainError('REVISION_CONFLICT', 'The interaction changed during the decision.', 409)
      const result = { interaction: next, replayed: false }
      await input.beforeCommit?.(client, result)
      if (principal) await requireActiveWorkerBinding(client, principal.id)
      committing = true
      await commitTransaction(client)
      return result
    } catch (error) {
      releaseError = await rollbackAfterFailure(client)
      if (committing) {
        throw new DomainError('INTERACTION_DECISION_STATUS_UNKNOWN', 'Decision commit could not be confirmed. Read the interaction before retrying; the decision may already have committed.', 503, undefined, { cause: error })
      }
      throw error
    } finally { client.release(releaseError) }
  }

  async updateDelivery(id: string, expectedRevision: number, state: 'submitted' | 'uncertain' | 'delivered' | 'failed', input: DeliveryUpdate = {}): Promise<DurableInteraction> {
    return interactionTransaction(this.pool, async (client) => this.writeDelivery(
      client, await lockInteraction(client, id), expectedRevision, state, input,
    ))
  }

  /** A retry becomes sendable only after exact provider evidence proves non-delivery. */
  async reconcileDelivery(id: string, expectedRevision: number, result: 'delivered' | 'not_delivered' | 'unknown'): Promise<DurableInteraction> {
    return interactionTransaction(this.pool, async (client) => {
      const row = await lockInteraction(client, id)
      const current = row.interaction
      assertInteractionRevision(current, expectedRevision)
      if (!['submitted', 'uncertain', 'failed'].includes(current.deliveryState)
        || !['delivery_pending', 'delivery_failed'].includes(current.status)) {
        throw new DomainError('INTERACTION_RECONCILIATION_INVALID', 'Only unresolved delivery attempts may be reconciled.', 409)
      }
      const now = new Date().toISOString()
      const next = DurableInteractionSchema.parse({ ...current, revision: current.revision + 1,
        status: result === 'delivered' ? 'delivered' : 'delivery_pending',
        deliveryState: result === 'delivered' ? 'delivered' : result === 'not_delivered' ? 'pending' : 'uncertain',
        ...(result === 'delivered' ? { deliveredAt: current.deliveredAt ?? now } : {}), updatedAt: now,
      })
      const updated = await client.query(
        `update durable_interactions set status=$2,revision=$3,record=$4::jsonb,updated_at=now(),
           reconciliation_status=$5 where id=$1 and revision=$6 and delivery_fence=$7`,
        [id, next.status, next.revision, JSON.stringify(next), result, current.revision, row.fence],
      )
      if (updated.rowCount !== 1) throw new DomainError('REVISION_CONFLICT', 'The interaction changed during reconciliation.', 409)
      return next
    })
  }

  private async writeDelivery(client: pg.ClientBase, row: LockedInteraction, expectedRevision: number, state: 'submitted' | 'uncertain' | 'delivered' | 'failed', input: DeliveryUpdate): Promise<DurableInteraction> {
    const current = row.interaction
    assertInteractionRevision(current, expectedRevision)
    assertDeliveryLease(row, input.lease)
    if (current.status === 'canceled') throw new DomainError('INTERACTION_CANCELED', 'The interaction was canceled.', 409)
    const allowed: Record<DurableInteraction['deliveryState'], readonly string[]> = {
      not_started: [], pending: ['submitted', 'failed'], submitted: ['uncertain', 'delivered', 'failed'],
      uncertain: ['delivered', 'failed'], delivered: [], failed: [],
    }
    if (current.deliveryState === state && !input.error) return current
    if (!current.selectedOptionId || (current.deliveryState !== state && !allowed[current.deliveryState].includes(state))) {
      throw new DomainError('DELIVERY_TRANSITION_INVALID', 'This delivery transition would reopen or overwrite a settled native response.', 409)
    }
    const now = new Date().toISOString()
    const status = state === 'delivered' ? 'delivered' : state === 'failed' ? 'delivery_failed' : 'delivery_pending'
    const next = DurableInteractionSchema.parse({ ...current, revision: current.revision + 1, status, deliveryState: state,
      ...(state === 'delivered' ? { deliveredAt: current.deliveredAt ?? now } : {}), updatedAt: now })
    const failure = input.error ?? (state === 'failed' || state === 'uncertain' ? {
      code: state === 'failed' ? 'NATIVE_DELIVERY_FAILED' : 'NATIVE_DELIVERY_UNCERTAIN',
      message: 'Native delivery did not complete; the caller supplied no further error evidence.',
      phase: 'deliver', certainty: 'uncertain',
    } : undefined)
    const result = await client.query(
      `update durable_interactions set status=$2, revision=$3, record=$4::jsonb, updated_at=now(),
         last_delivery_error=coalesce($6::jsonb,last_delivery_error),
         reconciliation_status=case when $7='unknown' and reconciliation_status='not_delivered'
           then reconciliation_status else $7 end
       where id=$1 and revision=$5 and delivery_fence=$8
         and ($8::bigint=0 or (delivery_token=$9 and delivery_lease_expires_at > clock_timestamp()))`,
      [current.id, next.status, next.revision, JSON.stringify(next), expectedRevision,
        failure ? JSON.stringify(failure) : null,
        state === 'delivered' ? 'delivered' : state === 'failed'
          ? (failure?.certainty === 'definite' ? 'not_delivered' : 'unknown')
          : state === 'uncertain' ? 'unknown' : 'required',
        row.fence, input.lease?.token ?? null],
    )
    if (result.rowCount !== 1) throw new DomainError('DELIVERY_LEASE_LOST', 'The delivery revision or lease changed during the transition.', 409)
    return next
  }

  async cancelPendingForExecution(executionId: string, nativeRequestIds?: readonly string[]): Promise<void> {
    // Terminal execution or explicit provider cancellation evidence makes these
    // asks non-actionable. Never turn a sibling into an approved/delivered ask.
    await this.pool.query(
      `update durable_interactions set status='canceled',revision=revision+1,updated_at=now(),
         record=record || jsonb_build_object('status','canceled','revision',revision+1,'updatedAt',
           to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
       where execution_id=$1 and status='pending'
         and ($2::text[] is null or native_request_id=any($2))`, [executionId, nativeRequestIds ?? null],
    )
  }

  async cancelPendingForRun(runId: string): Promise<number> {
    return withTransaction(this.pool, async (client) => {
      const found = await client.query<{ id: string; record: unknown }>(
        `select id,record from durable_interactions
         where run_id=$1 and (status in ('pending','decided','delivery_pending','delivery_failed') or
           (status='delivered' and exists (select 1 from interaction_graph_resumes g
             where g.interaction_id=durable_interactions.id and g.state not in ('resumed','canceled'))))
         order by id for update`, [runId],
      )
      for (const row of found.rows) {
        const current = DurableInteractionSchema.parse(row.record)
        const now = new Date().toISOString()
        const next = DurableInteractionSchema.parse({
          ...current, revision: current.revision + 1, status: 'canceled',
          deliveryState: current.deliveryState === 'not_started' ? 'not_started'
            : current.deliveryState === 'delivered' ? 'delivered' : 'failed', updatedAt: now,
        })
        const updated = await client.query(
          `update durable_interactions set status=$2,revision=$3,record=$4::jsonb,updated_at=now(),
             delivery_fence=delivery_fence+1,delivery_owner=null,delivery_token=null,delivery_lease_expires_at=null,
             last_delivery_error=$5::jsonb where id=$1 and revision=$6`,
          [current.id, next.status, next.revision, JSON.stringify(next), JSON.stringify({
            code: 'INTERACTION_CANCELED', message: 'Stop canceled the interaction; any submitted native response still requires evidence.',
            phase: 'stop', certainty: current.deliveryState === 'submitted' || current.deliveryState === 'uncertain' ? 'uncertain' : 'definite',
          }), current.revision],
        )
        if (updated.rowCount !== 1) throw new DomainError('REVISION_CONFLICT', 'The interaction changed during cancellation.', 409)
      }
      await this.delivery.cancelForRun(client, runId)
      return found.rowCount ?? 0
    })
  }

  async beginDeliveryAttempt(interaction: DurableInteraction, correlationId: string, lease?: InteractionLease): Promise<number> {
    return interactionTransaction(this.pool, async (client) => {
      const row = await lockInteraction(client, interaction.id)
      assertInteractionRevision(row.interaction, interaction.revision)
      assertDeliveryLease(row, lease)
      if (row.interaction.nativeSessionId !== interaction.nativeSessionId || row.interaction.nativeRequestId !== interaction.nativeRequestId) {
        throw new DomainError('INTERACTION_IDENTITY_CONFLICT', 'The attempt must retain the exact native request identity.', 409)
      }
      if (row.interaction.status !== 'delivery_pending' || row.interaction.deliveryState !== 'submitted') {
        throw new DomainError('DELIVERY_TRANSITION_INVALID', 'Only a submitted interaction can open a delivery attempt.', 409)
      }
      const active = await client.query(
        `select attempt from interaction_delivery_attempts where interaction_id=$1 and state in ('submitted','uncertain')`, [interaction.id],
      )
      if (active.rowCount) throw new DomainError('DELIVERY_ATTEMPT_ACTIVE', 'An existing attempt must be reconciled, not submitted again.', 409)
      // The interaction row lock serializes max(attempt)+1, including different workers.
      const result = await client.query<{ attempt: number }>(
        `insert into interaction_delivery_attempts
         (interaction_id,attempt,state,native_session_id,native_request_id,correlation_id,delivery_fence)
         select $1,coalesce(max(attempt),0)+1,'submitted',$2,$3,$4,$5
         from interaction_delivery_attempts where interaction_id=$1
         having exists (select 1 from durable_interactions where id=$1 and delivery_fence=$5
           and ($5::bigint=0 or (delivery_token=$6 and delivery_lease_expires_at > clock_timestamp())))
         returning attempt`,
        [interaction.id, interaction.nativeSessionId, interaction.nativeRequestId, correlationId, row.fence, lease?.token ?? null],
      )
      if (!result.rows[0]) throw new DomainError('DELIVERY_LEASE_LOST', 'The delivery lease expired before the attempt was recorded.', 409)
      return result.rows[0].attempt
    })
  }

  async finishDeliveryAttempt(interactionId: string, attempt: number, state: 'uncertain' | 'delivered' | 'failed', error?: string, lease?: InteractionLease): Promise<void> {
    await interactionTransaction(this.pool, async (client) => this.writeAttempt(
      client, await lockInteraction(client, interactionId), attempt, state, error, lease,
    ))
  }

  /** Commit the attempt outcome, interaction state, audit, and resume intent together. */
  async settleDeliveryAttempt(input: {
    interactionId: string; expectedRevision: number; attempt: number;
    state: 'uncertain' | 'delivered' | 'failed'; lease: InteractionLease; error?: DeliveryFailure
  }): Promise<DurableInteraction> {
    return interactionTransaction(this.pool, async (client) => {
      const row = await lockInteraction(client, input.interactionId)
      assertInteractionRevision(row.interaction, input.expectedRevision)
      await this.writeAttempt(client, row, input.attempt, input.state, input.error?.message, input.lease)
      return this.writeDelivery(client, row, input.expectedRevision, input.state, input)
    })
  }

  private async writeAttempt(client: pg.ClientBase, row: LockedInteraction, attempt: number, state: 'uncertain' | 'delivered' | 'failed', error?: string, lease?: InteractionLease): Promise<void> {
    assertDeliveryLease(row, lease)
    if (row.interaction.status === 'canceled' || (row.interaction.deliveryState === 'delivered' && state !== 'delivered')) {
      throw new DomainError('DELIVERY_TRANSITION_INVALID', 'The attempt cannot overwrite a canceled or confirmed delivered response.', 409)
    }
    const result = await client.query(
      `update interaction_delivery_attempts a set state=$3,error=coalesce($4,error),updated_at=now()
       where interaction_id=$1 and attempt=$2 and state in ('submitted','uncertain')
         and exists (select 1 from durable_interactions i where i.id=a.interaction_id
           and i.delivery_fence=$5 and ($5::bigint=0 or
             (i.delivery_token=$6 and i.delivery_lease_expires_at > clock_timestamp())))`,
      [row.interaction.id, attempt, state, error ?? null, row.fence, lease?.token ?? null],
    )
    if (result.rowCount !== 1) throw new DomainError('DELIVERY_ATTEMPT_STALE', 'The delivery attempt or its owner changed during reconciliation.', 409)
  }

  async recordReconciliation(id: string, expectedRevision: number, evidence: ReconciliationEvidence, lease?: InteractionLease): Promise<DurableInteraction> {
    return interactionTransaction(this.pool, async (client) => {
      const row = await lockInteraction(client, id)
      const current = row.interaction
      assertInteractionRevision(current, expectedRevision)
      assertDeliveryLease(row, lease)
      if (current.nativeSessionId !== evidence.nativeSessionId || current.nativeRequestId !== evidence.nativeRequestId) {
        throw new DomainError('INTERACTION_IDENTITY_CONFLICT', 'Reconciliation evidence belongs to another native request.', 409)
      }
      if (evidence.attempt !== undefined) {
        const attempt = await client.query<{ correlation_id: string }>(
          'select correlation_id from interaction_delivery_attempts where interaction_id=$1 and attempt=$2', [id, evidence.attempt],
        )
        if (!attempt.rows[0] || (evidence.correlationId !== undefined && attempt.rows[0].correlation_id !== evidence.correlationId)) {
          throw new DomainError('DELIVERY_ATTEMPT_STALE', 'Reconciliation evidence does not match the recorded attempt.', 409)
        }
      }
      await client.query(
        `insert into interaction_reconciliation_evidence
         (interaction_id,attempt,delivery_fence,native_session_id,native_request_id,correlation_id,outcome,evidence,error)
         values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
        [id, evidence.attempt ?? null, row.fence, current.nativeSessionId, current.nativeRequestId,
          evidence.correlationId ?? null, evidence.outcome, JSON.stringify({
            source: evidence.source, harness: current.harness, providerVersion: current.providerVersion, details: evidence.details,
          }), evidence.error ? JSON.stringify(evidence.error) : null],
      )
      const next = DurableInteractionSchema.parse({ ...current, revision: current.revision + 1, updatedAt: new Date().toISOString() })
      const updated = await client.query(
        `update durable_interactions set revision=$2,record=$3::jsonb,reconciliation_status=$4,
           last_delivery_error=coalesce($5::jsonb,last_delivery_error),updated_at=now()
         where id=$1 and revision=$6 and delivery_fence=$7
           and ($7::bigint=0 or (delivery_token=$8 and delivery_lease_expires_at > clock_timestamp()))`,
        [id, next.revision, JSON.stringify(next), evidence.outcome, evidence.error ? JSON.stringify(evidence.error) : null,
          current.revision, row.fence, lease?.token ?? null],
      )
      if (updated.rowCount !== 1) throw new DomainError('DELIVERY_LEASE_LOST', 'The delivery owner changed while recording evidence.', 409)
      // Evidence is not permission to replay a provider call. The delivery owner
      // decides whether it proves a terminal outcome; unknown stays unknown.
      return next
    })
  }

  async appendNativeHistory(interaction: DurableInteraction, events: readonly NativeHarnessEvent[]): Promise<void> {
    const current = await this.get(interaction.id)
    if (!current || current.executionId !== interaction.executionId || current.nativeSessionId !== interaction.nativeSessionId
      || current.nativeRequestId !== interaction.nativeRequestId) {
      throw new DomainError('INTERACTION_IDENTITY_CONFLICT', 'Native history must belong to the persisted interaction.', 409)
    }
    for (const event of events) await appendNativeEvent(this.pool, { ...event, executionId: current.executionId })
  }

}
