import { describe, expect, it } from 'vitest'
import { readPublicNodeProjection } from '../src/modules/run-graph/publicProjection.js'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { agent3Database, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'

const historySize = 4000

describe.skipIf(!postgresEnabled)('current Board execution selection', () => {
  it('selects the latest occurrence, activation and retry while excluding interval ticks within a read deadline', async () => {
    const db = await agent3Database()
    try {
      const f = await seedAgent3(db.pool, db.directory)
      const node = agentWorkflowNode(f.version.definition.nodes[0])
      const configurationId = f.version.agentConfigurationVersionIds[node.agentId]!
      await withExclusiveGraphConnection(db.pool, connection => connection.transaction(async sql => {
        // Production readers run over real PostgreSQL history without simulating native execution.
        for (const table of ['harness_executions', 'run_repeat_executions', 'run_repeat_occurrences', 'run_work_activations']) {
          await sql.query(`create temporary table ${table} on commit drop as select * from ${db.schema}.${table} where false`)
        }
        await sql.query('create index on harness_executions(id)')
        await sql.query('create index on run_repeat_executions(run_id,workflow_node_id)')
        await sql.query('create index on run_repeat_occurrences(occurrence_id,run_id)')
        await sql.query('create index on run_work_activations(activation_id,run_id)')
        await sql.query(`insert into harness_executions(id,run_id,workflow_node_id,attempt,record)
          select 'history-'||n,$1,$2,1,jsonb_build_object('agentId',$3::text,
            'agentConfigurationVersionId',$4::text,'state','queued','input','{}'::jsonb)
          from generate_series(1,$5::integer) n`, [f.run.id, node.id, node.agentId, configurationId, historySize])
        await sql.query(`insert into run_repeat_occurrences(occurrence_id,run_id,occurrence_index)
          select 'occurrence-'||n,$1,n from generate_series(1,$2::integer) n`, [f.run.id, historySize])
        await sql.query(`insert into run_repeat_executions(execution_id,run_id,workflow_node_id,occurrence_id,technical_attempt)
          select 'history-'||n,$1,$2,'occurrence-'||n,1 from generate_series(1,$3::integer) n`,
        [f.run.id, node.id, historySize])
        for (const table of ['harness_executions', 'run_repeat_executions', 'run_repeat_occurrences']) {
          await sql.query(`analyze ${table}`)
        }
        await sql.query('set local jit=off')
        await sql.query("set local statement_timeout='1s'")
        const selected = async () => (await readPublicNodeProjection(sql, f.scope, [node.id]))[0]!.state
        expect(await selected()).toMatchObject({ lifecycle: 'queued', execution: { executionId: `history-${historySize}` } })
        await sql.query(`insert into harness_executions(id,run_id,workflow_node_id,attempt,record)
          select 'retry',run_id,workflow_node_id,2,record from harness_executions where id=$1`, [`history-${historySize}`])
        await sql.query(`insert into run_repeat_executions(execution_id,run_id,workflow_node_id,occurrence_id,technical_attempt)
          values('retry',$1,$2,$3,2)`, [f.run.id, node.id, `occurrence-${historySize}`])
        expect(await selected()).toMatchObject({ execution: { executionId: 'retry', attempt: 2 } })
        await sql.query(`insert into run_work_activations(activation_id,run_id,activation_sequence)
          values('older-work',$1,1),('latest-work',$1,2),('tick-work',$1,3)`, [f.run.id])
        for (const id of ['older-work', 'latest-work', 'tick-work']) {
          await sql.query(`insert into harness_executions(id,run_id,workflow_node_id,attempt,record)
            select $1,run_id,workflow_node_id,1,jsonb_set(record,'{input}',$2::jsonb)
            from harness_executions where id='history-1'`, [id, JSON.stringify(id === 'tick-work' ? { tick: 1 } : {})])
          await sql.query(`insert into run_repeat_executions(execution_id,run_id,workflow_node_id,work_activation_id,technical_attempt)
            values($1,$2,$3,$1,1)`, [id, f.run.id, node.id])
        }
        expect(await selected()).toMatchObject({ execution: { executionId: 'latest-work', attempt: 1 } })
        await sql.query(`insert into harness_executions(id,run_id,workflow_node_id,attempt,record)
          select 'latest-retry',run_id,workflow_node_id,2,record from harness_executions where id='latest-work'`)
        await sql.query(`insert into run_repeat_executions(execution_id,run_id,workflow_node_id,work_activation_id,technical_attempt)
          values('latest-retry',$1,$2,'latest-work',2)`, [f.run.id, node.id])
        expect(await selected()).toMatchObject({ execution: { executionId: 'latest-retry', attempt: 2 } })
      }))
    } finally { await db.close() }
  }, 60_000)
})
