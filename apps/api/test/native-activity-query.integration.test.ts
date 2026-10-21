import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import type { SqlQuery } from '../src/infrastructure/transaction.js'
import { detectStuckExecutions } from '../src/modules/bug-reports/stuckExecutions.js'
import { readNativeActivityFacts, projectNativeActivityFacts } from '../src/modules/runs/nativeActivitySnapshot.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { seedAgent3 } from './helpers/wave25Agent3.js'

interface Plan {
  'Actual Rows': number
  'Actual Loops': number
  'Rows Removed by Filter'?: number
  Plans?: Plan[]
}

function visitedRows(plan: Plan): number {
  if (plan.Plans?.length) return plan.Plans.reduce((sum, child) => sum + visitedRows(child), 0)
  return (plan['Actual Rows'] + (plan['Rows Removed by Filter'] ?? 0)) * plan['Actual Loops']
}

describe.skipIf(!postgresEnabled)('native activity reads with retained PostgreSQL history', () => {
  let database: Awaited<ReturnType<typeof currentDatabase>>
  let pool: pg.Pool
  let fixture: Awaited<ReturnType<typeof seedAgent3>>
  const reads: number[] = []
  const executionId = 'activity-execution'
  const occurredAt = '2026-10-01T00:00:00.000Z'

  beforeEach(async () => {
    database = await currentDatabase()
    fixture = await seedAgent3(database.pool, database.directory)
    const node = agentWorkflowNode(fixture.version.definition.nodes[0])
    const execution = HarnessExecutionSchema.parse({
      id: executionId, runId: fixture.run.id, workflowNodeId: node.id, agentId: node.agentId,
      attempt: 1, state: 'running', input: {}, createdAt: occurredAt, startedAt: occurredAt,
      agentConfigurationVersionId: fixture.version.agentConfigurationVersionIds[node.agentId],
    })
    await database.pool.query(`insert into harness_executions
      (id,run_id,workflow_node_id,agent_id,attempt,record,created_at)
      values($1,$2,$3,$4,1,$5::jsonb,$6::timestamptz)`,
    [executionId, fixture.run.id, node.id, node.agentId, JSON.stringify(execution), occurredAt])
    await database.pool.query(`update runs set execution_state='running',
      record=jsonb_set(record,'{executionState}','"running"') where id=$1`, [fixture.run.id])
    // Execution insertion publishes activity at wall-clock time; keep this fixture's clock consistent.
    await database.pool.query('update run_activity set occurred_at=$1::timestamptz where harness_execution_id=$2',
      [occurredAt, executionId])
    reads.length = 0
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1,
      options: `-c search_path=${database.schema} -c statement_timeout=10000 -c lock_timeout=5000` })
    pool.on('connect', client => {
      const original = client.query.bind(client)
      const query: SqlQuery['query'] = async (text, values) => {
        if (/^\s*(select|with)\b/i.test(text)) {
          const explained = await original<{ 'QUERY PLAN': { Plan: Plan }[] }>(
            `explain (analyze, format json) ${text}`, values,
          )
          reads.push(visitedRows(explained.rows[0]!['QUERY PLAN'][0]!.Plan))
        }
        return original(text, values)
      }
      client.query = query as typeof client.query
    })
  }, 60_000)

  afterEach(async () => {
    try { await pool?.end() } finally { await database?.close() }
  })

  async function readFacts() {
    const client = await pool.connect()
    try { return await readNativeActivityFacts(client, fixture.run.id) } finally { client.release() }
  }

  const resolve: Parameters<typeof projectNativeActivityFacts>[1] = () => ({
    owner: { kind: 'run', workspaceId: fixture.run.workspaceId, workflowId: fixture.run.workflowId,
      runId: fixture.run.id, workflowVersionId: fixture.run.workflowVersionId },
    harness: 'codex', sessionId: 'session', terminal: false,
  })

  it('reads latest identities across sessions and generations without revisiting their updates', async () => {
    await database.pool.query(`insert into harness_native_events(execution_id,sequence,record)
      select $1,n,jsonb_build_object('type','item.started','occurredAt',$2::text,
        'payload',jsonb_build_object('threadId','session','item',jsonb_build_object(
          'id','command','type','commandExecution','command','build private-input','status','running')))
      from generate_series(1,6000) n`, [executionId, occurredAt])
    await database.pool.query(`insert into harness_native_events(execution_id,sequence,record) values
      ($1,6001,'{"type":"item.completed","occurredAt":"2026-10-01T00:01:00Z",
        "payload":{"threadId":"session","item":{"id":"command","type":"commandExecution","status":"completed"}}}'),
      ($1,6002,'{"type":"claude.tool","occurredAt":"2026-10-01T00:02:00Z",
        "payload":{"nativeSessionId":"child","toolUseId":"command","name":"Read","status":"running"}}'),
      ($1,6003,'{"type":"item.started","occurredAt":"2026-10-01T00:03:00Z",
        "payload":{"threadId":"session","runtimeGeneration":"second","item":{
          "id":"command","type":"commandExecution","status":"running","command":"inspect private-body"}}}')`,
    [executionId])
    await database.pool.query('analyze harness_native_events')
    const facts = await readFacts()
    expect(facts.map(row => row.sequence)).toEqual(['6001', '6002', '6003'])
    const projected = projectNativeActivityFacts(facts, resolve)
    expect(projected.activities).toMatchObject([
      { kind: 'tool', status: 'completed' }, { kind: 'tool', status: 'running' }, { kind: 'tool', status: 'running' },
    ])
    expect(projected.active).toHaveLength(2)
    expect(JSON.stringify(projected)).not.toContain('private-body')
    expect(reads.length).toBeGreaterThan(0)
    expect(Math.max(...reads)).toBeLessThan(64)
  })

  it('retains old unfinished tools beyond the completed page and bounds hydration', async () => {
    await database.pool.query(`insert into harness_native_events(execution_id,sequence,record)
      select $1,n,jsonb_build_object('type','item.started','occurredAt',$2::text,
        'payload',jsonb_build_object('item',jsonb_build_object('id','item-'||n,'type','commandExecution',
          'status',case when n=1 then 'running' else 'completed' end)))
      from generate_series(1,1201) n`, [executionId, occurredAt])
    await database.pool.query('analyze harness_native_events')
    const facts = await readFacts()
    expect(facts).toHaveLength(1001)
    expect(facts[0]).toMatchObject({ item_id: 'item-1', status: 'running', sequence: '1' })
    const projected = projectNativeActivityFacts(facts, resolve)
    expect(projected.active).toHaveLength(1)
    expect(projected.hasMore).toBe(false)
  })

  it('uses the newest activity instant despite out-of-order timestamps without scanning history', async () => {
    await database.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record)
      values('00000000-0000-4000-8000-000000000001',$1,'00000000-0000-4000-8000-000000000002','passed',
        jsonb_build_object('initiator',jsonb_build_object('executionId',$2::text),
          'queuedAt',$3::text,'finishedAt','2026-10-01T00:00:01Z'))`,
    [fixture.run.workspaceId, executionId, occurredAt])
    await database.pool.query(`insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
      select $1,'backend','native',$2,$3::timestamptz,'{}'::jsonb from generate_series(1,6000)`,
    [fixture.run.id, executionId, occurredAt])
    await database.pool.query(`insert into harness_native_events(execution_id,sequence,record)
      select $1,n,jsonb_build_object('type','notification','occurredAt',$2::text)
      from generate_series(1,6000) n`, [executionId, occurredAt])
    await database.pool.query(`insert into harness_native_events(execution_id,sequence,record) values
      ($1,6001,'{"type":"notification","occurredAt":"2026-10-01T02:30:00+02:00"}'),
      ($1,6002,'{"type":"notification","occurredAt":"2026-10-01T00:10:00Z"}')`, [executionId])
    await database.pool.query(`insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
      values($1,'backend','native',$2,'2026-10-01T00:20:00Z','{}'::jsonb)`, [fixture.run.id, executionId])
    await database.pool.query('analyze run_activity')
    await database.pool.query('analyze harness_native_events')
    const idleMs = 3_600_000
    expect(await detectStuckExecutions(pool, idleMs, new Date('2026-10-01T01:00:00Z'))).toBe(0)
    expect(await detectStuckExecutions(pool, idleMs, new Date('2026-10-01T01:30:00Z'))).toBe(1)
    const reports = await database.pool.query<{ record: { happened: { message: string } } }>('select record from bug_reports')
    expect(reports.rows).toHaveLength(1)
    expect(reports.rows[0]!.record.happened.message).toContain('2026-10-01T00:30:00.000Z')
    expect(await detectStuckExecutions(pool, idleMs, new Date('2026-10-01T02:30:00Z'))).toBe(0)
    expect(reads.length).toBeGreaterThan(0)
    expect(Math.max(...reads)).toBeLessThan(64)
  })
})
