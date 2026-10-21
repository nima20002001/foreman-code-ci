import { JobQueueTicketSchema } from '@foreman-code/contracts/job-admission'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'

/** A terminal ticket and its live Job owner authorize closure of this attempt only. */
export async function requireQueuedPreparationClosed(sql: GraphSqlClient, ticketId: string) {
  const row = (await sql.query<{ record: unknown; owned: boolean }>(`select q.record,
    exists(select 1 from pg_stat_activity a where a.pid::text=q.owner_id
      and (extract(epoch from a.backend_start)*1000000)::bigint::text=q.owner_fence
      and exists(select 1 from pg_locks l where l.pid=a.pid and l.locktype='advisory'
        and l.classid=810038::oid and l.objid=(hashtext(q.execution_id)::bigint & 4294967295)::oid
        and l.objsubid=2 and l.mode='ExclusiveLock' and l.granted)) as owned
    from job_admission_queue q where q.id=$1
      and not exists(select 1 from job_executions e where e.id=q.execution_id or e.operation_id=q.operation_id)
    for share of q`, [ticketId])).rows[0]
  if (!row?.owned) throw new DomainError('SOURCE_PREPARATION_ACTIVE', 'Queued cleanup requires its original Job owner.', 409)
  const ticket = JobQueueTicketSchema.parse(row.record)
  if (ticket.state !== 'terminal' || ticket.reservationId !== ticket.id) {
    throw new DomainError('SOURCE_PREPARATION_ACTIVE', 'Only a closed claimed queue attempt can be cleaned up.', 409)
  }
  return ticket
}
