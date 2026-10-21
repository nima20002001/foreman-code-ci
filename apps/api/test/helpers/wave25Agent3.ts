import { migratedDatabase } from './migratedDatabase.js'
import { createFixtureSchema, dropFixtureSchema, removeFixtureDirectory } from './testResources.js'
import { agentWorkflowVersion } from './agentWorkflowFixture.js'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { AgentSchema, HarnessExecutionSchema, type HarnessExecution, type ResolvedSkill } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, AcceptedRepeatStartV1Schema, WorkflowRunV3Schema, type WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { WorkflowManagementService } from '../../src/modules/workflows/management.js'
import { applyApplicationMigrations } from '../../src/infrastructure/migrations.js'
import { withExclusiveGraphConnection } from '../../src/modules/run-graph/connection.js'
import { insertRepeatRun } from '../../src/modules/runs/repeatStartAdmission.js'
import { repeatStartPublication } from '../../src/modules/run-graph/repeatStartPublication.js'
import { RunOwnership } from '../../src/modules/runs/ownership.js'
import { RepeatRunRepository, type RepeatRepositoryHost } from '../../src/modules/runs/repeatPostgres.js'
import type { PostgresRunRepository } from '../../src/modules/runs/postgres.js'
import type { RepeatNativeEvidence } from '../../src/modules/runs/repeatNativeRepository.js'
import { privateFixtureDirectory } from './privateFixtureDirectory.js'
import { LOCAL_RUNNER_ID } from '../../src/modules/workspaces/location.js'
import { assertFixtureResourcesSettled } from '../../../../scripts/test-resources.mjs'
import { writeNativeAcceptanceEvidence } from './nativeAcceptanceEvidence.js'
import { recordIntegrationStartup } from '../../../../scripts/integration-startup.mjs'

export const postgresEnabled = Boolean(process.env.TEST_DATABASE_URL)
export type Agent3Fixture = ReturnType<typeof makeCurrentWorkflowFixture>

/** Uses real independent PostgreSQL sessions and an isolated random schema.
 * No DATABASE_URL fallback, public host, destructive shared-table cleanup or
 * paid native model. The integration runner supplies a disposable test DB. */
export async function agent3Database(databaseUrl = process.env.TEST_DATABASE_URL) {
  const url = databaseUrl
  if (!url) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests')
  const parsed = new URL(url)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || !parsed.pathname.toLowerCase().includes('test')) {
    throw new Error('Use a loopback PostgreSQL database explicitly named for tests')
  }
  if (url === process.env.TEST_DATABASE_URL) return migratedDatabase()
  const schema = `wave25_a3_${randomUUID().replaceAll('-', '')}`
  const started = performance.now()
  const admin = new pg.Pool({ connectionString: url, max: 1 })
  await createFixtureSchema(admin, schema)
  const pool = new pg.Pool({ connectionString: url, max: 10,
    options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=5000` })
  const directory = await privateFixtureDirectory('wave25-a3-')
  const beforeMigration = performance.now()
  try { await applyApplicationMigrations(pool) } catch (error) {
    await pool.end(); await dropFixtureSchema(admin, schema); await admin.end()
    await removeFixtureDirectory(directory); throw error
  }
  recordIntegrationStartup('schema-fixture-ready', {
    setupMs: beforeMigration - started, migrationMs: performance.now() - beforeMigration,
  })
  if (process.env.FOREMAN_CODE_TEST_EVIDENCE_ARCHIVE) {
    await writeNativeAcceptanceEvidence(`fixture-setup-${randomUUID()}.json`, {
      kind: 'workflow-database-fixture', schema,
      setupMs: beforeMigration - started, migrationMs: performance.now() - beforeMigration,
    })
  }
  return {
    pool, databaseUrl: url, schema, directory,
    async close() {
      await pool.end()
      try {
        assertFixtureResourcesSettled(directory)
        await dropFixtureSchema(admin, schema)
      } finally { await admin.end() }
      await removeFixtureDirectory(directory)
    },
  }
}

export async function seedAgent3(pool: pg.Pool, directory: string, fixture = makeCurrentWorkflowFixture(randomUUID()), options: { run?: boolean; skills?: ResolvedSkill[] } = {}) {
  const location = { runnerId: LOCAL_RUNNER_ID, rootPath: directory, locationRevision: 1, identityHash: 'sha256:' + '1'.repeat(64) }
  fixture.run = WorkflowRunV3Schema.parse({ ...fixture.run, executionLocation: location })
  await pool.query(`insert into workspaces(id,record,execution_location,execution_location_identity,location_revision)
    values($1,$2::jsonb,$3::jsonb,$4::jsonb,1)`, [fixture.scope.workspaceId, JSON.stringify({ id: fixture.scope.workspaceId, name: 'Synthetic Agent 3 test' }),
  JSON.stringify({ runnerId: location.runnerId, rootPath: location.rootPath }), JSON.stringify({ synthetic: true })])
  for (const skill of options.skills ?? []) {
    const record = { ...skill, workspaceId: fixture.scope.workspaceId, name: skill.name ?? skill.skillId,
      createdAt: fixture.createdAt }
    await pool.query(`insert into workspace_skill_versions(workspace_id,skill_id,version,sequence,record)
      values($1,$2,$3,1,$4::jsonb)`, [fixture.scope.workspaceId, skill.skillId, skill.version, JSON.stringify(record)])
    await pool.query(`insert into workspace_skills(workspace_id,skill_id,head_version,revision,version_count)
      values($1,$2,$3,1,1)`, [fixture.scope.workspaceId, skill.skillId, skill.version])
  }
  for (const config of fixture.configurations) {
    const agent = AgentSchema.parse({ id: config.agentId, name: 'Synthetic Worker', productRole: config.productRole,
      harness: config.harness.harness, model: config.harness.model, effort: 'low', fastMode: false,
      harnessConfiguration: config.harness, prompt: config.prompt, assignedSkills: config.assignedSkills, configurationVersionId: config.id })
    await pool.query('insert into agents(id,workspace_id,current_configuration_version_id,record) values($1,$2,null,$3::jsonb)',
      [config.agentId, fixture.scope.workspaceId, JSON.stringify(agent)])
    await pool.query('insert into agent_configuration_versions(id,workspace_id,agent_id,version,record) values($1,$2,$3,1,$4::jsonb)',
      [config.id, fixture.scope.workspaceId, config.agentId, JSON.stringify(config)])
    await pool.query('update agents set current_configuration_version_id=$2 where id=$1', [config.agentId, config.id])
  }
  const access = new PostgresAccessService(pool)
  const writer = await access.issue({ name: 'Current fixture author', audience: 'operator',
    expiresAt: new Date(Date.now() + 300000), grants: [{ actions: [
      'workflows:create', 'workflows:read', 'workflows:update', 'graph:read', 'graph:edit', 'graph:save',
      'agents:read', 'workspace_locations:read', 'skills:read', 'harnesses:update',
    ], scope: { workspaceIds: [fixture.scope.workspaceId] } }] })
  const workflows = new WorkflowManagementService(pool, new PostgresCommandCoordinator(pool))
  const created = (await workflows.create(writer.principal, 'http', { workspaceId: fixture.scope.workspaceId,
    commandId: randomUUID(), name: fixture.version.definition.name })).value
  // This is the same typed writer used by /definition. It assigns saved IDs and
  // immutable version facts; no direct current-version update is permitted.
  const saved = (await workflows.current.save(writer.principal, 'http', JSON.parse(JSON.stringify({
    workspaceId: fixture.scope.workspaceId, workflowId: created.workflow.id,
    commandId: randomUUID(), executionSemanticsVersion: 3, expectedRevision: created.revision,
    expectedWorkflowVersionId: null,
    expectedAgentConfigurationVersionIds: fixture.version.agentConfigurationVersionIds,
    graph: { ...fixture.version.definition, id: created.workflow.id, version: created.workflow.version,
      createdAt: created.workflow.createdAt, updatedAt: created.workflow.updatedAt },
  })))).value
  fixture.version = agentWorkflowVersion(saved.version)
  fixture.scope = { ...fixture.scope, workflowId: saved.workflowId, workflowVersionId: saved.version.id }
  fixture.run = WorkflowRunV3Schema.parse({ ...fixture.run, workflowId: saved.workflowId,
    workflowVersionId: saved.version.id, agentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
    approval: saved.version.approval, authorizationPrincipalId: writer.principal.id })
  if (options.run !== false) {
    const authorizationPrincipalId = writer.principal.id
    fixture.run = WorkflowRunV3Schema.parse({ ...fixture.run, authorizationPrincipalId })
    const accepted = AcceptedRepeatStartV1Schema.parse({ run: fixture.run, snapshot: {
      request: { workspaceId: fixture.scope.workspaceId, workflowId: fixture.scope.workflowId,
        workflowVersionId: fixture.version.id, executionSemanticsVersion: 3, commandId: randomUUID(),
        expectedWorkflowRevision: saved.revision, expectedAgentConfigurationVersionIds: fixture.version.agentConfigurationVersionIds,
        expectedLocationRevision: location.locationRevision, input: fixture.run.input },
      authorizationPrincipalId, executable: { version: fixture.version, configurations: fixture.configurations },
      workflow: { id: fixture.scope.workflowId, workspaceId: fixture.scope.workspaceId, revision: saved.revision,
        currentVersionId: fixture.version.id, archived: false, definition: fixture.version.definition },
      workspace: { id: fixture.scope.workspaceId, archived: false, location }, draft: null,
    } })
    await withExclusiveGraphConnection(pool, (connection) => connection.transaction((sql) =>
      insertRepeatRun(sql, accepted, repeatStartPublication)))
  }
  return fixture
}

export async function ownedAgent3(pool: pg.Pool, fixture: Agent3Fixture, host: RepeatRepositoryHost) {
  const owner = await RunOwnership.acquire(pool, fixture.run.id, () => undefined)
  if (!owner) throw new Error('Synthetic test Run unexpectedly has an owner')
  return { owner, store: new RepeatRunRepository(owner, host, fixture.version) }
}

export function candidateFor(fixture: Agent3Fixture, nodeId = fixture.version.entryNodeId): HarnessExecution {
  const identity = fixture.identities.find((item) => item.workflowNodeId === nodeId)
  if (!identity) throw new Error('Unknown synthetic node')
  return HarnessExecutionSchema.parse({ id: identity.executionId, runId: fixture.run.id, workflowNodeId: nodeId,
    agentId: identity.agentId, agentConfigurationVersionId: identity.agentConfigurationVersionId,
    attempt: 1, input: {}, state: 'queued', createdAt: fixture.createdAt })
}

/** Persists an exact provider completion using evidence supplied by the test's
 * native authority fixture. It cannot fabricate a launch or native session. */
export async function terminalAgent3(_pool: pg.Pool, store: RepeatRunRepository, fixture: Agent3Fixture,
  execution: HarnessExecution, evidence: RepeatNativeEvidence, output: unknown = { done: true }) {
  const completed = HarnessExecutionSchema.parse({ ...execution,
    state: 'completed', result: { outcome: 'succeeded', output }, finishedAt: fixture.createdAt })
  await store.updateExecution(completed, evidence)
  return completed
}

export async function graphHead(pool: pg.Pool, runId: string): Promise<string> {
  return (await pool.query<{ head: string }>('select head_sequence::text as head from run_graph_heads where run_id=$1', [runId])).rows[0]!.head
}

export function setFixtureVersion(fixture: Agent3Fixture, version: WorkflowVersionV3): Agent3Fixture {
  fixture.version = agentWorkflowVersion(version)
  fixture.run = WorkflowRunV3Schema.parse({ ...fixture.run, workflowVersionId: version.id, agentConfigurationVersionIds: version.agentConfigurationVersionIds, approval: version.approval })
  return fixture
}

/** Consume the current paged repository reader without truncating test evidence. */
export async function readCurrentExecutions(runs: Pick<PostgresRunRepository, 'executionPages'>, runId: string): Promise<HarnessExecution[]> {
  const executions: HarnessExecution[] = []
  for await (const page of runs.executionPages(runId)) executions.push(...page)
  return executions
}
