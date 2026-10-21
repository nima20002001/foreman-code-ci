import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { HarnessExecutionSchema, WorkflowRunSchema } from '@foreman-code/contracts'
import pg from 'pg'
import { describe, it } from 'vitest'

import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { ensureAcceptanceSeed } from '../src/infrastructure/seed.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { WorkerCredentialService, type IssuedWorkerCredential } from '../src/modules/access/workerCredentials.js'

const connectionString = process.env.TEST_DATABASE_URL
const token = (credential: IssuedWorkerCredential) => credential.environment.variables.GRAPHQL_MCP_TOKEN!

async function database(perform: (pool: pg.Pool) => Promise<void>) {
  let database: URL
  try { database = new URL(connectionString!) } catch { throw new Error('Use a loopback PostgreSQL database explicitly named for tests') }
  if (!['postgres:', 'postgresql:'].includes(database.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname)
    || !/(?:^|[_-])test(?:db)?(?:$|[_-])/i.test(decodeURIComponent(database.pathname.slice(1)))
    || database.search || database.hash) throw new Error('Use a loopback PostgreSQL database explicitly named for tests')
  const schema = `pr11_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString })
  await createFixtureSchema(admin, schema)
  const pool = new pg.Pool({ connectionString, max: 8, options: `-c search_path=${schema} -c statement_timeout=10000` })
  try {
    await applyApplicationMigrations(pool)
    await ensureAcceptanceSeed(pool)
    await perform(pool)
  } finally {
    await pool.end()
    await dropFixtureSchema(admin, schema)
    await admin.end()
  }
}

async function identities(pool: pg.Pool) {
  const suffix = randomUUID()
  const run = WorkflowRunSchema.parse({
    id: `run-pr11-${suffix}`, workspaceId: 'workspace-1', workflowId: 'workflow-content-pipeline', workflowVersionId: 'workflow-content-pipeline-v1', executionSemanticsVersion: 3,
    agentConfigurationVersionIds: { 'agent-researcher': 'agent-researcher-config-v1', 'agent-developer': 'agent-developer-config-v1', 'agent-reviewer': 'agent-reviewer-config-v1' },
    approval: { handler: 'user' },
    executionLocation: { runnerId: 'runner-test', rootPath: '/tmp/graphql-pr11-test', locationRevision: 1,
      identityHash: `sha256:${'1'.repeat(64)}` }, authorizationPrincipalId: 'operator-pr11-fixture',
    executionCondition: { kind: 'manual' }, executionState: 'waiting', outcome: 'pending', input: {}, createdAt: new Date().toISOString(),
  })
  await pool.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record) values($1,$2,$3,$4,$5,$6::jsonb)`,
    [run.id, run.workspaceId, run.workflowId, run.workflowVersionId, run.executionState, JSON.stringify(run)])
  const executions = await Promise.all(['developer', 'reviewer'].map(async (role) => {
    const execution = HarnessExecutionSchema.parse({
      id: `execution-${role}-${suffix}`, runId: run.id, workflowNodeId: role === 'developer' ? 'node-developer' : 'node-reviewer', agentId: `agent-${role}`,
      agentConfigurationVersionId: `agent-${role}-config-v1`, attempt: 1, input: {}, state: 'starting',
      nativeSessionId: role === 'developer' ? `session-${suffix}` : `session-reviewer-${suffix}`,
      createdAt: new Date().toISOString(),
    })
    await pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,accepted,record) values($1,$2,$3,$4,1,false,$5::jsonb)`,
      [execution.id, run.id, execution.workflowNodeId, execution.agentId, JSON.stringify(execution)])
    return execution
  }))
  const access = new PostgresAccessService(pool)
  const credentials = new WorkerCredentialService(pool, access)
  return { run, coder: executions[0]!, otherExecution: executions[1]!, access, credentials }
}

async function assertNoActiveCredentials(pool: pg.Pool, runId: string) {
  const result = await pool.query<{ count: number }>(`select count(*)::int as count from worker_credential_bindings b join management_principals p on p.id=b.principal_id where b.run_id=$1 and (b.revoked_at is null or p.revoked_at is null)`, [runId])
  assert.equal(result.rows[0]!.count, 0)
}

describe.skipIf(!connectionString)('PR #11 real PostgreSQL lifecycle and decisions', () => {
  it('serializes issuance versus Stop and prevents all later issuance', async () => {
    await database(async (pool) => {
      const f = await identities(pool)
      await f.credentials.issueForExecution(f.coder.id)
      const blocker = await pool.connect()
      try {
        await blocker.query('begin')
        await blocker.query('select id from runs where id=$1 for update', [f.run.id])
        const attempts = Promise.allSettled([
          f.credentials.issueForExecution(f.coder.id), f.credentials.revokeForRun(f.run.id),
          f.credentials.issueForExecution(f.otherExecution.id),
        ])
        await blocker.query('commit')
        await attempts
      } finally { await blocker.query('rollback').catch(() => undefined); blocker.release() }
      await assertNoActiveCredentials(pool, f.run.id)
      await assert.rejects(f.credentials.issueForExecution(f.coder.id), { code: 'WORKER_EXECUTION_INACTIVE' })
    })
  }, 30_000)

  it('uses consistent completion and execution-wide revocation locking with multiple tokens', async () => {
    await database(async (pool) => {
      const f = await identities(pool)
      const [left, right] = await Promise.all([f.credentials.issueForExecution(f.coder.id), f.credentials.issueForExecution(f.coder.id)])
      await Promise.all([f.credentials.revoke(left), f.credentials.revokeForExecution(f.coder.id), f.credentials.revoke(right)])
      await assertNoActiveCredentials(pool, f.run.id)
      assert.equal(await f.credentials.revokeForExecution(f.coder.id), 0)
      await assert.rejects(f.access.authenticate(token(right), 'worker'), { code: 'AUTH_REVOKED' })
    })
  }, 30_000)

  it('recovers terminal credentials without the old token variable and rejects them during cleanup outages', async () => {
    await database(async (pool) => {
      const f = await identities(pool)
      const issued = await f.credentials.issueForExecution(f.coder.id)
      const completed = HarnessExecutionSchema.parse({ ...f.coder, state: 'completed', result: { outcome: 'succeeded' }, finishedAt: new Date().toISOString() })
      await pool.query('update harness_executions set record=$2::jsonb where id=$1', [f.coder.id, JSON.stringify(completed)])
      await assert.rejects(f.access.authenticate(token(issued), 'worker'), { code: 'AUTH_REVOKED' })
      await assert.rejects(f.credentials.issueForExecution(f.coder.id), { code: 'WORKER_EXECUTION_INACTIVE' })
      class TemporaryFailure extends WorkerCredentialService {
        override async reconcileTerminalCredentials(): Promise<void> { throw new Error('temporary cleanup outage') }
      }
      await assert.rejects(new TemporaryFailure(pool, f.access).reconcileTerminalCredentials(), /temporary cleanup outage/)
      await new WorkerCredentialService(pool, f.access).reconcileTerminalCredentials()
      await assertNoActiveCredentials(pool, f.run.id)
      const completedRun = WorkflowRunSchema.parse({ ...f.run, executionState: 'completed', outcome: 'canceled', result: { outcome: 'canceled' }, finishedAt: new Date().toISOString() })
      await pool.query("update runs set execution_state='completed',record=$2::jsonb where id=$1", [f.run.id, JSON.stringify(completedRun)])
      await assert.rejects(f.credentials.issueForExecution(f.otherExecution.id), { code: 'WORKER_EXECUTION_INACTIVE' })
    })
  }, 30_000)

  it('heals old binding-revoked/principal-active inconsistencies', async () => {
    await database(async (pool) => {
      const f = await identities(pool)
      const issued = await f.credentials.issueForExecution(f.coder.id)
      await pool.query('update worker_credential_bindings set revoked_at=now() where principal_id=$1', [issued.principalId])
      await assert.rejects(f.access.authenticate(token(issued), 'worker'), { code: 'AUTH_REVOKED' })
      assert.equal(await f.credentials.revokeForExecution(f.coder.id), 1)
      await assertNoActiveCredentials(pool, f.run.id)
    })
  }, 30_000)

})
