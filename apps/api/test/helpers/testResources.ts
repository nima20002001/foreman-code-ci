export { createFixtureDatabase, createMigratedFixtureDatabase, dropFixtureDatabase, createFixtureSchema, dropFixtureSchema,
  ownedTestDatabaseUrl, ownedTestPath, removeFixtureDirectory } from '../../../../scripts/test-resources.mjs'

import type pg from 'pg'
import { assertTestDatabase, ownedTestDatabaseUrl, ownedTestPath } from '../../../../scripts/test-resources.mjs'

/** Prepared native acceptance binds the API's effective storage and database to this invocation. */
export async function assertOwnedTestApi(origin: URL, pool: pg.Pool, environment = process.env): Promise<void> {
  if (origin.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
    || origin.username || origin.password || origin.search || origin.hash) {
    throw new Error('Native acceptance requires a loopback test API')
  }
  const { RuntimeIdentitySchema } = await import('@foreman-code/contracts')
  const { createRuntimeIdentity, testResourcesIdentity } = await import('@foreman-code/contracts/runtime-identity-node')
  const databaseUrl = ownedTestDatabaseUrl('TEST_DATABASE_URL', environment)
  await assertTestDatabase(pool, { directory: environment.FOREMAN_CODE_TEST_ROOT!, token: environment.FOREMAN_CODE_TEST_OWNER!,
    name: new URL(databaseUrl).pathname.slice(1), databaseUrl })
  const result = await pool.query<{ id: string }>('select id from application_installation where singleton=true')
  const expected = createRuntimeIdentity(environment.FOREMAN_CODE_TEST_ROOT!, databaseUrl, result.rows[0]?.id ?? '')
  const response = await fetch(new URL('/health/identity', origin), { redirect: 'error', signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error('Test API identity is unavailable')
  const identity = RuntimeIdentitySchema.parse(await response.json())
  if (identity.databaseId !== expected.databaseId || identity.installationId !== expected.installationId) {
    throw new Error('Native acceptance API does not own the disposable test database')
  }
  const resourcesId = testResourcesIdentity(environment.FOREMAN_CODE_TEST_ROOT!, environment.FOREMAN_CODE_TEST_OWNER!)
  if (identity.testResourcesId !== resourcesId) {
    throw new Error('Native acceptance API storage and harness homes do not belong to this invocation')
  }
}

export async function assertOwnedExecutionDestinations(pool: pg.Pool, selection: {
  workspaceId: string
  runId?: string
  agentConfigurationVersionIds?: readonly string[]
}): Promise<void> {
  const { AgentConfigurationVersionSchema, ExecutionLocationSchema, HarnessExecutionSchema }
    = await import('@foreman-code/contracts')
  const { AcceptedWorkflowRunV3Schema } = await import('@foreman-code/contracts/wave25')
  const workspace = await pool.query<{ execution_location: unknown }>(
    'select execution_location from workspaces where id=$1', [selection.workspaceId])
  const location = ExecutionLocationSchema.parse(workspace.rows[0]?.execution_location)
  ownedTestPath(location.rootPath)
  let configurationIds = selection.agentConfigurationVersionIds ?? []
  if (selection.runId) {
    const result = await pool.query<{ record: unknown }>(
      'select record from runs where id=$1 and workspace_id=$2', [selection.runId, selection.workspaceId])
    const run = AcceptedWorkflowRunV3Schema.parse(result.rows[0]?.record)
    ownedTestPath(run.executionLocation.rootPath)
    configurationIds = Object.values(run.agentConfigurationVersionIds)
    const executions = await pool.query<{ record: unknown }>(
      'select record from harness_executions where run_id=$1', [selection.runId])
    for (const row of executions.rows) {
      const execution = HarnessExecutionSchema.parse(row.record)
      if (execution.workingDirectory) ownedTestPath(execution.workingDirectory)
      if (execution.runtimeDirectory) ownedTestPath(execution.runtimeDirectory)
    }
  }
  const configurations = await pool.query<{ record: unknown }>(
    'select record from agent_configuration_versions where workspace_id=$1 and id=any($2::text[])',
    [selection.workspaceId, [...configurationIds]])
  if (configurations.rows.length !== new Set(configurationIds).size) {
    throw new Error('Selected native Agent configurations are missing')
  }
  for (const row of configurations.rows) {
    const configuration = AgentConfigurationVersionSchema.parse(row.record)
    if (configuration.harness.harness === 'claude') ownedTestPath(configuration.harness.configDirectory)
  }
}
