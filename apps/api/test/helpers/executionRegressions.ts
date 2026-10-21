import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { WorkflowManagementService } from '../../src/modules/workflows/management.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { agent3Database, seedAgent3 } from './wave25Agent3.js'

export async function executionRegressionDatabase() {
  const database = await agent3Database()
  const close = database.close
  let closing: Promise<void> | undefined
  database.close = () => closing ??= close()
  return database
}

export function regressionAuthoringFixture() {
  let database: Awaited<ReturnType<typeof executionRegressionDatabase>>

  // Cases seed distinct workflows and agents; share only the migrated schema.
  beforeAll(async () => { database = await executionRegressionDatabase() }, 60_000)
  afterAll(async () => { await database?.close() }, 60_000)

  return async (form: 'single' | 'parallel' = 'single') => {
    const db = database
    const f = makeCurrentWorkflowFixture(randomUUID(), form)
    await seedAgent3(db.pool, db.directory, f, { run: false })
    const commands = new PostgresCommandCoordinator(db.pool)
    const access = new PostgresAccessService(db.pool)
    const writer = await access.issue({
      name: 'Regression author', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
      grants: [{ actions: ManagementActionSchema.options, scope: {} }],
    })
    const workflows = new WorkflowManagementService(db.pool, commands)
    const managed = await workflows.get(writer.principal, f.scope.workspaceId, f.scope.workflowId)
    const input = {
      workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId, executionSemanticsVersion: 3,
      commandId: randomUUID(), expectedRevision: managed.revision, expectedWorkflowVersionId: f.version.id,
      expectedAgentConfigurationVersionIds: f.version.agentConfigurationVersionIds,
      graph: f.version.definition,
    }
    return { db, f, commands, writer, workflows, input }
  }
}
