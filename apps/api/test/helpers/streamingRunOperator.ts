import { RunStartV3InputSchema } from '@foreman-code/contracts/wave25'
import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import { buildApp } from '../../src/app.js'
import type { OperatorServices } from '../../src/mcp/operator/types.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { OperatorInteractionService } from '../../src/modules/interactions/operator.js'
import { RunManagementService } from '../../src/modules/runs/management.js'
import { createCurrentNativeProductionFactory } from '../../src/modules/runs/workflowProduction.js'
import type { checkpointRuntimeFixture } from './wave25Br1003Runtime.js'

export async function streamingOperator(f: Awaited<ReturnType<typeof checkpointRuntimeFixture>>) {
  const access = new PostgresAccessService(f.db.pool)
  const reader = await access.issue({ name: 'Streaming Run reader', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['runs:read', 'interactions:read'],
      scope: { workspaceIds: [f.f.scope.workspaceId] } }] })
  const writer = await access.issue({ name: 'Streaming Run writer', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000), grants: [
      { actions: ['runs:start', 'runs:read', 'runs:stop'],
        scope: { workspaceIds: [f.f.scope.workspaceId], workflowIds: [f.f.scope.workflowId] } },
      { actions: ['workspace_locations:read', 'workspace_locations:update'],
        scope: { workspaceIds: [f.f.scope.workspaceId] } },
    ] })
  vi.mocked(f.locations.revalidateSnapshot).mockRestore()
  const location = await f.locations.set(writer.principal, 'http', {
    workspaceId: f.f.scope.workspaceId, commandId: randomUUID(), expectedLocationRevision: 1,
    runnerId: f.locations.runnerId, rootPath: f.db.directory,
  })
  const row = (await f.db.pool.query<{ revision: string }>(
    'select revision::text from workflows where id=$1', [f.f.scope.workflowId])).rows[0]!
  const input = RunStartV3InputSchema.parse({
    workspaceId: f.f.scope.workspaceId, workflowId: f.f.scope.workflowId, workflowVersionId: f.f.version.id,
    commandId: randomUUID(), executionSemanticsVersion: 3, expectedWorkflowRevision: Number(row.revision),
    expectedAgentConfigurationVersionIds: f.f.version.agentConfigurationVersionIds,
    expectedLocationRevision: location.value.locationRevision, input: {},
  })
  const commands = new PostgresCommandCoordinator(f.db.pool)
  const dispatchErrors: unknown[] = []
  const binding = createCurrentNativeProductionFactory({ isRuntimeOpen: () => true,
    reportDispatchFailure: (_runId, _code, error) => dispatchErrors.push(error) })({
    primaryPool: f.db.pool, commands, runs: f.runs, workflows: f.workflows, locations: f.locations,
    engine: f.engine, nativeExecutions: f.native, interactions: f.service, checkpointer: f.checkpointer,
  })
  const services = {
    commands,
    runs: new RunManagementService(f.db.pool, commands, f.runs, f.engine, f.locations, binding),
    interactions: new OperatorInteractionService(f.service),
  } as OperatorServices
  const app = buildApp({ readiness: { database: { ping: async () => { await f.db.pool.query('select 1') } },
    checkpoints: { ping: async () => undefined } }, operator: { access, services } })
  return { app, access, reader, writer, input, dispatchErrors }
}
