import { CiActivitySchema, CiRunRecordSchema, type CiActivity } from '@foreman-code/contracts'

/** Each execution that requested a ticket supplies its own Run and Agent identity. The initiator and shared-requester
 * paths are separate indexed lookups from this Run's executions, so the read never scans the workspace's tickets. */
export const AGENT_CI_SNAPSHOT_SQL = `with requesters as materialized (
    select e.id,e.agent_id,e.workflow_node_id,r.workspace_id,
      coalesce(e.record->>'agentConfigurationVersionId'=r.record->'agentConfigurationVersionIds'->>e.agent_id,false) as pinned
    from harness_executions e join runs r on r.id=e.run_id
    where r.id=$1 and r.workspace_id=$2 and r.workflow_id=$3 and r.workflow_version_id=$4
  ), requested as (
    select c.id,x.id as execution_id from requesters x
      join ci_runs c on c.workspace_id=x.workspace_id and c.record#>>'{initiator,executionId}'=x.id
    union
    select c.id,x.id from requesters x
      join ci_group_requesters q on q.workspace_id=x.workspace_id and q.execution_id=x.id
      join ci_runs c on c.workspace_id=q.workspace_id and c.group_id=q.group_id
  )
  select c.id::text,c.activity_record_revision::text as revision,
    e.id as execution_id,e.agent_id,e.workflow_node_id as node_id,c.record,
    coalesce(c.record->>'id'=c.id::text and c.record->>'workspaceId'=c.workspace_id
      and c.record->>'groupId'=c.group_id::text and c.record->>'state'=c.state and e.pinned,false) as pinned
  from requested m join ci_runs c on c.id=m.id join requesters e on e.id=m.execution_id
  order by c.created_at,c.id,e.id limit 16001`

export function ciActivityFromRecord(record: unknown): CiActivity {
  const run = CiRunRecordSchema.parse(record)
  return CiActivitySchema.parse({
    id: run.id, groupId: run.groupId, suite: run.suite, part: run.part, partition: run.partition,
    state: run.state, queuedAt: run.queuedAt, startedAt: run.startedAt, finishedAt: run.finishedAt,
    computer: run.computer ? { ...run.computer, label: run.computer.label.slice(0, 100) } : null,
    step: run.step?.slice(0, 80) ?? null, exitCode: run.exitCode,
  })
}
