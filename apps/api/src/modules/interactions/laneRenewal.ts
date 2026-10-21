import type { SqlQuery } from '../../infrastructure/transaction.js'
import { isDatabaseTimeout } from '../../infrastructure/databaseTimeout.js'
import { DomainError } from '../errors.js'
import type { LaneLeaseOwnership } from './coordination.js'

export function isRetryableLaneRenewal(error: unknown): boolean {
  return isDatabaseTimeout(error)
    || error instanceof DomainError && error.code === 'SESSION_LANE_RENEWAL_BUSY'
}

export async function renewNativeLane(sql: SqlQuery, id: string, token: string, leaseMs: number,
  ownership?: LaneLeaseOwnership): Promise<string> {
  const result = await sql.query<{ expires_at: string }>(`with owned_lane as materialized (
      select id from native_session_lanes where id=$1 and record->>'leaseToken'=$2
        and ($4::text is not null or (record->>'leaseExpiresAt')::timestamptz > clock_timestamp())
        and ($4::text is null or (record->>'leaseOwner'=$4
          and (record->>'connectionGeneration')::bigint=$5))
      for no key update skip locked
    ) update native_session_lanes l set revision=l.revision+1,updated_at=clock_timestamp(),
      record=jsonb_set(jsonb_set(l.record,'{revision}',to_jsonb((l.revision+1)::bigint)),
        '{leaseExpiresAt}',to_jsonb(to_char(
          (clock_timestamp()+($3 * interval '1 millisecond')) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
    from owned_lane where l.id=owned_lane.id returning l.record->>'leaseExpiresAt' as expires_at`,
  [id, token, leaseMs, ownership?.owner ?? null, ownership?.connectionGeneration ?? null])
  if (result.rows[0]) return result.rows[0].expires_at

  // A snapshot read distinguishes contention from a changed owner without joining the lock queue.
  const current = await sql.query<{ renewable: boolean }>(`select exists(
      select 1 from native_session_lanes where id=$1 and record->>'leaseToken'=$2
        and ($3::text is not null or (record->>'leaseExpiresAt')::timestamptz > clock_timestamp())
        and ($3::text is null or (record->>'leaseOwner'=$3
          and (record->>'connectionGeneration')::bigint=$4))
    ) as renewable`, [id, token, ownership?.owner ?? null, ownership?.connectionGeneration ?? null])
  if (current.rows[0]?.renewable) {
    throw new DomainError('SESSION_LANE_RENEWAL_BUSY', 'The native lane is being published. Retry its renewal.', 409)
  }
  throw new DomainError('SESSION_LANE_LEASE_LOST', 'The native writer lease is no longer owned.', 409)
}
