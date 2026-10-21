import { DurableInteractionSchema, type DurableInteraction } from '@foreman-code/contracts'
import { withTransaction } from '../../infrastructure/transaction.js'
import type pg from 'pg'

import { DomainError } from '../errors.js'

/** Database-only ownership metadata, not a provider idempotency key or public interaction shape. */
export interface InteractionLease {
  owner: string
  token: string
  fence: number
  expiresAt: string
}

export interface DeliveryFailure {
  code: string
  message: string
  phase: 'attach' | 'deliver' | 'reconcile' | 'stop'
  certainty: 'definite' | 'uncertain'
}

export interface ReconciliationEvidence {
  nativeSessionId: string
  nativeRequestId: string
  outcome: 'delivered' | 'not_delivered' | 'unknown'
  source: 'native_history' | 'native_response' | 'attachment'
  details: Record<string, unknown>
  attempt?: number
  correlationId?: string
  error?: DeliveryFailure
}

export interface LockedInteraction {
  interaction: DurableInteraction
  fence: number
  owner: string | null
  token: string | null
  leaseActive: boolean
}

export async function interactionTransaction<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(pool, work)
}

export async function lockInteraction(client: pg.ClientBase, id: string): Promise<LockedInteraction> {
  const found = await client.query<{
    record: unknown; delivery_fence: string; delivery_owner: string | null;
    delivery_token: string | null; lease_active: boolean
  }>(
    `select record,delivery_fence::text,delivery_owner,delivery_token,
       coalesce(delivery_lease_expires_at > clock_timestamp(),false) as lease_active
     from durable_interactions where id=$1 for update`, [id],
  )
  const row = found.rows[0]
  if (!row) throw new DomainError('INTERACTION_NOT_FOUND', 'The interaction was not found.', 404)
  return {
    interaction: DurableInteractionSchema.parse(row.record), fence: Number(row.delivery_fence),
    owner: row.delivery_owner, token: row.delivery_token, leaseActive: row.lease_active,
  }
}

export function assertInteractionRevision(current: DurableInteraction, expectedRevision: number): void {
  if (current.revision !== expectedRevision) {
    throw new DomainError('REVISION_CONFLICT', 'The interaction changed since it was read.', 409, { currentRevision: current.revision })
  }
}

export function assertDeliveryLease(row: LockedInteraction, lease?: InteractionLease): void {
  // Compatibility only for never-claimed rows. Once fenced, an unfenced caller
  // cannot bypass ownership even after release/expiry.
  if (row.fence === 0 && !lease) return
  if (!lease || !row.leaseActive || row.fence !== lease.fence || row.owner !== lease.owner || row.token !== lease.token) {
    throw new DomainError('DELIVERY_LEASE_LOST', 'The delivery lease is no longer owned.', 409)
  }
}
