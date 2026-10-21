import type { McpServer } from '@modelcontextprotocol/server'
import { GRAPHQL_AGENT_TOOLS } from '@foreman-code/contracts'
import { AgentReferenceListInputSchema, AgentReferenceManifestSchema,
  AgentFileReadInputSchema, AgentFileReadResultSchema } from '@foreman-code/contracts/files'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { AgentReferenceService } from '../../modules/files/references/agentService.js'
import { toolFailure, toolResult } from './results.js'

export function registerExecutionReferenceTools(server: McpServer, principal: ManagementPrincipal,
  service: AgentReferenceService): void {
  const references = service.forExecution(principal)
  const invoke = async (read: () => Promise<unknown>) => {
    try { return toolResult(await read()) }
    catch (error) { return toolFailure(error, 'The reference could not be read.') }
  }
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  server.registerTool('files.references_list', {
    description: GRAPHQL_AGENT_TOOLS['files.references_list'].description,
    inputSchema: AgentReferenceListInputSchema, outputSchema: AgentReferenceManifestSchema, annotations,
  }, input => invoke(() => references.list(input)))
  server.registerTool('files.reference_read', {
    description: GRAPHQL_AGENT_TOOLS['files.reference_read'].description,
    inputSchema: AgentFileReadInputSchema, outputSchema: AgentFileReadResultSchema, annotations,
  }, input => invoke(() => references.read(input)))
}
