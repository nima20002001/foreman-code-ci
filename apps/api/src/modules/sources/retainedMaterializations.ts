import type { GraphSqlClient } from '../run-graph/connection.js'
import type { SourceReservation } from './reservations.js'

/** Published files and snapshots have independent retention; this selects only disposable execution copies. */
export async function oldestRetainedMaterialization(sql: GraphSqlClient, scopeId: string,
  reservationId?: string, excludedIds: readonly string[] = []) {
  return (await sql.query<{ reservation_id: string; owner_id: string; retry: SourceReservation['cleanupRetry'] }>(`
    select s.reservation_id,s.owner_id,s.record->'cleanupRetry' as retry
    from source_storage_reservations s
      join source_execution_materializations m using(reservation_id)
      join harness_executions e on e.id=m.execution_id
      join runs r on r.id=e.run_id
    where s.scope_id=$1 and s.owner_kind='materialization' and s.reserved_bytes>0
      and (s.state='retained' or ($2::uuid is not null and s.state='uncertain'
        and s.record#>>'{reclamation,removeRetained}'='true'))
      and ($2::uuid is null or s.reservation_id=$2::uuid)
      and s.reservation_id<>all($3::uuid[])
      and ($2::uuid is not null or coalesce(s.record#>>'{cleanupRetry,nextAttemptAt}','')<=$4)
      and m.state='closed' and e.record->>'state'='completed' and r.execution_state='completed'
      and m.record#>'{receipt,quota}' is null
      and (m.record#>'{receipt,worktree}' is null or m.worktree_cleanup->>'state'='removed')
      and (m.record#>'{receipt,sharedTree}' is null or m.record#>'{receipt,worktree}' is not null)
      and not exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending)
      and not exists(select 1 from source_preparation_reconciliations c
        where c.operation_id::text=s.owner_id and c.status<>'closed')
      and not exists(select 1 from durable_interactions i where i.run_id=r.id
        and i.status not in ('delivered','canceled'))
      and not exists(select 1 from review_jobs j left join durable_interactions i on i.id=j.interaction_id
        where (j.execution_id=e.id or i.run_id=r.id) and j.state<>'completed'
          and (j.state<>'failed' or j.record#>>'{cleanup,completedAt}' is null))
      and not exists(select 1 from source_execution_materializations other
        join source_storage_reservations other_storage on other_storage.reservation_id=other.reservation_id
        where other.materialization_id<>m.materialization_id and other_storage.state<>'reclaimed'
          and other.record#>>'{receipt,binding,canonicalPath}'=m.record#>>'{receipt,binding,canonicalPath}'
          and other.record#>>'{receipt,sharedTree,id}'=m.record#>>'{receipt,sharedTree,id}')
    order by m.record#>>'{receipt,verifiedAt}',m.materialization_id limit 1`,
  [scopeId, reservationId ?? null, excludedIds, new Date().toISOString()])).rows[0]
}
