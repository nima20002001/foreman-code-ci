import { assertGraphTransaction, type GraphTransactionSql } from '../run-graph/connection.js'
import { memoizeNativeRead, nativeCommitCheck } from '../run-graph/nativeBatch.js'
import type { WorkflowNativeCapture } from '../interactions/workflowNativeCapture.js'
import type { RunOwnership } from './ownership.js'
import { DomainError } from '../errors.js'

type Lane = NonNullable<WorkflowNativeCapture['lane']>
interface LockedLane {
  owner: RunOwnership
  token: string
  generation: number
  leaseOwner: string
  agentId: string
  harness: string
  sessionId: string
  leaseMs: number
  expiresAt: string
}
const lockedLanes = new WeakMap<GraphTransactionSql, Map<string, LockedLane>>()

function lost(): never {
  throw new DomainError('SESSION_LANE_LEASE_LOST', 'The native publication lane changed owners.', 409)
}

/** Register the live lease read by physical validation while its row remains locked. */
export function holdWorkflowNativePublicationLease(sql: GraphTransactionSql, owner: RunOwnership,
  capture: WorkflowNativeCapture, lane: Lane,
  locked: { lease_owner: string | null; lease_ms: number; expires_at: string }): void {
  assertGraphTransaction(sql)
  if (!locked.lease_owner) return lost()
  let lanes = lockedLanes.get(sql)
  const previous = lanes?.get(lane.id)
  if (previous) {
    if (previous.owner !== owner || previous.token !== lane.token || previous.generation !== lane.connectionGeneration
      || previous.agentId !== capture.execution.agentId || previous.harness !== capture.session.harness
      || previous.sessionId !== capture.session.nativeSessionId
      || previous.leaseOwner !== locked.lease_owner || previous.expiresAt !== locked.expires_at) return lost()
    return
  }
  if (!lanes) { lanes = new Map(); lockedLanes.set(sql, lanes) }
  lanes.set(lane.id, { owner, token: lane.token, generation: lane.connectionGeneration,
    leaseOwner: locked.lease_owner, agentId: capture.execution.agentId, harness: capture.session.harness,
    sessionId: capture.session.nativeSessionId, leaseMs: locked.lease_ms, expiresAt: locked.expires_at })
  nativeCommitCheck(sql, `lease-renew:${lane.id}`, () => renewWorkflowNativePublicationLease(sql, owner, lane.id))
}

/** The row remains locked continuously; renew the same fence that independent heartbeats cannot reach.
 * Inside a native batch the lease renews once after it is registered, not once per frame. */
export async function renewWorkflowNativePublicationLease(sql: GraphTransactionSql, owner: RunOwnership,
  laneId: string): Promise<void> {
  assertGraphTransaction(sql)
  const lane = lockedLanes.get(sql)?.get(laneId)
  if (!lane) return
  if (lane.owner !== owner) return lost()
  await memoizeNativeRead(sql, `lease-renew:${laneId}`, () => renewLocked(sql, owner, laneId, lane))
}

async function renewLocked(sql: GraphTransactionSql, owner: RunOwnership, laneId: string, lane: LockedLane): Promise<void> {
  await owner.readOneShotFence(sql)
  const renewed = await sql.query<{ expires_at: string }>(`update native_session_lanes set revision=revision+1,updated_at=clock_timestamp(),
    record=jsonb_set(jsonb_set(record,'{revision}',to_jsonb((revision+1)::bigint)),
      '{leaseExpiresAt}',to_jsonb(to_char((clock_timestamp()+($4 * interval '1 millisecond')) at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
    where id=$1 and record->>'leaseToken'=$2 and record->>'connectionGeneration'=$3
      and record->>'leaseOwner'=$5 and owner_agent_id=$6 and harness=$7 and native_session_id=$8
      and record->>'leaseExpiresAt'=$9 returning record->>'leaseExpiresAt' as expires_at`,
  [laneId, lane.token, String(lane.generation), lane.leaseMs, lane.leaseOwner, lane.agentId, lane.harness, lane.sessionId, lane.expiresAt])
  if (renewed.rowCount !== 1) return lost()
  lane.expiresAt = renewed.rows[0]!.expires_at
}
