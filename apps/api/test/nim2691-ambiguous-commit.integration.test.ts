import assert from 'node:assert/strict'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { makeCurrentWorkflowFixture, WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { ExclusiveGraphConnection, type GraphTransactionSql } from '../src/modules/run-graph/connection.js'
import { RepeatRunRepository, type RepeatRepositoryHost } from '../src/modules/runs/repeatPostgres.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { digest, text, transaction } from './eng04-migration-fixtures.js'
import { nim2691TaskDatabase } from './helpers/nim2691Database.js'

const enabled = process.env.NIM2691_POSTGRES === '1'

describe.skipIf(!enabled)('NIM-2691 ambiguous admission COMMIT', () => {
  it('recovers one committed request after its reply is lost, without a second charge or destination launch', async () => {
    await nim2691TaskDatabase(async (pool, _directory, connectionString) => {
      await applyApplicationMigrations(pool)
      const fixture = makeCurrentWorkflowFixture('nim2691-unknown-commit')
      const source = fixture.version.definition.nodes[0]!, edge = fixture.version.definition.edges[0]!
      const version = WorkflowVersionV3Schema.parse({ ...fixture.version, definition: {
        ...fixture.version.definition, handoffs: { contractVersion: 1 },
        executionPolicy: { maxParallelism: 1, maxNodeExecutions: 3 },
        nodes: [{ ...source, choice: { outcomes: [
          { outcome: 'review', target: { kind: 'edge', relationshipId: edge.id } },
        ] } }, fixture.version.definition.nodes[1]],
        edges: [{ ...edge, maxWorkHandoffsPerRun: 3 }],
      } })
      const run = { ...fixture.run, executionState: 'running' as const }
      const activationId = 'activation-source', executionId = 'execution-source'
      const result = { outcome: 'succeeded', output: { routing: { kind: 'request', outcome: 'review' },
        data: { latestDeliverable: { revision: 1 }, remainingFindings: [] } } }
      await transaction(pool, async (sql) => {
        await sql.query('insert into workspaces(id,record) values($1,$2::jsonb)',
          [run.workspaceId, text({ id: run.workspaceId })])
        await sql.query('insert into workflows(id,workspace_id,record) values($1,$2,$3::jsonb)',
          [run.workflowId, run.workspaceId, text({ id: run.workflowId, workspaceId: run.workspaceId })])
        for (const config of fixture.configurations) {
          await sql.query('insert into agents(id,workspace_id,record) values($1,$2,$3::jsonb)',
            [config.agentId, run.workspaceId, text({ id: config.agentId, workspaceId: run.workspaceId })])
          await sql.query(`insert into agent_configuration_versions(id,workspace_id,agent_id,version,record)
            values($1,$2,$3,1,$4::jsonb)`, [config.id, run.workspaceId, config.agentId, text(config)])
        }
        await sql.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,execution_semantics_version,record)
          values($1,$2,$3,1,$4,3,$5::jsonb)`, [version.id, run.workspaceId, run.workflowId, version.entryNodeId, text(version)])
        await sql.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
          values($1,$2,$3,$4,'running',$5::jsonb)`, [run.id, run.workspaceId, run.workflowId, version.id, text(run)])
        const activation = { scope: fixture.scope, activationId, workflowNodeId: source.id,
          lineageId: run.id, cause: { kind: 'entry' } }
        await sql.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,
          cause_kind,cause_id,state,record) values($1,$2,$3,$4,'entry',$2,'completed',$5::jsonb)`,
        [activationId, run.id, version.id, source.id, text(activation)])
        const execution = { id: executionId, runId: run.id, workflowNodeId: source.id,
          agentId: source.agentId, agentConfigurationVersionId: version.agentConfigurationVersionIds[source.agentId],
          attempt: 1, input: {}, state: 'completed', result,
          createdAt: fixture.createdAt, finishedAt: fixture.createdAt }
        await sql.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,accepted,record,work_activation_id)
          values($1,$2,$3,$4,1,true,$5::jsonb,$6)`,
        [executionId, run.id, source.id, source.agentId, text(execution), activationId])
        await sql.query(`insert into run_work_results(execution_id,run_id,activation_id,result_json,result_digest,accepted_at)
          values($1,$2,$3,$4,$5,clock_timestamp())`,
        [executionId, run.id, activationId, text(result), digest(result)])
      })
      const host: RepeatRepositoryHost = { openLocked: async () => ({ run,
        // These hooks isolate the transaction/receipt boundary; this does not
        // claim native submission, grant or canonical graph publication proof.
        assertAuthorityLocked: async () => undefined,
        assertAdmissionLocked: async () => undefined,
        assertSettlementLocked: async () => undefined,
        allowTechnicalRetryLocked: async () => false,
        publishLocked: async () => { throw new Error('Unexpected native publication') },
        assertPublicationReceiptLocked: async () => { throw new Error('Unexpected native receipt') },
        completeRunLocked: async () => { throw new Error('Unexpected completion') },
      }) }
      const raw = new pg.Client({ connectionString })
      await raw.connect()
      await raw.query('select pg_advisory_lock($1,hashtext($2))', [810_002, run.id])
      let replyLost = false, connected = true
      const proxy = { query: async (statement: string, values?: unknown[]) => {
        const result = await raw.query(statement, values)
        if (statement === 'commit' && !replyLost) { replyLost = true; throw new Error('COMMIT_REPLY_LOST') }
        return result
      } } as unknown as pg.ClientBase
      const connection = new ExclusiveGraphConnection(proxy, () => {
        if (!connected) throw new Error('OWNER_LOST')
      })
      const owner = { runId: run.id, assertOwned: () => { if (!connected) throw new Error('OWNER_LOST') },
        oneShotConnection: () => connection,
        readOneShotFence: async (sql: GraphTransactionSql) => {
          const row = (await sql.query<{ owner_id: string }>('select pg_backend_pid()::text as owner_id')).rows[0]
          assert.ok(row)
          return { ownerId: row.owner_id, fence: '1' }
        },
      }
      try {
        const store = new RepeatRunRepository(owner, host, version)
        await expect(store.admitWorkRequest(executionId)).rejects.toThrow('COMMIT_REPLY_LOST')
        expect(connection.unusable).toBe(true)
        expect((await pool.query<{ used: number }>('select used from run_work_connection_usage where run_id=$1',
          [run.id])).rows[0]?.used).toBe(1)
        expect((await pool.query('select 1 from run_work_requests where run_id=$1', [run.id])).rowCount).toBe(1)
        expect((await pool.query('select 1 from harness_executions where run_id=$1 and workflow_node_id=$2',
          [run.id, edge.target])).rowCount).toBe(0)
        await expect(pool.query(`update run_work_requests set payload_digest=$2 where run_id=$1`,
          [run.id, `sha256:${'f'.repeat(64)}`])).rejects.toThrow('WORK_EVIDENCE_IMMUTABLE')
      } finally {
        connected = false
        await connection.close()
        await raw.end()
      }
      const recoveredOwner = await RunOwnership.acquire(pool, run.id, () => undefined)
      assert.ok(recoveredOwner)
      try {
        const recovered = new RepeatRunRepository(recoveredOwner, host, version)
        const replay = await recovered.admitWorkRequest(executionId)
        assert.equal(replay.kind, 'accepted')
        expect(replay.replayed).toBe(true)
        expect(replay.request.ordinal).toBe(1)
        expect((await pool.query('select 1 from run_work_requests where run_id=$1', [run.id])).rowCount).toBe(1)
        expect((await pool.query<{ used: number }>('select used from run_work_connection_usage where run_id=$1',
          [run.id])).rows[0]?.used).toBe(1)
      } finally { await recoveredOwner.release() }
    })
  }, 120000)
})
