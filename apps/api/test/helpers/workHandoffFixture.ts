import assert from 'node:assert/strict'
import type pg from 'pg'
import { HarnessExecutionSchema, type HarnessExecution } from '@foreman-code/contracts'
import { workHandoffNodeAction } from '../../src/modules/runs/workHandoffNode.js'
import { ExecutionLimiter } from '../../src/modules/runs/limiter.js'
import { WorkActivationInputSchema, type WorkHandoffResult, type WorkflowVersionV3,
  makeCurrentWorkflowFixture, WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { RunOwnership } from '../../src/modules/runs/ownership.js'
import { RepeatRunRepository, type RepeatRepositoryHost } from '../../src/modules/runs/repeatPostgres.js'
import { repeatId } from '../../src/modules/runs/repeatResolution.js'
import { markWorkNoticeDeliveredLocked } from '../../src/modules/runs/workHandoffNotice.js'
import { digest, text, transaction } from '../eng04-migration-fixtures.js'

/** Pre-upgrade fixtures stage history through the current repository, whose execution
 * budget counts reserved control continuations. The real table arrives with its migration,
 * so staging reads an empty stand-in that the fixture drops before upgrading. */
export async function stageControlContinuationReads(pool: pg.Pool) {
  await pool.query(`create table run_control_continuations (id text primary key, run_id text not null,
    state text not null, reserved_successor_execution_id text)`)
}
export async function dropStagedControlContinuationReads(pool: pg.Pool) {
  await pool.query('drop table run_control_continuations')
}

export async function workHandoffFixture(pool: pg.Pool, suffix: string,
  configure: (version: ReturnType<typeof makeCurrentWorkflowFixture>['version']) => WorkflowVersionV3) {
  const fixture = makeCurrentWorkflowFixture(suffix, 'parallel')
  const version = WorkflowVersionV3Schema.parse(configure(fixture.version))
  const run = { ...fixture.run, executionState: 'running' as const }
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
    await sql.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,
      execution_semantics_version,record) values($1,$2,$3,1,$4,3,$5::jsonb)`,
      [version.id, run.workspaceId, run.workflowId, version.entryNodeId, text(version)])
    await sql.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
      values($1,$2,$3,$4,'running',$5::jsonb)`, [run.id, run.workspaceId, run.workflowId, version.id, text(run)])
  })
  // This fixture isolates accepted-result routing and database constraints from native execution and grants.
  const host: RepeatRepositoryHost = { openLocked: async () => ({ run,
    assertAuthorityLocked: async () => undefined,
    assertAdmissionLocked: async () => undefined,
    assertSettlementLocked: async () => undefined,
    allowTechnicalRetryLocked: async () => false,
    publishLocked: async (_sql, _effect, _facts, mutate) => { await mutate() },
    assertPublicationReceiptLocked: async (sql, effect) => {
      const row = (await sql.query<{ payload_digest: string }>(
        'select payload_digest from run_repeat_effects where run_id=$1 and effect_kind=$2 and entity_id=$3',
        [run.id, effect.kind, effect.entityId])).rows[0]
      assert.equal(row?.payload_digest, effect.digest)
    },
    completeRunLocked: async () => { throw new Error('Native settlement is outside this fixture') },
  }) }
  let owner = await RunOwnership.acquire(pool, run.id, () => undefined)
  assert.ok(owner)
  let store = new RepeatRunRepository(owner, host, version)
  async function restart() {
    await owner!.release()
    owner = await RunOwnership.acquire(pool, run.id, () => undefined)
    assert.ok(owner)
    store = new RepeatRunRepository(owner, host, version)
  }
  async function queue(activationId: string) {
    return store.admitWorkActivation(activationId, (nodeId) => {
      const node = version.definition.nodes.find((item) => item.id === nodeId)
      assert.ok(node && node.kind !== 'job')
      return HarnessExecutionSchema.parse({ id: repeatId('fixture-execution', activationId), runId: run.id,
        workflowNodeId: node.id, agentId: node.agentId,
        agentConfigurationVersionId: version.agentConfigurationVersionIds[node.agentId],
        attempt: 1, input: {}, state: 'queued', createdAt: fixture.createdAt })
    })
  }
  async function accept(activationId: string, output: WorkHandoffResult) {
    const queued = await queue(activationId)
    const execution = HarnessExecutionSchema.parse({ ...queued.execution, state: 'completed',
      finishedAt: fixture.createdAt, result: { outcome: 'succeeded', output } })
    await transaction(pool, async (sql) => {
      await sql.query('update harness_executions set record=$2::jsonb,accepted=true where id=$1',
        [execution.id, text(execution)])
      await sql.query(`insert into run_work_results(execution_id,run_id,activation_id,result_json,result_digest,accepted_at)
        values($1,$2,$3,$4,$5,$6)`,
        [execution.id, run.id, activationId, text(execution.result), digest(execution.result), fixture.createdAt])
      await sql.query("update run_work_activations set state='completed' where activation_id=$1", [activationId])
    })
    await owner!.oneShotConnection().transaction((sql) => markWorkNoticeDeliveredLocked({
      sql, scope: fixture.scope, version, now: new Date().toISOString(),
    }, activationId, execution.id))
    return execution
  }
  async function input(activationId: string) {
    return WorkActivationInputSchema.parse((await queue(activationId)).execution.input)
  }
  function route(execution: HarnessExecution) {
    return workHandoffNodeAction({ version,
      store: {
        admitWorkActivation: (id, candidate) => store.admitWorkActivation(id, candidate),
        acceptWorkTerminal: async () => ({ kind: 'accepted', execution, replayed: true }),
        admitWorkRequest: (id, relationship) => store.admitWorkRequest(id, relationship),
        returnWork: (id) => store.returnWork(id),
        recordWorkUnresolved: (id) => store.recordWorkUnresolved(id),
        resolveWaitingWorkJoins: (id) => store.resolveWaitingWorkJoins(id),
      },
      // The result is already accepted; this port isolates subsequent routing from native execution.
      driver: { candidate: () => { throw new Error('Accepted routing allocated another native execution') },
        observe: async () => undefined },
      limiter: new ExecutionLimiter(1, 30), signal: new AbortController().signal,
    })
  }
  return { version, run, pool, get store() { return store }, restart, queue, accept, input, route,
    close: async () => { await owner!.release() } }
}

export function finished(revision: number): WorkHandoffResult {
  return { routing: { kind: 'finish' }, data: { latestDeliverable: { revision }, remainingFindings: [] } }
}
