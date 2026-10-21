import type pg from 'pg'
import { DomainError } from '../../errors.js'

/** A heartbeat is ownership bookkeeping, not a new review fact. In particular,
 * do not bump review_jobs.revision: currentExchanges exposes it at the graph head.
 * PostgreSQL rechecks the token/expiry predicates after a competing row writer.
 */
export async function renewReviewLease(sql: Pick<pg.Pool, 'query'>, id: string, token: string, leaseMs: number): Promise<string> {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > 2147483647) {
    throw new DomainError('LEASE_EXPIRY_INVALID', 'A review lease duration must be a positive bounded integer.', 400)
  }
  const result = await sql.query<{ expires_at: string }>(
    `update review_jobs set record=jsonb_set(record, '{leaseExpiresAt}', to_jsonb(to_char(
       greatest(lease_expires_at, (record->>'leaseExpiresAt')::timestamptz,
         clock_timestamp()+($3::integer * interval '1 millisecond')) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
     where id=$1 and lease_token=$2 and record->>'leaseToken'=$2
       and lease_expires_at>clock_timestamp()
       and (record->>'leaseExpiresAt')::timestamptz>clock_timestamp()
     returning record->>'leaseExpiresAt' as expires_at`, [id, token, leaseMs],
  )
  if (result.rowCount !== 1) {
    throw new DomainError('REVIEW_JOB_LEASE_LOST', 'An expired or successor-owned review lease cannot be renewed.', 409)
  }
  return result.rows[0]!.expires_at
}
