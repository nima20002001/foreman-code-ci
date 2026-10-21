import type { HarnessExecution } from '@foreman-code/contracts'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'
import { PUBLIC_UNSETTLED_REVIEW_SQL } from '../run-graph/publicObligations.js'

/** A detached latest lifetime still owns its process; an older detached lifetime can be superseded. */
const openCheckoutLifetimeSql = `
  exists(select 1 from execution_native_closures c where c.execution_id=writer.id and c.closed_at is null
    and (c.detached_at is null or not exists(select 1 from execution_native_closures newer
      where newer.execution_id=c.execution_id and newer.generation>c.generation)))
`

export const outstandingCheckoutReviewSql = `(${openCheckoutLifetimeSql})
  or exists(select 1 from review_jobs j where j.execution_id=writer.id
    and (j.state is distinct from j.record->>'state' or (${PUBLIC_UNSETTLED_REVIEW_SQL})
      or j.record->'cleanup'->>'nativeState'='pending' or j.record->'cleanup'->>'credentialState'='pending'))
`

/** Caller holds the Run mutation lock, shared with checkout allocation and cleanup claims. */
export async function assertReviewerCheckoutAvailable(sql: GraphSqlClient,
  execution: Pick<HarnessExecution, 'id' | 'runId' | 'workingDirectory'>): Promise<void> {
  const unavailable = await sql.query(`select 1 from run_worktrees target where target.run_id=$1
    and (target.allocation_id=$2 or (target.allocation_id='' and target.record->>'workingDirectory'=$3))
    and (target.record->>'state'<>'active' or exists(
      select 1 from harness_executions writer where writer.run_id=target.run_id and writer.id<>$2
        and (writer.record->>'workingDirectory'=target.record->>'workingDirectory'
          or exists(select 1 from run_worktrees used where used.run_id=target.run_id
            and used.checkout_root=target.checkout_root and used.allocation_id=writer.id))
        and (writer.record->>'state'<>'completed'
          or exists(select 1 from execution_native_sessions n where n.execution_id=writer.id
            and n.workflow_finalized_at is null)
          or (writer.record->>'nativeSessionId' is not null and not exists(
            select 1 from execution_native_sessions n where n.execution_id=writer.id
              and n.workflow_finalized_at is not null))
          or (${openCheckoutLifetimeSql})))) limit 1`,
  [execution.runId, execution.id, execution.workingDirectory ?? null])
  if (unavailable.rows.length) {
    throw new DomainError('SESSION_LANE_BUSY', 'The reviewer checkout is in use by another execution or cleanup.', 409)
  }
}
