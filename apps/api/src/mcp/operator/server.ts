import { browserOperatorTools } from '../../modules/collaboration/browserTools.js'
import { MCP_DISPLAY_NAME, PRODUCT_SLUG } from '@foreman-code/contracts/product'
import { registerWorkspaceRootAdoptionTool } from '../../modules/workspace-roots/transports.js'
import { registerHostHarnessOverrideTools } from '../../modules/harnesses/instanceSettings/management.js'
import { registerJobTools } from './tools/jobs.js'
import { registerCiTools } from '../shared/ciTools.js'
import { registerJobRuntimeTools } from './tools/jobRuntimeProfiles.js'
import { registerFileReferenceTools } from './tools/fileReferences.js'
import { McpServer } from '@modelcontextprotocol/server'
import { paginateToolLists } from '../toolListPagination.js'
import { cacheToolSchemaConversions } from '../shared/schemaCache.js'
import { stripMcpInputSchemas } from '../shared/inputSchemas.js'
import { retryReadOnlyToolConnections } from '../shared/databaseReadRetry.js'
import { installOperatorPresentation, type OperatorCatalog } from './presentation.js'

import { ManagementActionSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { collectBoundTools, sameCatalogDependencies, type BoundTool } from '../shared/catalog.js'
import { catalogToolAvailable } from './catalogDiscovery.js'
import type { OperatorRequestContext, OperatorServices } from './types.js'
import { registerRunGraphTools } from './tools/runGraph.js'
import { registerRunInspectionTools } from './tools/runInspection.js'
import { registerWorkflowScheduleTools } from './tools/workflowSchedules.js'
import { registerCurrentWorkflowTools } from './tools/currentWorkflow.js'
import { registerWorkflowHierarchyTools } from './tools/workflowHierarchy.js'
import { registerFileRetentionTools } from './tools/fileRetention.js'
import { authorizationPrincipal } from '../../modules/access/policy.js'
import { OPERATOR_TOOL_GROUPS, OPERATOR_TOOLS, type OperatorToolGroup } from './catalog.js'
import { registerToolDefinition, toolAvailable, type OperatorToolDefinition } from './definition.js'
import { invokeOperatorTool } from './invoke.js'

export function createOperatorMcpServer(context: OperatorRequestContext): McpServer {
  const server = new McpServer({ name: PRODUCT_SLUG, title: MCP_DISPLAY_NAME, version: '1.0.0' })
  cacheToolSchemaConversions(server, 'operator')
  stripMcpInputSchemas(server)
  retryReadOnlyToolConnections(server)
  paginateToolLists(server)
  const catalog = installOperatorPresentation(server)
  registerOperatorTools(server, context, catalog)
  return server
}

/** Registers the registry tools this caller can discover, in order. */
export function registerOperatorToolGroup(server: McpServer, context: OperatorRequestContext,
  tools: readonly OperatorToolDefinition[], catalog?: OperatorCatalog | undefined): void {
  for (const tool of tools) {
    if (toolAvailable(context, tool)) registerToolDefinition(server, context, tool, { invoke: invokeOperatorTool, catalog, tools: OPERATOR_TOOLS })
  }
}

const catalogPrincipal: ManagementPrincipal = {
  id: 'mcp-catalog', name: 'MCP catalog', audience: 'operator',
  grants: [{ actions: [...ManagementActionSchema.options], scope: {} }],
  expiresAt: '9999-12-31T00:00:00.000Z', revokedAt: null,
}
interface CatalogContext extends OperatorRequestContext { catalog?: OperatorCatalog | undefined }
const catalogs = new WeakMap<OperatorServices, { dependencies: unknown[]; tools: BoundTool<CatalogContext>[] }>()

/** The service composition owns the immutable schemas, independent of caller grants. */
export function operatorToolCatalog(services: OperatorServices): readonly BoundTool<CatalogContext>[] {
  const dependencies = [...Object.values(services), ...Object.values(services.extensions ?? {}),
    ...Object.values(services.harnessSettings ?? {}), services.workflows?.current, services.workflows?.schedules,
    services.runs?.inspection, services.runs?.history, services.runs?.subagents,
    services.harnessInstances?.qualificationSupported]
  let cached = catalogs.get(services)
  if (!cached || !sameCatalogDependencies(cached.dependencies, dependencies)) {
    const tools = collectBoundTools<CatalogContext>({ services, principal: catalogPrincipal }, (collector, bound) =>
      registerOperatorDefinitions(collector, bound, extra => bound.catalog?.(extra) ?? Promise.resolve([])))
    cached = { dependencies, tools }
    catalogs.set(services, cached)
  }
  return cached.tools
}

export function operatorRequestTools(context: OperatorRequestContext, catalog?: OperatorCatalog) {
  const request: CatalogContext = { ...context, principal: authorizationPrincipal(context.principal), catalog }
  return operatorToolCatalog(context.services).filter(tool => catalogToolAvailable(request, tool.name, OPERATOR_TOOLS)).map(tool => ({
    name: tool.name,
    description: tool.description,
    register: (server: McpServer) => tool.register(server, request),
  }))
}

export function registerOperatorTools(server: McpServer, context: OperatorRequestContext, catalog?: OperatorCatalog): void {
  for (const tool of operatorRequestTools(context, catalog)) tool.register(server)
}

function registerOperatorDefinitions(server: McpServer, context: OperatorRequestContext, catalog?: OperatorCatalog): void {
  for (const tool of browserOperatorTools(context)) registerToolDefinition(server, context, tool,
    { invoke: invokeOperatorTool, catalog, tools: OPERATOR_TOOLS })
  const group = (name: OperatorToolGroup) => registerOperatorToolGroup(server, context, OPERATOR_TOOL_GROUPS[name], catalog)
  group('memoryBoards')
  group('bugReports')
  group('resourceTelemetry')
  group('harnessRegistry')
  if (context.services.workspaceRoots) {
    registerWorkspaceRootAdoptionTool(server, context.services.workspaceRoots, context.principal,
      context.services.commands, () => context.principal)
  }
  group('workspaceRoots')
  if (context.services.harnessInstances) {
    registerHostHarnessOverrideTools(server, context.services.harnessInstances, context.principal, () => context.principal)
  }
  group('sources')
  registerJobTools(server, context)
  registerCiTools(server, context)
  registerJobRuntimeTools(server, context)
  group('buildComputers')
  group('devices')
  group('trustedConnections')
  registerFileReferenceTools(server, context)
  group('capabilities')
  group('harnesses')
  group('harnessMcp')
  group('claudePlugins')
  group('settings')
  group('providerAccounts')
  group('agentChat')
  group('workflowChat')
  group('sessionControls')
  group('workspaceDefaults')
  registerFileRetentionTools(server, context)
  group('workspaces')
  registerCurrentWorkflowTools(server, context)
  registerWorkflowHierarchyTools(server, context)
  group('workflows')
  registerWorkflowScheduleTools(server, context)
  group('agents')
  group('runs')
  group('placement')
  group('subagents')
  registerRunInspectionTools(server, context)
  if (context.services.runGraph) registerRunGraphTools(server, context, context.services.runGraph)
  group('interactions')
  group('extensions')
  group('toolSchema')
}
