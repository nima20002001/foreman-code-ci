import type { McpServer } from '@modelcontextprotocol/server'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { MemoryBoardToolDefinition } from '../../../mcp/operator/tools/memoryBoards.js'
import { toolFailure, toolResult } from '../../../mcp/shared/results.js'
import type { PostgresCommandCoordinator } from '../../commands/postgres.js'
import { DomainError } from '../../errors.js'

/** Typed stand-in for application registry composition; handlers and authentication stay real. */
export function memoryTestRegistry(principal: ManagementPrincipal, commands: PostgresCommandCoordinator) {
  const context = { principal }
  const available = (tool: MemoryBoardToolDefinition) => tool.discoverable(context)
  const invoke = async (tool: MemoryBoardToolDefinition, input: unknown) => {
    try {
      if (!available(tool)) throw new DomainError('ACCESS_DENIED', 'This memory tool is unavailable.', 403)
      return toolResult(await tool.run(context, input))
    } catch (error) {
      if (error instanceof DomainError && error.status === 403) {
        await commands.recordDenied(principal.id, 'mcp', tool.name, `mcp:${tool.name}`)
      }
      return toolFailure(error)
    }
  }
  return {
    available,
    invoke,
    register(server: McpServer, tool: MemoryBoardToolDefinition) {
      server.registerTool(tool.name, {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      }, input => invoke(tool, input))
    },
  }
}
