import { mcpInputSchema } from '@foreman-code/contracts/operator-mcp'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

/** Applies input tolerance consistently to registered Operator and workflow-agent tools. */
export function stripMcpInputSchemas(server: McpServer): void {
  server.registerTool = new Proxy(server.registerTool, {
    apply(register, target, [name, config, callback]) {
      return Reflect.apply(register, target, [name, {
        ...config,
        description: `${config.description ?? ''} Unknown input fields are ignored.`.trim(),
        ...(config.inputSchema instanceof z.core.$ZodType
          ? { inputSchema: mcpInputSchema(config.inputSchema) }
          : {}),
      }, callback])
    },
  })
}
