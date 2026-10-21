import { describe, expect, it } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { withExclusiveGraphConnection, type GraphTransactionSql } from '../src/modules/run-graph/connection.js'
import { readCurrentNativeActivities } from '../src/modules/run-graph/currentActivity.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'

const tables = [
  'harness_executions', 'run_repeat_executions', 'run_repeat_occurrences',
  'run_work_activations', 'run_native_activity', 'review_jobs',
] as const

async function activityReadModel(sql: GraphTransactionSql, schema: string) {
  // Copy production column types into transaction-local reader fixtures; no execution or publication is simulated.
  for (const table of tables) {
    await sql.query(`create temporary table ${table} on commit drop as select * from ${schema}.${table} where false`)
  }
  await sql.query('create index on harness_executions(id)')
  await sql.query('create index on run_repeat_executions(run_id,workflow_node_id)')
  await sql.query('create index on run_repeat_occurrences(occurrence_id,run_id)')
  await sql.query('create index on run_work_activations(activation_id,run_id)')
  await sql.query('create index on run_native_activity(execution_id,work_kind,work_id)')
  await sql.query('create index on review_jobs(id,execution_id)')
}

describe.skipIf(!postgresEnabled)('current native activity with retained execution history', () => {
  it('reads only latest non-tick work and open reviews within a database deadline', async () => {
    const db = await currentDatabase()
    const fixture = makeCurrentWorkflowFixture('activity-history')
    const node = agentWorkflowNode(fixture.version.definition.nodes[0])
    const historySize = 4000
    const configurationId = fixture.version.agentConfigurationVersionIds[node.agentId]!
    try {
      await withExclusiveGraphConnection(db.pool, connection => connection.transaction(async sql => {
        await activityReadModel(sql, db.schema)
        await sql.query(`insert into harness_executions(id,run_id,record)
          select 'history-'||n,$1,jsonb_build_object('agentId',$2::text,
            'agentConfigurationVersionId',$3::text,'state','queued','input','{}'::jsonb)
          from generate_series(1,$4::integer) n`, [fixture.scope.runId, node.agentId, configurationId, historySize])
        await sql.query(`insert into run_repeat_occurrences(occurrence_id,run_id,occurrence_index)
          select 'occurrence-'||n,$1,n from generate_series(1,$2::integer) n`, [fixture.scope.runId, historySize])
        await sql.query(`insert into run_repeat_executions(execution_id,run_id,workflow_node_id,
          occurrence_id,technical_attempt)
          select 'history-'||n,$1,$2,'occurrence-'||n,1 from generate_series(1,$3::integer) n`,
        [fixture.scope.runId, node.id, historySize])
        await sql.query(`insert into run_native_activity(execution_id,run_id,workflow_node_id,attempt,
          work_kind,work_id,activity,projection_revision)
          select 'history-'||n,$1,$2,1,'workflow','history-'||n,
            jsonb_build_object('workflowNodeId',$2::text,'status','none'),1
          from generate_series(1,$3::integer) n`, [fixture.scope.runId, node.id, historySize])
        await sql.query(`insert into review_jobs(id,execution_id,record)
          values('open-review','history-1','{"state":"running"}'::jsonb)`)
        await sql.query(`insert into run_native_activity(execution_id,run_id,workflow_node_id,attempt,
          work_kind,work_id,activity,projection_revision)
          values('history-1',$1,$2,1,'review','open-review',
            jsonb_build_object('workflowNodeId',$2::text,'status','unknown'),1)`, [fixture.scope.runId, node.id])
        for (const table of tables) await sql.query(`analyze ${table}`)
        await sql.query('set local jit=off')
        // A retained row must not rerun a scan and sort of the entire execution history.
        await sql.query("set local statement_timeout='1s'")
        const read = () => readCurrentNativeActivities(sql, fixture.scope, [node.id])
        const identities = async () => (await read()).map(item => item.key.workId).sort()
        expect(await identities()).toEqual([`history-${historySize}`, 'open-review'].sort())
        expect(await readCurrentNativeActivities(sql, fixture.scope, ['another-node'])).toEqual([])

        // An admitted occurrence without native activity must suppress older workflow activity.
        await sql.query(`insert into run_repeat_occurrences(occurrence_id,run_id,occurrence_index)
          values('not-started-occurrence',$1,$2)`, [fixture.scope.runId, historySize + 1])
        await sql.query(`insert into harness_executions(id,run_id,record)
          select 'not-started',run_id,record from harness_executions where id='history-1'`)
        await sql.query(`insert into run_repeat_executions(execution_id,run_id,workflow_node_id,
          occurrence_id,technical_attempt) values('not-started',$1,$2,'not-started-occurrence',1)`,
        [fixture.scope.runId, node.id])
        expect(await identities()).toEqual(['open-review'])

        // Work activations take precedence over repeat occurrences, but interval ticks do not replace workflow work.
        await sql.query(`insert into run_work_activations(activation_id,run_id,activation_sequence)
          values('work',$1,1),('tick-work',$1,2)`, [fixture.scope.runId])
        await sql.query(`insert into harness_executions(id,run_id,record)
          select 'work',run_id,record from harness_executions where id='history-1'`)
        await sql.query(`insert into harness_executions(id,run_id,record)
          select 'tick',run_id,jsonb_set(record,'{input}','{"tick":1}'::jsonb)
          from harness_executions where id='history-1'`)
        await sql.query(`insert into run_repeat_executions(execution_id,run_id,workflow_node_id,
          work_activation_id,technical_attempt) values('work',$1,$2,'work',1),('tick',$1,$2,'tick-work',1)`,
        [fixture.scope.runId, node.id])
        await sql.query(`insert into run_native_activity(execution_id,run_id,workflow_node_id,attempt,
          work_kind,work_id,activity,projection_revision)
          select id,run_id,$1,1,'workflow',id,jsonb_build_object('workflowNodeId',$1::text,'status','none'),1
          from harness_executions where id in ('work','tick')`, [node.id])
        expect(await identities()).toEqual(['open-review', 'work'])
        await sql.query(`update review_jobs set record='{"state":"completed"}'::jsonb where id='open-review'`)
        await sql.query(`update run_native_activity set activity=jsonb_build_object('workflowNodeId',$1::text,'status','none')
          where work_id='open-review'`, [node.id])
        expect(await identities()).toEqual(['work'])
      }))
    } finally {
      await db.close()
    }
  }, 60000)
})
