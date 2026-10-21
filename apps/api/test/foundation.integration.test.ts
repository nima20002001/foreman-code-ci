import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'

import { DEFAULT_AGENT_DEFAULTS } from '@foreman-code/contracts'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { applyApplicationMigrations, migrations } from '../src/infrastructure/migrations.js'
import { ensureAcceptanceSeed } from '../src/infrastructure/seed.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'

const connectionString = process.env.TEST_DATABASE_URL

describe.skipIf(!connectionString)('HAP-01 durable foundation', () => {
  let schema: string
  let admin: pg.Pool
  let pool: pg.Pool
  beforeAll(async () => {
    let database: URL
    try { database = new URL(connectionString!) } catch { throw new Error('Use a loopback PostgreSQL database explicitly named for tests') }
    if (!['postgres:', 'postgresql:'].includes(database.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname)
      || !/(?:^|[_-])test(?:db)?(?:$|[_-])/i.test(decodeURIComponent(database.pathname.slice(1)))
      || database.search || database.hash) throw new Error('Use a loopback PostgreSQL database explicitly named for tests')
    schema = `hap01_${randomUUID().replaceAll('-', '')}`
    admin = new pg.Pool({ connectionString })
    await createFixtureSchema(admin, schema)
    pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
    await applyApplicationMigrations(pool)
  }, 60_000)
  afterAll(async () => {
    await pool?.end()
    if (admin) {
      try { await dropFixtureSchema(admin, schema) } finally { await admin.end() }
    }
  })

  it('migrates, versions defaults and preserves stable operator identities', async () => {
    await applyApplicationMigrations(pool)
    await applyApplicationMigrations(pool)
    expect((await pool.query<{ version: number }>('select version from application_migrations order by version')).rows.map((row) => row.version)).toEqual(migrations.map((migration) => migration.version).toSorted((a, b) => a - b))
    await ensureAcceptanceSeed(pool)

    const settings = new PostgresFoundationSettingsRepository(pool)
    const original = await settings.getAgentDefaults()
    const changed = structuredClone(DEFAULT_AGENT_DEFAULTS)
    changed.coder.harness = { ...changed.coder.harness, model: 'fixture-next-model' }
    const next = await settings.updateAgentDefaults(changed, original.revision)
    expect(next.versionId).toBeTruthy()
    expect(original.value.coder.harness.model).not.toBe('fixture-next-model')
    await expect(settings.updateAgentDefaults(DEFAULT_AGENT_DEFAULTS, original.revision)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    const competingDefaults = await Promise.allSettled([
      settings.updateWorkflowDefaults({ approvalHandler: 'user' }, 0),
      settings.updateWorkflowDefaults({ approvalHandler: 'user' }, 0),
    ])
    expect(competingDefaults.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(competingDefaults.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const workflowDefaults = await settings.getWorkflowDefaults()
    await settings.updateWorkflowDefaults({ approvalHandler: 'user' }, workflowDefaults.revision)
    const workflows = new WorkflowManagementService(pool, new PostgresCommandCoordinator(pool))
    const access = new PostgresAccessService(pool)
    const principal = (await access.issue({
      name: 'Settings copy proof', audience: 'operator',
      grants: [{ actions: ['workflows:create', 'workflows:read'], scope: { workspaceIds: ['workspace-1'] } }],
      expiresAt: new Date(Date.now() + 60_000),
    })).principal
    const createdWorkflow = await workflows.create(principal, 'http', {
      workspaceId: 'workspace-1', commandId: 'settings-copy-workflow', name: 'Copied workflow defaults',
    })
    expect(createdWorkflow.value.workflow.approval).toEqual({ handler: 'user' })
    const nextWorkflowDefaults = await settings.getWorkflowDefaults()
    await settings.updateWorkflowDefaults({ approvalHandler: 'user' }, nextWorkflowDefaults.revision)
    expect((await workflows.get(principal, 'workspace-1', createdWorkflow.value.workflow.id)).workflow.approval).toEqual({ handler: 'user' })

    const operators = new PostgresOperatorRepository(pool)
    const firstOperator = await operators.ensure()
    const secondOperator = await operators.ensure()
    expect(secondOperator).toEqual(firstOperator)

    await expect(access.issue({ name: 'invalid worker', audience: 'worker', grants: [], expiresAt: new Date(Date.now() + 60_000) })).rejects.toMatchObject({ code: 'WORKER_AGENT_REQUIRED' })
    const worker = await access.issue({ name: 'coder', audience: 'worker', agentId: 'agent-developer', grants: [], expiresAt: new Date(Date.now() + 60_000) })
    expect(worker.principal.agentId).toBe('agent-developer')
    await expect(access.authenticate(worker.token, 'worker')).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    await expect(access.authenticate(worker.token, 'operator')).rejects.toMatchObject({ code: 'AUTH_WRONG_AUDIENCE' })

  }, 30_000)
})
