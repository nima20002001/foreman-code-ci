import { CI_RUN_JOBS_LIMIT, CiRunRecordSchema, CiTestResultsSchema, CiTestSummarySchema,
  type CiPlacement, type CiRunJob, type CiTestResults, type CiTestStatus } from '@foreman-code/contracts'
import { ciActivityFromRecord } from '../runs/agentCiSnapshot.js'

/** Every CI ticket an Agent execution of the Run requested, newest first, with the requesting Agent's node. A ticket of a
 * group the Agent joined as an identical request is listed under that Agent too. */
export const RUN_CI_JOBS_SQL = `select c.record,c.test_results->'summary' as tests,e.id as execution_id,e.agent_id,
  e.workflow_node_id as node_id,coalesce((select coalesce(n->>'name',n->>'label') from jsonb_array_elements(
    case when jsonb_typeof(v.record#>'{definition,nodes}')='array' then v.record#>'{definition,nodes}' else '[]'::jsonb end) n
    where n->>'id'=e.workflow_node_id limit 1),e.workflow_node_id) as node_name
  from harness_executions e join runs r on r.id=e.run_id and r.workspace_id=$1
  join lateral (select c.record,c.test_results,c.created_at,c.id from ci_runs c
      where c.workspace_id=r.workspace_id and c.record#>>'{initiator,executionId}'=e.id
    union all select c.record,c.test_results,c.created_at,c.id from ci_group_requesters q
      join ci_runs c on c.workspace_id=q.workspace_id and c.group_id=q.group_id
      where q.workspace_id=r.workspace_id and q.execution_id=e.id and not q.initiator) c on true
  left join workflow_versions v on v.id=r.workflow_version_id
  where e.run_id=$2 and ($3::text is null or e.id=$3) order by c.created_at desc,c.id desc limit ${CI_RUN_JOBS_LIMIT + 1}`

export interface RunCiJobRow { record: unknown; tests: unknown; execution_id: string; agent_id: string; node_id: string; node_name: string }

export function ciPlacement(computer: { hostRef: { kind: string; provider?: string | undefined } } | null): CiPlacement | null {
  if (!computer) return null
  if (computer.hostRef.kind !== 'cloud') return 'host'
  return computer.hostRef.provider === 'circleci' ? 'circleci' : 'github'
}

export function runCiJob(row: RunCiJobRow): CiRunJob {
  const run = CiRunRecordSchema.parse(row.record)
  const tests = CiTestSummarySchema.safeParse(row.tests)
  return { ticketId: run.id, ci: ciActivityFromRecord(run), scope: run.scope, placement: ciPlacement(run.computer),
    message: run.message?.slice(0, 2000) ?? null,
    requester: { executionId: row.execution_id, agentId: row.agent_id, nodeId: row.node_id.slice(0, 200),
      nodeName: row.node_name.slice(0, 200) },
    tests: tests.success ? tests.data : null, ...(run.collection ? { collection: run.collection } : {}) }
}

/** Stored results limited to tests with the given statuses. A file is also kept when its own status matches,
 * even without matching assertions. The summary still counts every test. */
export function storedCiTestResults(stored: unknown, statuses?: readonly CiTestStatus[]): CiTestResults | null {
  const parsed = stored ? CiTestResultsSchema.safeParse(stored) : null
  if (!parsed?.success) return null
  if (!statuses) return parsed.data
  const wanted = new Set(statuses)
  const files = parsed.data.files.flatMap(file => {
    const tests = file.tests.filter(test => wanted.has(test.status))
    return tests.length || wanted.has(file.status) ? [{ ...file, tests }] : []
  })
  return { ...parsed.data, files }
}
