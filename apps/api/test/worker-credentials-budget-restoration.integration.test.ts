import { beforeEach, expect, it } from 'vitest'
import { AgentConfigurationVersionSchema, HarnessExecutionSchema } from '@foreman-code/contracts'
import { WorkerCredentialService } from '../src/modules/access/workerCredentials.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { Wave25WorkerCredentialService } from '../src/modules/interactions/wave25/credentials.js'
import { PostgresInteractionCoordinationRepository } from '../src/modules/interactions/coordination.js'
import { WorkerLaunchCredentialService } from '../src/modules/harnesses/mcpDetection.js'
import { workerCredentialBudgetFixture } from './helpers/workerCredentialBudgetFixture.js'

const fixture = workerCredentialBudgetFixture()
let pool: typeof fixture.pool
let execution: typeof fixture.execution
let access: typeof fixture.access
let credentials: typeof fixture.credentials
let budgets: typeof fixture.budgets

beforeEach(() => {
  ({ pool, execution, access, credentials, budgets } = fixture)
})

it('restores the original native credential after service restart without allocating or rotating it', async () => {
  const configuration = AgentConfigurationVersionSchema.parse((await pool.query(
    'select record from agent_configuration_versions where id=$1', [execution.agentConfigurationVersionId])).rows[0].record)
  const session = { harness: configuration.harness.harness, providerVersion: 'credential-fixture-no-native',
    nativeSessionId: 'original-credential-session' }
  execution = HarnessExecutionSchema.parse({ ...execution, nativeSessionId: session.nativeSessionId })
  await pool.query('update harness_executions set record=$2::jsonb where id=$1', [execution.id, JSON.stringify(execution)])
  const coordination = new PostgresInteractionCoordinationRepository(pool)
  await coordination.bindWorkflowSession(execution.id, session)
  await coordination.ensureLane({ id: 'original-credential-lane', harness: session.harness,
    nativeSessionId: session.nativeSessionId, ownerAgentId: execution.agentId,
    connectionGeneration: 1, revision: 0, observedAt: execution.createdAt, observedStatus: 'idle' })
  const issued = await new Wave25WorkerCredentialService(pool, access, 60_000).issueForExecution(execution.id)
  // A deadline from the previous process has no meaning in the restarted process's monotonic clock.
  issued.renewalDeadline = -1
  const before = (await pool.query('select id,token_hash,expires_at from management_principals where id=$1',
    [issued.principalId])).rows[0]
  const restarted = new WorkerCredentialService(pool, new PostgresAccessService(pool), 60_000)
  const restorationStartedAt = performance.now()
  const restored = await restarted.restoreForExecution(execution.id, issued.environment)
  expect(restored).toEqual({
    principalId: issued.principalId,
    environment: issued.environment,
    expiresAt: issued.expiresAt,
    renewalDeadline: expect.any(Number),
  })
  expect(restored.renewalDeadline).toBeGreaterThan(performance.now())
  expect(restored.renewalDeadline).toBeLessThanOrEqual(restorationStartedAt + restarted.ttlMs)
  expect((await access.authenticate(restored.environment.variables.GRAPHQL_MCP_TOKEN!, 'worker')).id)
    .toBe(issued.principalId)
  expect((await pool.query('select id,token_hash,expires_at from management_principals where id=$1',
    [issued.principalId])).rows[0]).toEqual(before)
  expect((await pool.query('select principal_id from worker_credential_bindings where execution_id=$1',
    [execution.id])).rows).toEqual([{ principal_id: issued.principalId }])
  await expect(restarted.restoreForExecution('another-execution', issued.environment))
    .rejects.toMatchObject({ code: 'WORKER_CREDENTIAL_IDENTITY_CONFLICT' })
  await expect(restarted.restoreForExecution(execution.id, { ...issued.environment, agentId: 'agent-reviewer' }))
    .rejects.toMatchObject({ code: 'WORKER_CREDENTIAL_IDENTITY_CONFLICT' })
  await expect(restarted.restoreForExecution(execution.id, { ...issued.environment,
    variables: { ...issued.environment.variables, EXTRA: 'unexpected' } }))
    .rejects.toMatchObject({ code: 'WORKER_CREDENTIAL_IDENTITY_CONFLICT' })
})

it('denies credential restoration after revocation, expiry or Stop', async () => {
  const revoked = await credentials.issueForExecution(execution.id)
  await credentials.revoke(revoked)
  await expect(credentials.restoreForExecution(execution.id, revoked.environment))
    .rejects.toMatchObject({ code: 'AUTH_REVOKED' })
  const expired = await credentials.issueForExecution(execution.id)
  await pool.query("update management_principals set expires_at=now()-interval '1 second' where id=$1", [expired.principalId])
  await expect(credentials.restoreForExecution(execution.id, expired.environment))
    .rejects.toMatchObject({ code: 'AUTH_EXPIRED' })
  const stopped = await credentials.issueForExecution(execution.id)
  await budgets.stop(execution.id)
  await expect(credentials.restoreForExecution(execution.id, stopped.environment))
    .rejects.toMatchObject({ code: 'AUTH_REVOKED' })
})

it('revokes a superseded token when a new process credential is prepared', async () => {
  const starting = HarnessExecutionSchema.parse({ ...execution, state: 'starting' })
  await pool.query('update harness_executions set record=$2::jsonb where id=$1', [execution.id, JSON.stringify(starting)])
  const issued = await credentials.issueForExecution(execution.id)
  const launch = new WorkerLaunchCredentialService({ preflight: async () => ({}) } as never, credentials, 'runner-1', 30_000)
  const fresh = await launch.prepare({ executionId: execution.id, harness: 'codex', workingDirectory: '/project' })
  expect(fresh.credential.principalId).not.toBe(issued.principalId)
  expect(fresh.credential.environment.agentId).toBe(issued.environment.agentId)
  await expect(access.authenticate(issued.environment.variables.GRAPHQL_MCP_TOKEN!, 'worker')).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
  expect((await access.authenticate(fresh.credential.environment.variables.GRAPHQL_MCP_TOKEN!, 'worker')).id).toBe(fresh.credential.principalId)
})
