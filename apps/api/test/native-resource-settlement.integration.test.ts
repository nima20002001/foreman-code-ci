import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, WorkflowRunV3Schema } from '@foreman-code/contracts/wave25'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { settleRepeatNativeExecutionLocked } from '../src/modules/interactions/repeatNativeSettlement.js'
import { PostgresWorkflowClosureStore } from '../src/modules/interactions/workflowClosure.js'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { approvalResponse } from './helpers/approvalResponse.js'
import { routedApprovalFixture } from './helpers/routedApprovalFixture.js'
import { readUntil } from './helpers/observableCondition.js'
import { seedAgent3 } from './helpers/wave25Agent3.js'

afterEach(() => vi.restoreAllMocks())

describe('Native resource settlement', () => {
  let database: Awaited<ReturnType<typeof migratedDatabase>>
  beforeAll(async () => { database = await migratedDatabase() }, 60_000)
  afterAll(async () => { await database?.close() })

  async function setup() {
    const fixture = await seedAgent3(database.pool, database.directory, makeCurrentWorkflowFixture(randomUUID(), 'single'))
    const run = WorkflowRunV3Schema.parse({ ...fixture.run, executionState: 'running', startedAt: fixture.createdAt })
    await database.pool.query('update runs set execution_state=$2,record=$3::jsonb where id=$1', [run.id, run.executionState, JSON.stringify(run)])
    const identity = fixture.identities[0]!
    const execution = HarnessExecutionSchema.parse({ id: randomUUID(), runId: run.id, workflowNodeId: identity.workflowNodeId,
      agentId: identity.agentId, agentConfigurationVersionId: fixture.version.agentConfigurationVersionIds[identity.agentId],
      attempt: 1, input: {}, state: 'completed', createdAt: fixture.createdAt, finishedAt: fixture.createdAt,
      nativeSessionId: randomUUID(), result: { outcome: 'succeeded', output: 'done' } })
    await database.pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record)
      values($1,$2,$3,$4,1,$5::jsonb)`, [execution.id, run.id, execution.workflowNodeId, execution.agentId, JSON.stringify(execution)])
    const session = { harness: 'codex' as const, providerVersion: 'fixture-provider', nativeSessionId: execution.nativeSessionId! }
    await database.pool.query('insert into execution_native_sessions(execution_id,reference) values($1,$2::jsonb)',
      [execution.id, JSON.stringify(session)])
    const closures = new PostgresWorkflowClosureStore(database.pool)
    const generation = await closures.begin(execution)
    await closures.record(execution, session, generation, () => {})
    const settle = () => withExclusiveGraphConnection(database.pool, connection => connection.transaction(sql =>
      settleRepeatNativeExecutionLocked(sql, run.id, execution)))
    const finalized = async () => (await database.pool.query(
      'select workflow_finalized_at from execution_native_sessions where execution_id=$1', [execution.id])).rows[0]!.workflow_finalized_at
    return { fixture, execution, settle, finalized }
  }

  it.each(['active', 'approval_wait'] as const)('blocks finalization while the %s budget is outstanding', async kind => {
    const f = await setup()
    await database.pool.query(`insert into approval_execution_state(execution_id,graph_thread_id,active_timeout_ms,
      active_started_at,approval_wait_started_at) values($1,$2,60000,$3,$4)`,
    [f.execution.id, f.execution.runId, kind === 'active' ? new Date() : null, kind === 'approval_wait' ? new Date() : null])
    await expect(f.settle()).rejects.toMatchObject({ code: 'REPEAT_CLEANUP_PENDING' })
    expect(await f.finalized()).toBeNull()
    await database.pool.query(`update approval_execution_state set active_started_at=null,approval_wait_started_at=null
      where execution_id=$1`, [f.execution.id])
    await f.settle()
    expect(await f.finalized()).toBeInstanceOf(Date)
  })

  it('requires both the execution credential and its principal to be revoked', async () => {
    const f = await setup()
    const access = new PostgresAccessService(database.pool)
    const issued = await access.issue({ name: 'Execution credential', audience: 'operator', grants: [],
      expiresAt: new Date(Date.now() + 60_000) })
    await database.pool.query(`insert into worker_credential_bindings(principal_id,execution_id,run_id,workspace_id,
      workflow_id,agent_id,environment_variable) values($1,$2,$3,$4,$5,$6,'GRAPHQL_MCP_TOKEN')`,
    [issued.principal.id, f.execution.id, f.execution.runId, f.fixture.scope.workspaceId,
      f.fixture.scope.workflowId, f.execution.agentId])
    await expect(f.settle()).rejects.toMatchObject({ code: 'REPEAT_CLEANUP_PENDING' })
    expect(await f.finalized()).toBeNull()
    await database.pool.query('update worker_credential_bindings set revoked_at=now() where principal_id=$1', [issued.principal.id])
    await expect(f.settle()).rejects.toMatchObject({ code: 'REPEAT_CLEANUP_PENDING' })
    expect(await f.finalized()).toBeNull()
    await database.pool.query('update management_principals set revoked_at=now() where id=$1', [issued.principal.id])
    await f.settle()
    expect(await f.finalized()).toBeInstanceOf(Date)
  })

  it('blocks a persisted reviewer job until its native turn and cleanup settle', async () => {
    const f = await routedApprovalFixture()
    let dispatch: Promise<unknown> | undefined
    try {
      const settle = () => withExclusiveGraphConnection(f.db.pool, connection => connection.transaction(sql =>
        settleRepeatNativeExecutionLocked(sql, f.run.id, f.reviewer)))
      const finalized = async () => (await f.db.pool.query(
        'select workflow_finalized_at from execution_native_sessions where execution_id=$1',
        [f.reviewer.id])).rows[0]!.workflow_finalized_at
      const before = await finalized()
      await expect(settle()).rejects.toMatchObject({ code: 'REPEAT_CLEANUP_PENDING' })
      expect(await finalized()).toEqual(before)
      const issuance = vi.spyOn(f.credentials, 'issueForReviewer')
      dispatch = f.native.reviewers.dispatchNext(f.reviewer.agentId, 'settlement-test')
      const dispatched = Promise.allSettled([dispatch])
      const job = await readUntil(() => f.coordination.findReviewJob(f.interaction.id, f.reviewer.agentId),
        value => value?.state === 'acknowledged', { timeoutMs: 5000, description: 'review native submission' })
      await expect(settle()).rejects.toMatchObject({ code: 'REPEAT_CLEANUP_PENDING' })
      expect(await finalized()).toEqual(before)
      const issued = issuance.mock.results.at(-1)
      if (issued?.type !== 'return') throw new Error('Expected the dispatcher reviewer credential')
      const credential = await issued.value
      const principal = await f.access.authenticate(credential.environment.variables.GRAPHQL_MCP_TOKEN, 'worker')
      const app = new PostgresAppInteractionService(f.db.pool, f.repository,
        new PostgresCommandCoordinator(f.db.pool), f.service)
      const decision = approvalResponse(f.interaction)
      const answered = await app.respond(principal, decision)
      expect(answered).toMatchObject({ interaction: {
        selectedOptionId: decision.optionId, status: 'delivery_pending', deliveryState: 'pending',
      } })
      f.provider.completeReview(job!.correlationId, job!.nativeSessionId)
      await dispatch
      expect(await dispatched).toMatchObject([{ status: 'fulfilled' }])
      const completed = await f.coordination.findReviewJob(f.interaction.id, f.reviewer.agentId)
      expect(completed, JSON.stringify(completed)).toMatchObject({ state: 'completed' })
      await settle()
      expect(await finalized()).toBeInstanceOf(Date)
    } finally {
      await f.close()
      if (dispatch) await Promise.allSettled([dispatch])
    }
  }, 60_000)
})
