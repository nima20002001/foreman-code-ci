import type { ManagementAction, OperatorToolName } from '@foreman-code/contracts/management'
import { harnessRegistryTools } from '../../modules/harnesses/registryManagement.js'
import { workspaceRootTools } from '../../modules/workspace-roots/transports.js'
import { sourceTools } from '../../modules/sources/mcp.js'
import { trustedConnectionTools } from '../../modules/devices/trustedConnectionManagement.js'
import { nodePlacementChoicesTool, runPlacementTool } from '../../modules/placement/transports.js'
import type { OperatorToolDefinition } from './definition.js'
import { resourceTelemetryTool } from './resourceTelemetry.js'
import { resourceTelemetrySelectorTool } from './resourceTelemetrySelector.js'
import { bugReportTools } from './tools/bugReports.js'
import { buildComputerTools } from './tools/buildComputers.js'
import { deviceOperatorTools } from './tools/devices.js'
import { capabilityTools } from './tools/context.js'
import { harnessTools } from './tools/harnesses.js'
import { harnessMcpTools } from './tools/harnessMcp.js'
import { claudePluginTools } from './tools/claudePlugins.js'
import { settingsTools } from './tools/settings.js'
import { providerAccountTools } from './tools/providerAccounts.js'
import { agentChatTools } from './tools/agentChat.js'
import { sessionControlTools } from './tools/sessionControls.js'
import { workspaceDefaultsTools } from './tools/workspaceDefaults.js'
import { workspaceTools } from './tools/workspaces.js'
import { workflowTools } from './tools/workflows.js'
import { agentTools } from './tools/agents.js'
import { runTools } from './tools/runs.js'
import { subagentTools } from './tools/subagents.js'
import { interactionTools } from './tools/interactions.js'
import { extendedOperatorTools } from './tools/extensions.js'
import { toolSchemaTools } from './tools/toolSchema.js'

/**
 * The Operator MCP tool registry: the single source of truth for every catalogued Operator tool.
 * tools/list registration, operator_get_capabilities and operator_tool_schema_get discovery,
 * permission requirements, denial classification and handlers are all derived from these
 * definitions; nothing else lists tool names, grants or service conditions.
 *
 * To add a tool:
 * 1. Add its name to OperatorToolNameSchema in @foreman-code/contracts/management.
 * 2. Add a defineOperatorTool({...}) entry to the feature's group array (tools/*.ts or the owning
 *    module): name, requires (every grant needed, primary action first, each with its scope),
 *    enabled (the composed services it needs), description, input/output schemas, annotations,
 *    and run (returns the result) or handle (returns its own MCP result).
 * 3. A new group array is added to OPERATOR_TOOL_GROUPS below and registered in server.ts at
 *    its tools/list position.
 * Discovery and capability tests compare the authenticated endpoint with this registry.
 */
export const OPERATOR_TOOL_GROUPS = {
  bugReports: bugReportTools,
  resourceTelemetry: [resourceTelemetryTool, resourceTelemetrySelectorTool],
  harnessRegistry: harnessRegistryTools,
  workspaceRoots: workspaceRootTools,
  sources: sourceTools,
  buildComputers: buildComputerTools,
  devices: deviceOperatorTools,
  trustedConnections: trustedConnectionTools,
  capabilities: capabilityTools,
  harnesses: harnessTools,
  harnessMcp: harnessMcpTools,
  claudePlugins: claudePluginTools,
  settings: settingsTools,
  providerAccounts: providerAccountTools,
  agentChat: agentChatTools,
  sessionControls: sessionControlTools,
  workspaceDefaults: workspaceDefaultsTools,
  workspaces: workspaceTools,
  workflows: workflowTools,
  agents: agentTools,
  runs: runTools,
  placement: [runPlacementTool, nodePlacementChoicesTool],
  subagents: subagentTools,
  interactions: interactionTools,
  extensions: extendedOperatorTools,
  toolSchema: toolSchemaTools,
} satisfies Record<string, readonly OperatorToolDefinition[]>
export type OperatorToolGroup = keyof typeof OPERATOR_TOOL_GROUPS

export const OPERATOR_TOOLS: readonly OperatorToolDefinition[] = Object.values(OPERATOR_TOOL_GROUPS).flat()

export const OPERATOR_TOOL_ACTIONS: ReadonlyArray<{ name: OperatorToolName; action: ManagementAction }> =
  OPERATOR_TOOLS.map((tool) => ({ name: tool.name, action: tool.requires[0][0] }))

const byName = new Map<string, OperatorToolDefinition>(OPERATOR_TOOLS.map((tool) => [tool.name, tool]))
export function operatorTool(name: string): OperatorToolDefinition | undefined {
  return byName.get(name)
}
