import type pg from 'pg'
import { CiRunRecordSchema } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { ciGroupState } from './parts.js'
import type { CiRequester } from './requestSharing.js'

/** Only missing-ticket reads need this history; requester and execution indexes scope both ownership paths. */
export async function missingCiTicket(pool: pg.Pool, ticketId: string, workspaceId: string, caller: CiRequester) {
  const rows = (await pool.query<{ record: unknown; created_at: Date | string; states: string[] }>(`
    with requested_ci_groups as (
      select c.group_id,c.created_at from ci_runs c
      where c.workspace_id=$1 and c.record#>>'{initiator,principalId}'=$2
        and ($3::text is null or c.record#>>'{initiator,executionId}'=$3)
      union all
      select c.group_id,c.created_at from ci_group_requesters q
      join ci_runs c on c.workspace_id=q.workspace_id and c.group_id=q.group_id
      where q.workspace_id=$1 and q.principal_id=$2 and ($3::text is null or q.execution_id=$3)
    ), recent_ci_groups as (
      select group_id,min(created_at) as created_at from requested_ci_groups
      group by group_id order by min(created_at) desc,group_id desc limit 5
    )
    select lead.record,recent.created_at,members.states from recent_ci_groups recent
    left join ci_request_groups g on g.group_id=recent.group_id and g.workspace_id=$1
    cross join lateral (
      select c.record from ci_runs c where c.workspace_id=$1 and c.group_id=recent.group_id
      order by (c.id::text=g.output->>'ticketId') desc nulls last,c.created_at,c.id limit 1
    ) lead
    cross join lateral (
      select array_agg(c.state) as states from ci_runs c where c.workspace_id=$1 and c.group_id=recent.group_id
    ) members
    order by recent.created_at desc,recent.group_id desc`,
  [workspaceId, caller.principalId, caller.executionId])).rows
  const recentTickets = rows.map(row => {
    const run = CiRunRecordSchema.parse(row.record)
    return { ticketId: run.id, suite: run.suite, scope: run.scope,
      state: ciGroupState(row.states.map(state => ({ state }))), createdAt: new Date(row.created_at).toISOString() }
  })
  const hints = recentTickets.map(ticket => `${ticket.ticketId} (${ticket.suite} ${ticket.scope}, `
    + `${ticket.state}, ${ticket.createdAt.slice(11, 16)})`).join(', ')
  const message = `No such CI run in this workspace: ${ticketId}.`
    + (hints ? ` Your recent CI tickets: ${hints}.` : ' Your recent CI tickets: none.')
  return new DomainError('CI_RUN_NOT_FOUND', message, 404, { recentTickets })
}
