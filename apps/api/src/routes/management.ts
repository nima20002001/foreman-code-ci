import { registerCircleAccountRoutes } from './circleAccounts.js'
import { registerComputerActivityRoutes } from './computerActivity.js'
import { registerBugReportRoutes } from './bugReports.js'
import { registerHostCiRoutes } from './hostCi.js'
import { registerComputerAccountsRoutes } from './computerAccounts.js'
import { registerComputerMaintenanceRoutes } from './computerMaintenance.js'
import { registerComputerSyncRoutes } from './computerSync.js'
import { registerBuildComputerRoutes } from './buildComputers.js'
import { registerRunSubagentRoutes } from './runSubagents.js'
import { registerHarnessRegistryRoutes } from '../modules/harnesses/registryManagement.js'
import { registerDeviceManagementRoutes } from '../modules/devices/management.js'
import { registerWorkspaceRepositoryRoutes } from './workspaceRepository.js'
import { registerWorkspaceRootRoutes } from '../modules/workspace-roots/transports.js'
import { registerSourceRoutes } from './sources.js'
import { registerJobRoutes } from './jobs.js'
import { CurrentWorkflowCreateInputSchema, RunActivitiesInputSchema,
  RunHandoffsReadInputSchema } from '@foreman-code/contracts/wave25'
import { AgentCreateInputSchema, AgentUpdateInputSchema } from '@foreman-code/contracts/management'
import { registerCurrentWorkflowRoutes } from './currentWorkflow.js'
import { registerRunInspectionRoutes } from './runInspection.js'
import { registerCurrentVersionReadRoutes } from './currentVersionReads.js'
import type { FastifyInstance } from 'fastify'
import { registerWorkspaceDefaultsRoutes } from './workspaceDefaults.js'
import { registerPromptSettingsRoutes } from './promptSettings.js'
import { registerHarnessSettingsRoutes } from './harnessSettings.js'
import { pluginHttpRead } from './pluginReadCancellation.js'
import { registerSkillRoutes } from './skills.js'

import {
  AgentGetInputSchema,
  GeneralSettingsUpdateInputSchema,
  CircleCreditAllowanceUpdateInputSchema,
  RemoteExecutionSettingsUpdateInputSchema,
  AgentDefaultsUpdateInputSchema,
  AgentListInputSchema,
  HarnessDefaultsUpdateInputSchema,
  HarnessGetInputSchema,
  HarnessConfigurationCheckInputSchema,
  HarnessConfigurationCheckResultSchema,
  RunEventsListInputSchema,
  RunGetInputSchema,
  RunListInputSchema,
  RunStopInputSchema,
  WorkflowArchiveInputSchema,
  WorkflowBatchArchiveInputSchema,
  WorkflowReorderInputSchema,
  WorkflowGetInputSchema,
  WorkflowListInputSchema,
  WorkflowUpdateInputSchema,
  WorkspaceArchiveInputSchema,
  WorkspaceBatchArchiveInputSchema,
  WorkspaceCreateInputSchema,
  WorkspaceGetInputSchema,
  WorkspaceListInputSchema,
  WorkspaceStorageFoldersListInputSchema, WorkspaceStorageFolderDeleteInputSchema,
  WorkspaceUpdateInputSchema,
  WorkspaceLocationSetInputSchema,
  WorkspaceLocationValidateInputSchema,
  WorkflowDefaultsUpdateInputSchema,
} from '@foreman-code/contracts/management'
import { ManualRunStartInputSchema } from '@foreman-code/contracts/wave25'
import { requireLocalHuman, requirePrincipal } from '../modules/access/http.js'
import type { OperatorServices } from '../mcp/operator/types.js'
import { DomainError } from '../modules/errors.js'

type Params = Record<string, string>
type Query = Record<string, string | undefined>

function routeInput(params: Params, body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new DomainError('INVALID_INPUT', 'The request body must be an object.', 400)
  }
  const input = body as Record<string, unknown>
  for (const [key, value] of Object.entries(params)) {
    if (Object.hasOwn(input, key) && input[key] !== value) {
      throw new DomainError('RESOURCE_ID_MISMATCH', `Body field '${key}' must match the URL.`, 400)
    }
  }
  return { ...input, ...params }
}

function page(query: Query) {
  return {
    ...(query.cursor ? { cursor: query.cursor } : {}),
    ...(query.limit ? { limit: Number(query.limit) } : {}),
    ...(query.includeArchived ? { includeArchived: query.includeArchived === 'true' } : {}),
  }
}

export function registerManagementRoutes(app: FastifyInstance, services: OperatorServices): void {
  registerHostCiRoutes(app, services)
  if (services.circleAccounts) registerCircleAccountRoutes(app, services.circleAccounts)
  if (services.bugReports) registerBugReportRoutes(app, services.bugReports)
  if (services.harnessRegistry) registerHarnessRegistryRoutes(app, services.harnessRegistry, async request => requirePrincipal(request))
  if (services.computerActivity) registerComputerActivityRoutes(app, services.computerActivity)
  if (services.computerAccounts) registerComputerAccountsRoutes(app, services.computerAccounts)
  if (services.computerMaintenance) registerComputerMaintenanceRoutes(app, services.computerMaintenance)
  if (services.computerSync) registerComputerSyncRoutes(app, services.computerSync)
  if (services.buildComputers) registerBuildComputerRoutes(app, services.buildComputers)
  if (services.devices) registerDeviceManagementRoutes(app, services.devices, async request => requirePrincipal(request))
  if (services.workspaceRepositories) registerWorkspaceRepositoryRoutes(app, services.workspaceRepositories)
  if (services.workspaceRoots) registerWorkspaceRootRoutes(app, services.workspaceRoots)
  if (services.sources) registerSourceRoutes(app, services.sources)
  if (services.jobs) registerJobRoutes(app, services.jobs)
  registerCurrentWorkflowRoutes(app, services.workflows, services.runs)
  registerCurrentVersionReadRoutes(app, services)
  registerRunInspectionRoutes(app, services)
  registerRunSubagentRoutes(app, services)
  registerWorkspaceDefaultsRoutes(app, services)
  registerHarnessSettingsRoutes(app, services)
  // Board authoring creates and edits Agents through the same service as the
  // Operator MCP agent_create/agent_update tools (graph:edit via HTTP policy).
  if (services.extensions) registerSkillRoutes(app, services.extensions.skills, services.extensions.skillUsage)
  if (services.extensions) {
    const agents = services.extensions.agents
    app.post<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId/agents', async (request, reply) => {
      const result = await agents.create(requirePrincipal(request), AgentCreateInputSchema.parse(routeInput(request.params, request.body)), 'http')
      if (result && typeof result === 'object' && 'replayed' in result && result.replayed === false) reply.code(201)
      return result
    })
    app.patch<{ Params: Params & { agentId: string }; Body: unknown }>('/api/management/workspaces/:workspaceId/agents/:agentId', async (request) =>
      agents.update(requirePrincipal(request), AgentUpdateInputSchema.parse(routeInput(request.params, request.body)), 'http'))
  }
  app.get<{ Querystring: Query }>('/api/management/workspaces', async (request) =>
    services.workspaces.list(requirePrincipal(request), WorkspaceListInputSchema.parse(page(request.query))))
  app.get<{ Querystring: Query }>('/api/management/workspace-storage/folders', async (request) =>
    services.workspaces.storageFolders.list(requirePrincipal(request), WorkspaceStorageFoldersListInputSchema.parse(page(request.query))))
  app.post<{ Body: unknown }>('/api/management/workspace-storage/folders/delete', async (request) =>
    services.workspaces.storageFolders.delete(requirePrincipal(request), 'http', WorkspaceStorageFolderDeleteInputSchema.parse(request.body)))
  app.post<{ Body: unknown }>('/api/management/workspaces', async (request, reply) => {
    const input = WorkspaceCreateInputSchema.parse(request.body)
    if (input.parentPath) requireLocalHuman(request)
    const result = await services.workspaces.create(requirePrincipal(request), 'http', input)
    reply.code(result.replayed ? 200 : 201)
    return result
  })
  app.get<{ Params: Params }>('/api/management/workspaces/:workspaceId', async (request) => {
    const input = WorkspaceGetInputSchema.parse(request.params)
    return services.workspaces.get(requirePrincipal(request), input.workspaceId)
  })
  app.patch<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId', async (request) =>
    services.workspaces.update(requirePrincipal(request), 'http', WorkspaceUpdateInputSchema.parse(routeInput(request.params, request.body))))
  app.post<{ Body: unknown }>('/api/management/workspaces/batch-archive', async (request) =>
    services.workspaces.archiveBatch(requirePrincipal(request), 'http', WorkspaceBatchArchiveInputSchema.parse(request.body)))
  app.delete<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId', async (request) =>
    services.workspaces.archive(requirePrincipal(request), 'http', WorkspaceArchiveInputSchema.parse(routeInput(request.params, request.body))))
  app.post<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId/location/validate', async (request) =>
    services.locations.validate(requirePrincipal(request), 'http', WorkspaceLocationValidateInputSchema.parse(routeInput(request.params, request.body))))
  app.put<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId/location', async (request) =>
    services.locations.set(requirePrincipal(request), 'http', WorkspaceLocationSetInputSchema.parse(routeInput(request.params, request.body))))

  app.get<{ Params: Params; Querystring: Query }>('/api/management/workspaces/:workspaceId/workflows', async (request) =>
    services.workflows.list(requirePrincipal(request), WorkflowListInputSchema.parse({ ...request.params, ...page(request.query) })))
  app.post<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId/workflows', async (request, reply) => {
    const result = await services.workflows.create(requirePrincipal(request), 'http', CurrentWorkflowCreateInputSchema.parse(routeInput(request.params, request.body)))
    reply.code(result.replayed ? 200 : 201)
    return result
  })
  app.get<{ Params: Params }>('/api/management/workspaces/:workspaceId/workflows/:workflowId', async (request) => {
    const input = WorkflowGetInputSchema.parse(request.params)
    return services.workflows.get(requirePrincipal(request), input.workspaceId, input.workflowId)
  })
  app.patch<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId/workflows/:workflowId', async (request) =>
    services.workflows.update(requirePrincipal(request), 'http', WorkflowUpdateInputSchema.parse(routeInput(request.params, request.body))))
  app.post<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId/workflows/batch-archive', async (request) =>
    services.workflows.archiveBatch(requirePrincipal(request), 'http', WorkflowBatchArchiveInputSchema.parse(routeInput(request.params, request.body))))
  app.put<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId/workflows/order', async (request) =>
    services.workflows.reorder(requirePrincipal(request), 'http', WorkflowReorderInputSchema.parse(routeInput(request.params, request.body))))
  app.delete<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId/workflows/:workflowId', async (request) =>
    services.workflows.archive(requirePrincipal(request), 'http', WorkflowArchiveInputSchema.parse(routeInput(request.params, request.body))))

  app.get<{ Params: Params; Querystring: Query }>('/api/management/workspaces/:workspaceId/agents', async (request) =>
    services.agents.list(requirePrincipal(request), AgentListInputSchema.parse({ ...page(request.query), ...(request.query.workflowId !== undefined ? { workflowId: request.query.workflowId } : {}), ...request.params })))
  app.get<{ Params: Params }>('/api/management/workspaces/:workspaceId/agents/:agentId', async (request) => {
    const input = AgentGetInputSchema.parse(request.params)
    return services.agents.get(requirePrincipal(request), input.workspaceId, input.agentId)
  })

  app.post<{ Body: unknown }>('/api/management/harnesses/validate', async (request, reply) => {
    const input = HarnessConfigurationCheckInputSchema.parse(request.body)
    return pluginHttpRead(request, reply, async (signal) => HarnessConfigurationCheckResultSchema.parse(
      await services.harnesses.checkConfiguration(requirePrincipal(request), input.configuration, signal)))
  })

  app.get('/api/management/harnesses', async (request) => services.harnesses.list(requirePrincipal(request)))
  app.get<{ Params: Params }>('/api/management/harnesses/:harness', async (request) => {
    const input = HarnessGetInputSchema.parse(request.params)
    return services.harnesses.get(requirePrincipal(request), input.harness)
  })
  app.put<{ Body: unknown }>('/api/management/harnesses/defaults', async (request) =>
    services.harnesses.updateDefaults(requirePrincipal(request), 'http', HarnessDefaultsUpdateInputSchema.parse(request.body)))

  if (services.remoteExecution) {
    app.get('/api/management/settings/remote-execution', request =>
      services.remoteExecution!.read(requirePrincipal(request)))
    app.put<{ Body: unknown }>('/api/management/settings/remote-execution', request =>
      services.remoteExecution!.update(requirePrincipal(request), 'http',
        RemoteExecutionSettingsUpdateInputSchema.parse(request.body)))
  }
  if (services.settings) {
    registerPromptSettingsRoutes(app, services.settings)
    app.get('/api/management/settings/general', async request =>
      services.settings!.getGeneralSettings(requirePrincipal(request)))
    app.put<{ Body: unknown }>('/api/management/settings/general', async request =>
      services.settings!.updateGeneralSettings(requirePrincipal(request), 'http',
        GeneralSettingsUpdateInputSchema.parse(request.body)))
    app.get('/api/management/settings/circle-credits', async request =>
      services.settings!.getCircleCreditAllowance(requirePrincipal(request)))
    app.put<{ Body: unknown }>('/api/management/settings/circle-credits', async request =>
      services.settings!.updateCircleCreditAllowance(requirePrincipal(request), 'http',
        CircleCreditAllowanceUpdateInputSchema.parse(request.body)))
    app.get('/api/management/settings/agents', async (request) =>
      services.settings!.getAgentDefaults(requirePrincipal(request)))
    app.put<{ Body: unknown }>('/api/management/settings/agents', async (request) =>
      services.settings!.updateAgentDefaults(requirePrincipal(request), 'http', AgentDefaultsUpdateInputSchema.parse(request.body)))
    app.get('/api/management/settings/workflows', async (request) =>
      services.settings!.getWorkflowDefaults(requirePrincipal(request)))
    app.put<{ Body: unknown }>('/api/management/settings/workflows', async (request) =>
      services.settings!.updateWorkflowDefaults(requirePrincipal(request), 'http', WorkflowDefaultsUpdateInputSchema.parse(request.body)))
  }

  app.get<{ Params: Params; Querystring: Query }>('/api/management/workspaces/:workspaceId/runs', async (request) =>
    services.runs.list(requirePrincipal(request), RunListInputSchema.parse({ ...page(request.query), ...(request.query.workflowId !== undefined ? { workflowId: request.query.workflowId } : {}), ...request.params })))
  app.get<{ Params: Params }>('/api/management/workspaces/:workspaceId/runs/:runId', async (request) => {
    const input = RunGetInputSchema.parse(request.params)
    return services.runs.get(requirePrincipal(request), input.workspaceId, input.runId)
  })
  app.get<{ Params: Params; Querystring: Query }>('/api/management/workspaces/:workspaceId/runs/:runId/events', async (request) =>
    services.runs.events(requirePrincipal(request), RunEventsListInputSchema.parse({
      ...request.params,
      ...(request.query.cursor ? { afterSequence: Number(request.query.cursor) } : {}),
      ...(request.query.limit ? { limit: Number(request.query.limit) } : {}),
    })))
  app.get<{ Params: Params; Querystring: Query }>('/api/management/workspaces/:workspaceId/runs/:runId/activities', async (request) =>
    services.runs.activities.read(requirePrincipal(request), RunActivitiesInputSchema.parse({
      ...request.params,
      ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
      ...(request.query.limit ? { limit: Number(request.query.limit) } : {}),
    })))
  app.get<{ Params: Params }>('/api/management/workspaces/:workspaceId/runs/:runId/handoffs', async (request) =>
    services.runs.handoffs.read(requirePrincipal(request), RunHandoffsReadInputSchema.parse(request.params)))
  app.post<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId/workflows/:workflowId/runs', async (request, reply) => {
    const result = await services.runs.start(requirePrincipal(request), 'http', ManualRunStartInputSchema.parse(routeInput(request.params, request.body)))
    reply.code(202)
    return result
  })
  app.post<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId/workflows/:workflowId/runs/start-resolution',
    async request => services.runs.resolveStart(requirePrincipal(request), 'http',
      ManualRunStartInputSchema.parse(routeInput(request.params, request.body))))
  app.post<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId/runs/:runId/stop', async (request) =>
    services.runs.stop(requirePrincipal(request), 'http', RunStopInputSchema.parse(routeInput(request.params, request.body))))
}
