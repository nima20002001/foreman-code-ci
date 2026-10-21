import type pg from 'pg'
import { outstandingCheckoutReviewSql } from './worktreeReviewers.js'

export interface WorktreeAllocationRow {
  repository_root: string
  record: unknown
  checkout_root: string
  cleanup_attempts: number
}

/** Reuse only after every writer using this physical checkout has finalized its native lifetime. */
export async function reuseRunCheckout(sql: Pick<pg.PoolClient, 'query'>, runId: string, executionId: string) {
  const result = await sql.query<WorktreeAllocationRow>(`with candidate as (
    select w.* from run_worktrees w
      join harness_executions previous on previous.id=w.allocation_id and previous.run_id=w.run_id
      join harness_executions incoming on incoming.id=$2 and incoming.run_id=w.run_id
    where w.run_id=$1 and w.record->>'state'='active'
      and previous.workflow_node_id=incoming.workflow_node_id and previous.agent_id=incoming.agent_id
      and previous.record->>'agentConfigurationVersionId'=incoming.record->>'agentConfigurationVersionId'
      and previous.record->>'workingDirectory'=w.record->>'workingDirectory'
      and previous.record->>'state'='completed'
      and not exists(select 1 from harness_executions writer where writer.run_id=w.run_id
        and (writer.record->>'workingDirectory'=w.record->>'workingDirectory'
          or exists(select 1 from run_worktrees used where used.run_id=w.run_id
            and used.checkout_root=w.checkout_root and used.allocation_id=writer.id))
        and (writer.record->>'state'<>'completed'
          or exists(select 1 from execution_native_sessions n where n.execution_id=writer.id
            and n.workflow_finalized_at is null)
          or (writer.record->>'nativeSessionId' is not null and not exists(
            select 1 from execution_native_sessions n where n.execution_id=writer.id
              and n.workflow_finalized_at is not null))
          or (${outstandingCheckoutReviewSql})))
    order by previous.created_at desc,previous.id desc limit 1
  ) insert into run_worktrees(run_id,allocation_id,repository_root,checkout_root,record)
    select run_id,$2,repository_root,checkout_root,record||jsonb_build_object('executionId',$2::text)
      from candidate
    returning repository_root,record,checkout_root,cleanup_attempts`, [runId, executionId])
  return result.rows[0]
}

/** Both sweep selection and the locked recheck use the same physical-checkout lifetime rules. */
export const runWorktreeCleanupCondition = `
  w.record->>'state' in ('active','preparing','retained') and w.cleanup_after <= $1
  and not exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending)
  and not exists(select 1 from harness_executions writer where writer.run_id=r.id
    and (writer.record->>'workingDirectory'=w.record->>'workingDirectory'
      or exists(select 1 from run_worktrees used where used.run_id=r.id
        and used.checkout_root=w.checkout_root and used.allocation_id=writer.id))
    and ((writer.record->>'state'<>'completed' and r.execution_state not in ('completed','interrupted'))
      or exists(select 1 from execution_native_sessions n where n.execution_id=writer.id
        and n.workflow_finalized_at is null)
      or (writer.record->>'nativeSessionId' is not null and not exists(
        select 1 from execution_native_sessions n where n.execution_id=writer.id
          and n.workflow_finalized_at is not null))
      or (${outstandingCheckoutReviewSql})))
  and (r.execution_state in ('completed','interrupted') or exists(
    select 1 from harness_executions owner
      join harness_executions newer on newer.run_id=owner.run_id
        and newer.workflow_node_id=owner.workflow_node_id
      join run_worktrees replacement on replacement.run_id=newer.run_id and replacement.allocation_id=newer.id
    where owner.run_id=r.id and owner.id=w.allocation_id
      and replacement.record->>'state'='active' and replacement.checkout_root<>w.checkout_root
      and (newer.created_at,newer.id)>(owner.created_at,owner.id)
      and not exists(select 1 from run_worktrees used
        join harness_executions last_use on last_use.run_id=used.run_id and last_use.id=used.allocation_id
        where used.run_id=r.id and used.checkout_root=w.checkout_root
          and (last_use.created_at,last_use.id)>=(newer.created_at,newer.id))))
`
