import assert from 'node:assert/strict'
import { describe, expect, it, vi } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { RepeatRunRepository, type RepeatRepositoryHost } from '../src/modules/runs/repeatPostgres.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { text, transaction } from './eng04-migration-fixtures.js'
import { nim2691TaskDatabase } from './helpers/nim2691Database.js'

// Only the physical provider close is doubled. This test proves real SQL
// attempt/quota identity, not provider delivery, approval or cleanup.
vi.mock('../src/modules/interactions/repeatNativeSettlement.js', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  settleRepeatNativeExecutionLocked: vi.fn(async () => undefined),
}))

describe.skipIf(process.env.NIM2691_POSTGRES !== '1')('NIM-2691 technical attempt accounting', () => {
  it('keeps a retry in one activation and charges only its later business request', async () => {
    await nim2691TaskDatabase(async (pool) => {
      await applyApplicationMigrations(pool)
      const fixture = makeCurrentWorkflowFixture('nim2691-retry-sql')
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
      await transaction(pool, async (sql) => {
        await sql.query('insert into workspaces(id,record) values($1,$2::jsonb)', [run.workspaceId, text({ id: run.workspaceId })])
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
      })
      const owner = await RunOwnership.acquire(pool, run.id, () => undefined)
      assert.ok(owner)
      try {
        const host: RepeatRepositoryHost = { openLocked: async () => ({ run,
          assertAuthorityLocked: async () => undefined,
          assertAdmissionLocked: async () => undefined,
          assertSettlementLocked: async () => undefined,
          allowTechnicalRetryLocked: async () => true,
          publishLocked: async (_sql, _effect, _facts, mutate) => { await mutate() },
          assertPublicationReceiptLocked: async (sql, effect) => {
            const row = (await sql.query<{ payload_digest: string }>(
              'select payload_digest from run_repeat_effects where run_id=$1 and effect_kind=$2 and entity_id=$3',
              [run.id, effect.kind, effect.entityId])).rows[0]
            assert.equal(row?.payload_digest, effect.digest)
          },
          completeRunLocked: async () => { throw new Error('Unexpected completion') },
        }) }
        const store = new RepeatRunRepository(owner, host, version)
        const activationId = await store.ensureWorkEntry()
        const first = await store.admitWorkActivation(activationId, () => HarnessExecutionSchema.parse({
          id: 'retry-execution-1', runId: run.id, workflowNodeId: source.id, agentId: source.agentId,
          agentConfigurationVersionId: version.agentConfigurationVersionIds[source.agentId],
          attempt: 1, input: {}, state: 'queued', createdAt: fixture.createdAt,
        }))
        const failed = HarnessExecutionSchema.parse({ ...first.execution, state: 'completed', finishedAt: fixture.createdAt,
          result: { outcome: 'failed', error: { code: 'TRANSIENT', message: 'A retryable test terminal.', retryable: true } } })
        await pool.query('update harness_executions set record=$2::jsonb where id=$1', [first.execution.id, text(failed)])
        const retry = await store.acceptWorkTerminal(first.execution.id, (attempt) => HarnessExecutionSchema.parse({
          id: 'retry-execution-2', runId: run.id, workflowNodeId: source.id, agentId: source.agentId,
          agentConfigurationVersionId: version.agentConfigurationVersionIds[source.agentId],
          attempt, input: {}, state: 'queued', createdAt: fixture.createdAt,
        }))
        assert.equal(retry.kind, 'retry')
        expect(retry.execution.attempt).toBe(2)
        expect((await store.readExecution(retry.execution.id)).workActivationId).toBe(activationId)
        expect((await pool.query('select 1 from run_work_connection_usage where run_id=$1', [run.id])).rowCount).toBe(0)
        const succeeded = HarnessExecutionSchema.parse({ ...retry.execution, state: 'completed', finishedAt: fixture.createdAt,
          result: { outcome: 'succeeded', output: { routing: { kind: 'request', outcome: 'review' },
            data: { latestDeliverable: { revision: 2 }, remainingFindings: [] } } } })
        await pool.query('update harness_executions set record=$2::jsonb where id=$1', [retry.execution.id, text(succeeded)])
        const accepted = await store.acceptWorkTerminal(retry.execution.id, () => { throw new Error('Accepted work cannot retry') })
        expect(accepted.kind).toBe('accepted')
        expect((await pool.query('select 1 from run_work_connection_usage where run_id=$1', [run.id])).rowCount).toBe(0)
        const admitted = await store.admitWorkRequest(retry.execution.id)
        assert.equal(admitted.kind, 'accepted')
        expect(admitted.request.ordinal).toBe(1)
        expect((await pool.query<{ used: number }>('select used from run_work_connection_usage where run_id=$1',
          [run.id])).rows[0]?.used).toBe(1)
        expect((await pool.query<{ n: string }>(`select count(*)::text as n from run_repeat_executions
          where run_id=$1 and work_activation_id=$2`, [run.id, activationId])).rows[0]?.n).toBe('2')
      } finally { await owner.release() }
    })
  }, 120000)
})
