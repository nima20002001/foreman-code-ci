import { FILE_REFERENCE_TOOL_NAMES } from '../operator/tools/fileReferences.js'
import { GRAPHQL_MCP_ROLE_LABELS, graphqlToolRoles, type GraphqlMcpRole } from '@foreman-code/contracts'
import { FILE_RETENTION_TOOL_NAMES } from '../operator/tools/fileRetention.js'

/** The role policy is shared with the web app; see `GRAPHQL_AGENT_TOOLS` in contracts. */
export type McpRole = GraphqlMcpRole
export const MCP_ROLE_LABELS = GRAPHQL_MCP_ROLE_LABELS
export function toolRoles(name: string): readonly McpRole[] {
  // These backend extension names are not yet in the frozen shared catalog. Never let an
  // unknown-name fallback grant worker access, even when a worker guesses the name directly.
  if (FILE_REFERENCE_TOOL_NAMES.some((candidate) => candidate === name)) return ['operator']
  if (FILE_RETENTION_TOOL_NAMES.some((candidate) => candidate === name)) return ['operator']
  return graphqlToolRoles(name)
}

export function roleList(roles: readonly McpRole[]): string {
  return roles.map((role) => MCP_ROLE_LABELS[role]).join(', ')
}

export function roleInstructions(role: McpRole): string {
  return `Foreman Code MCP tools. Your credential has the ${MCP_ROLE_LABELS[role]} role, and you see only the tools enabled for you. `
    + 'Every call still checks your grants and scope.'
}
