import { randomUUID } from 'node:crypto'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { currentOperatorAuthority } from '../../src/modules/access/runAuthority.js'
import { requireAuthorization } from '../../src/modules/access/policy.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { memoryBoardAuthority } from '../../src/modules/collaboration/memoryBoardAuthority.js'
import { createMemoryBoardService } from '../../src/modules/memory-boards/production.js'
import { createWorkflowNativeCaptureChannel } from '../../src/modules/interactions/workflowNativeCapture.js'
import { PostgresRunRepository } from '../../src/modules/runs/postgres.js'
import { createWorkflowRepositoryServices } from '../../src/modules/runs/workflowRepositoryServices.js'
import { admitRepeatRun } from '../../src/modules/runs/repeatStartAdmission.js'
import { repeatStartPublication } from '../../src/modules/run-graph/repeatStartPublication.js'
import { PostgresWorkflowRepository } from '../../src/modules/workflows/postgres.js'
import { WorkspaceLocationService } from '../../src/modules/workspaces/location.js'
import type { WorkflowNativeVerificationPort } from '../../src/modules/interactions/workflowNativeCapture.js'
import type { GraphTransactionSql } from '../../src/modules/run-graph/connection.js'
import { seedAgent3, type agent3Database } from './wave25Agent3.js'

/** The repository services production wires for every started Run, including the
 * memory board service the pinned coordination protocol requires. */
export function currentRepositoryServices(db: Pick<Awaited<ReturnType<typeof agent3Database>>, 'pool'>,
  captures: WorkflowNativeVerificationPort) {
  const runtime = createWorkflowRepositoryServices(captures)
  return { ...runtime, services: { ...runtime.services,
    memoryBoards: createMemoryBoardService(db.pool, memoryBoardAuthority) } }
}

/** Real typed Save, Start authority, canonical publication, filesystem identity
 * and repository services. No provider is connected and no native proof is
 * manufactured: tests can qualify admission, ownership and pre-submission cuts. */
export async function currentRepositoryFixture(db: Awaited<ReturnType<typeof agent3Database>>,
  f = makeCurrentWorkflowFixture(randomUUID())) {
  await seedAgent3(db.pool, db.directory, f, { run: false })
  const commands = new PostgresCommandCoordinator(db.pool)
  const access = new PostgresAccessService(db.pool)
  const issued = await access.issue({ name: 'Current repository test author', audience: 'operator',
    expiresAt: new Date(Date.now() + 300000), grants: [{ actions: ManagementActionSchema.options,
      scope: { workspaceIds: [f.scope.workspaceId] } }] })
  const locations = new WorkspaceLocationService(db.pool, commands)
  const location = await locations.set(issued.principal, 'http', { workspaceId: f.scope.workspaceId,
    commandId: randomUUID(), expectedLocationRevision: 1, runnerId: locations.runnerId, rootPath: db.directory })
  const revision = Number((await db.pool.query<{ revision: string }>('select revision::text from workflows where id=$1', [f.scope.workflowId])).rows[0]!.revision)
  const accepted = await admitRepeatRun(db.pool, locations, issued.principal, 'http', {
    workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId, workflowVersionId: f.version.id,
    commandId: randomUUID(), executionSemanticsVersion: 3, expectedWorkflowRevision: revision,
    expectedAgentConfigurationVersionIds: f.version.agentConfigurationVersionIds,
    expectedLocationRevision: location.value.locationRevision, input: f.run.input,
  }, repeatStartPublication)
  f.run = accepted.value; f.scope.runId = f.run.id
  const capture = createWorkflowNativeCaptureChannel()
  const repository = new PostgresRunRepository(db.pool, new PostgresWorkflowRepository(db.pool), locations,
    { runtimeRoot: db.directory, ...currentRepositoryServices(db, capture.verify) })
  const authorizeStop = async (sql: GraphTransactionSql) => {
    // The authority reader uses only the promise/string query overload. Keep
    // it on this leased transaction, never on db.pool outside the Stop fence.
    const database = { query: sql.query.bind(sql) as Parameters<typeof currentOperatorAuthority>[0]['query'] }
    const live = await currentOperatorAuthority(database, issued.principal.id)
    requireAuthorization(live.principal, 'runs:stop', { workspaceId: f.scope.workspaceId,
      workflowId: f.scope.workflowId, runId: f.run.id })
  }
  return { f, repository, locations, issued, authorizeStop,
    stop: () => repository.requestStop(f.run.id, authorizeStop) }
}
