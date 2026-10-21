import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { withTransaction, type SqlQuery } from '../../infrastructure/transaction.js'
import { componentLogger } from '../diagnostics/logger.js'
import { DomainError } from '../errors.js'
import { withCiDatabaseReservation, withoutCiDatabaseDeadline } from '../../infrastructure/ciDatabasePriority.js'

// A cloud recovery can make two bounded 75-second requests before it writes again.
const CLAIM_TTL_MS = 300_000

export interface CiTicketSql extends SqlQuery {
  transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T>
}

function ticketSql(pool: pg.Pool, ticketId: string, ownerId: string): CiTicketSql {
  const transaction = <T>(work: (client: pg.PoolClient) => Promise<T>) =>
    withCiDatabaseReservation(pool, () => withTransaction(pool, async client => {
      const claim = await client.query(`update ci_dispatch_claims
        set expires_at=clock_timestamp()+$3*interval '1 millisecond'
        where ticket_id=$1 and owner_id=$2 and expires_at>clock_timestamp()`,
      [ticketId, ownerId, CLAIM_TTL_MS])
      if (!claim.rowCount) {
        throw new DomainError('CI_DISPATCH_CLAIM_LOST', 'The CI dispatch claim expired; retry reconciliation.', 409)
      }
      return work(client)
    }))
  return {
    transaction,
    query: (text, values) => transaction(client => client.query(text, values)),
  }
}

/** Commit exclusion before remote I/O; each database operation takes its own short pooled lease. */
export async function withCiTicketLock<T>(pool: pg.Pool, ticketId: string,
  work: (sql: CiTicketSql) => Promise<T>): Promise<T | undefined> {
  const ownerId = randomUUID()
  const claim = await withCiDatabaseReservation(pool, () => pool.query(
    `insert into ci_dispatch_claims(ticket_id,owner_id,expires_at)
    values($1,$2,clock_timestamp()+$3*interval '1 millisecond')
    on conflict(ticket_id) do update set owner_id=excluded.owner_id,expires_at=excluded.expires_at
      where ci_dispatch_claims.expires_at<=clock_timestamp()
    returning ticket_id`, [ticketId, ownerId, CLAIM_TTL_MS]))
  if (!claim.rowCount) return undefined
  try {
    return await work(ticketSql(pool, ticketId, ownerId))
  } finally {
    try {
      await withoutCiDatabaseDeadline(() =>
        withCiDatabaseReservation(pool, () =>
          pool.query('delete from ci_dispatch_claims where ticket_id=$1 and owner_id=$2', [ticketId, ownerId])))
    } catch (error) {
      componentLogger('jobs').warn({ err: error, ticketId }, 'CI dispatch claim cleanup failed; it will expire')
    }
  }
}
