import { createFixtureSchema, dropFixtureSchema } from './testResources.js'
import { randomUUID } from 'node:crypto'

import { HarnessExecutionSchema, WorkflowRunSchema, type HarnessExecution } from '@foreman-code/contracts'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach } from 'vitest'

import { applyApplicationMigrations } from '../../src/infrastructure/migrations.js'
import { ensureAcceptanceSeed } from '../../src/infrastructure/seed.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { WorkerCredentialService } from '../../src/modules/access/workerCredentials.js'
import { PostgresApprovalBudgetRepository } from '../../src/modules/interactions/budget.js'

export function workerCredentialBudgetFixture() {
  const connectionString = process.env.TEST_DATABASE_URL!
  let schema: string
  let admin: pg.Pool
  let pool: pg.Pool
  let execution: HarnessExecution
  let access: PostgresAccessService
  let credentials: WorkerCredentialService
  let budgets: PostgresApprovalBudgetRepository

  beforeAll(async () => {
    schema = `worker_budget_${randomUUID().replaceAll('-', '')}`
    admin = new pg.Pool({ connectionString })
    await createFixtureSchema(admin, schema)
    pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
    await applyApplicationMigrations(pool)
    await ensureAcceptanceSeed(pool)
  }, 60_000)

  beforeEach(async () => {
    access = new PostgresAccessService(pool)
    credentials = new WorkerCredentialService(pool, access, 60_000)
    budgets = new PostgresApprovalBudgetRepository(pool)
    const createdAt = new Date().toISOString()
    const run = WorkflowRunSchema.parse({
      id: `run-renewal-${randomUUID()}`, workspaceId: 'workspace-1', workflowId: 'workflow-content-pipeline',
      workflowVersionId: 'workflow-content-pipeline-v1', executionSemanticsVersion: 3,
      agentConfigurationVersionIds: { 'agent-researcher': 'agent-researcher-config-v1',
        'agent-developer': 'agent-developer-config-v1', 'agent-reviewer': 'agent-reviewer-config-v1' },
      approval: { handler: 'user' }, executionCondition: { kind: 'manual' },
      executionLocation: { runnerId: 'runner-test', rootPath: '/project/worker-budget-test', locationRevision: 1,
        identityHash: `sha256:${'1'.repeat(64)}` }, authorizationPrincipalId: 'operator-worker-budget-fixture',
      executionState: 'waiting', outcome: 'pending', input: {}, createdAt,
    })
    await pool.query(
      `insert into runs (id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
       values ($1,$2,$3,$4,$5,$6::jsonb)`,
      [run.id, run.workspaceId, run.workflowId, run.workflowVersionId, run.executionState, JSON.stringify(run)],
    )
    execution = HarnessExecutionSchema.parse({
      id: `execution-renewal-${randomUUID()}`, runId: run.id, workflowNodeId: 'node-developer', agentId: 'agent-developer',
      agentConfigurationVersionId: 'agent-developer-config-v1', attempt: 1, input: {}, state: 'waiting', createdAt,
    })
    await pool.query(
      `insert into harness_executions (id,run_id,workflow_node_id,agent_id,attempt,accepted,record)
       values ($1,$2,$3,$4,$5,false,$6::jsonb)`,
      [execution.id, execution.runId, execution.workflowNodeId, execution.agentId, execution.attempt, JSON.stringify(execution)],
    )
    await budgets.ensure(execution.id, 'thread-renewal', 60_000)
    await budgets.beginWait(execution.id)
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
    await (admin ? dropFixtureSchema(admin, schema) : Promise.resolve())
    await admin?.end()
  })

  return {
    get schema() { return schema },
    get pool() { return pool },
    get execution() { return execution },
    get access() { return access },
    get credentials() { return credentials },
    get budgets() { return budgets },
  }
}
