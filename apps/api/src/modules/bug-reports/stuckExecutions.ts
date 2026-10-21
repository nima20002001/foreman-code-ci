import type pg from 'pg'
import { BugReportSchema } from '@foreman-code/contracts/management'
import { withTransaction } from '../../infrastructure/transaction.js'
import { recordBugReport } from './repository.js'

interface StuckExecution {
  id: string
  run_id: string
  workspace_id: string
  workflow_id: string
  last_activity_at: Date
  ticket_count: string
}

/** Background reporting uses persisted facts, independently of any Agent's MCP permissions. */
export async function detectStuckExecutions(pool: pg.Pool, idleMs: number, now: Date): Promise<number> {
  return withTransaction(pool, async sql => {
    const cutoff = new Date(now.getTime() - idleMs)
    const executions = (await sql.query<StuckExecution>(`
      select e.id,e.run_id,r.workspace_id,r.workflow_id,ci.ticket_count,activity.last_activity_at
      from harness_executions e join runs r on r.id=e.run_id
      cross join lateral (
        select count(*) as ticket_count,bool_and(c.state in ('passed','failed','canceled','lost')) as all_terminal,
          max(greatest((c.record->>'queuedAt')::timestamptz,(c.record->>'finishedAt')::timestamptz)) as last_activity_at
        -- Find the execution's tickets by index; a workspace's other tickets are never read.
        from ci_runs c where c.id in (
          select i.id from ci_runs i where i.workspace_id=r.workspace_id and i.record#>>'{initiator,executionId}'=e.id
          union
          select g.id from ci_group_requesters q join ci_runs g on g.workspace_id=q.workspace_id and g.group_id=q.group_id
            where q.workspace_id=r.workspace_id and q.execution_id=e.id)
      ) ci
      cross join lateral (
        select greatest(e.created_at,(e.record->>'startedAt')::timestamptz,
          (select a.occurred_at from run_activity a where a.run_id=e.run_id and a.harness_execution_id=e.id
            order by a.occurred_at desc limit 1),
          (select n.occurred_at from harness_native_events n where n.execution_id=e.id and n.occurred_at is not null
            order by n.occurred_at desc limit 1),
          ci.last_activity_at) as last_activity_at
      ) activity
      where e.record->>'state'='running' and r.execution_state in ('running','waiting')
        and r.stop_requested_at is null and ci.ticket_count>0 and ci.all_terminal
        and not exists(select 1 from bug_reports b where b.id='bug-report-stuck-'||e.id)
        and activity.last_activity_at<=$1
      order by e.created_at,e.id limit 100 for update of e skip locked`, [cutoff])).rows
    let reported = 0
    for (const execution of executions) {
      const id = `bug-report-stuck-${execution.id}`
      if ((await sql.query('select 1 from bug_reports where id=$1', [id])).rowCount) continue
      const at = now.toISOString()
      const report = BugReportSchema.parse({
        id,
        workspaceId: execution.workspace_id,
        workflowId: execution.workflow_id,
        runId: execution.run_id,
        title: `Agent execution ${execution.id} appears stuck`,
        tried: { feature: 'Agent execution', inputsSummary: `Execution ${execution.id} in Run ${execution.run_id}.` },
        happened: { errorCode: 'AGENT_EXECUTION_STUCK', message:
          `No output or activity since ${execution.last_activity_at.toISOString()} while all `
          + `${execution.ticket_count} CI tickets are terminal. The execution is still running.` },
        expected: 'The Agent should produce activity or finish after its CI tickets end.',
        severity: 'high', status: 'open', revision: 1, occurrenceCount: 1,
        reporter: { principalId: 'stuck-execution-detector', name: 'Execution monitor', audience: 'operator' },
        harness: null, createdAt: at, updatedAt: at, lastReportedAt: at,
      })
      await recordBugReport(sql, report)
      await sql.query(`insert into management_audit(source,action,target_key,outcome,details)
        values('backend','bug_reports.report',$1,'succeeded',$2::jsonb)`,
      [report.id, JSON.stringify({ executionId: execution.id, runId: execution.run_id, code: 'AGENT_EXECUTION_STUCK' })])
      reported += 1
    }
    return reported
  })
}
