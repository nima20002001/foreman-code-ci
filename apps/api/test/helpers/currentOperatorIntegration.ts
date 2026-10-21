import { OperatorInteractionService } from '../../src/modules/interactions/operator.js'
import { PostgresWorkspaceRepository } from '../../src/modules/workspaces/postgres.js'
import { ExecutionReadinessService } from '../../src/modules/harnesses/executionReadiness.js'
import { NativeRollout } from '../../src/modules/harnesses/nativeRollout.js'
import { randomUUID } from 'node:crypto'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { buildApp } from '../../src/app.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { WorkflowManagementService } from '../../src/modules/workflows/management.js'
import { RunManagementService } from '../../src/modules/runs/management.js'
import { createCurrentNativeProductionFactory } from '../../src/modules/runs/workflowProduction.js'
import { WorkspaceManagementService } from '../../src/modules/workspaces/management.js'
import { OperatorAgentMutationService } from '../../src/modules/workspaces/operatorAgents.js'
import { VersionHistoryService } from '../../src/modules/workflows/historyManagement.js'
import { AgentManagementService } from '../../src/modules/workspaces/agents.js'
import { HarnessCatalogService } from '../../src/modules/harnesses/catalog.js'
import { PostgresSettingsRepository } from '../../src/modules/settings/postgres.js'
import { PostgresFoundationSettingsRepository } from '../../src/modules/settings/foundation.js'
import { FoundationSettingsManagementService } from '../../src/modules/settings/management.js'
import { PostgresOperatorRepository } from '../../src/modules/operators/postgres.js'
import { RunGraphReadService } from '../../src/modules/run-graph/readService.js'
import { checkpointRuntimeFixture } from './wave25Br1003Runtime.js'

/** Real authenticated transport and qualified production binding over the shared
 * provider-boundary fixture. No fake engine Start/Stop receipt or native proof. */
export async function currentOperatorIntegration(options: Parameters<typeof checkpointRuntimeFixture>[2] & { agentManagement?: boolean; graphReads?: boolean; interactions?: boolean } = {}) {
  const f = await checkpointRuntimeFixture(1, 1, options)
  const clients: Client[] = []
  const commands = new PostgresCommandCoordinator(f.db.pool), access = new PostgresAccessService(f.db.pool)
  const writer = await access.issue({ name: 'Current Operator integration', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
    grants: [{ actions: ManagementActionSchema.options, scope: {} }] })
  const dispatchErrors: unknown[] = []
  const binding = createCurrentNativeProductionFactory({ isRuntimeOpen: () => true,
    reportDispatchFailure: (_id, code) => dispatchErrors.push(code) })({ primaryPool: f.db.pool, commands,
    runs: f.runs, workflows: f.workflows, locations: f.locations, engine: f.engine,
    nativeExecutions: f.native, interactions: f.service, checkpointer: f.checkpointer })
  const settings = new PostgresSettingsRepository(f.db.pool)
  const harnesses = new HarnessCatalogService({ qualify: async (configuration) => ({ harness: configuration.harness,
    version: 'fixture', authenticated: true, ready: true, structuredEvents: true, supportsResume: true,
    supportsCancellation: true, supportsWorkingDirectory: true, supportsStartupPrompt: true,
    supportedNativeTools: [], supportedSettings: [], unsupportedCapabilities: [] }) }, settings, commands, f.db.directory)
  const services = { executionReadiness: new ExecutionReadinessService(new NativeRollout({ GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '1' }), harnesses), commands, locations: f.locations, workflows: new WorkflowManagementService(f.db.pool, commands),
    runs: new RunManagementService(f.db.pool, commands, f.runs, f.engine, f.locations, binding),
    workspaces: new WorkspaceManagementService(f.db.pool, commands, f.locations), agents: new AgentManagementService(f.db.pool), harnesses,
    settings: new FoundationSettingsManagementService(new PostgresFoundationSettingsRepository(f.db.pool), commands, harnesses, new PostgresOperatorRepository(f.db.pool)) }
  if (options.agentManagement) Object.assign(services, { extensions: {
    agents: new OperatorAgentMutationService(f.db.pool, commands, harnesses),
    history: new VersionHistoryService(f.db.pool),
  } })
  if (options.graphReads) Object.assign(services, { runGraph: new RunGraphReadService(f.db.pool, { qualifiedReads: true }) })
  if (options.interactions) Object.assign(services, { interactions: new OperatorInteractionService(f.service) })
  const app = buildApp({ ...(options.interactions ? { product: {
    workspaces: new PostgresWorkspaceRepository(f.db.pool, f.workflows, f.runs),
    workflows: f.workflows, runs: f.runs, engine: f.engine, interactions: f.service,
  } } : {}), readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } }, operator: { access, services } })
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    async function connect(token: string) {
      const client = new Client({ name: 'current-operator-test', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const client = await connect(writer.token)
    return { ...f, app, address, client, connect, writer, access, services, commands, dispatchErrors,
      async close() { await Promise.allSettled(clients.map((c) => c.close())); await app.close(); await f.close() },
      async create() {
        const created = (await services.workflows.create(writer.principal, 'mcp', { workspaceId: f.f.scope.workspaceId, commandId: randomUUID(), name: 'Transport current workflow' })).value
        return { workspaceId: f.f.scope.workspaceId, workflowId: created.workflow.id, commandId: randomUUID(), executionSemanticsVersion: 3,
          expectedRevision: created.revision, expectedWorkflowVersionId: null,
          expectedAgentConfigurationVersionIds: f.f.version.agentConfigurationVersionIds,
          graph: { ...f.f.version.definition, id: created.workflow.id, version: created.workflow.version,
            createdAt: created.workflow.createdAt, updatedAt: created.workflow.updatedAt } }
      } }
  } catch (error) { await app.close(); await f.close(); throw error }
}
