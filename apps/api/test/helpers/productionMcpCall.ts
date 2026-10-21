import type { Client } from '@modelcontextprotocol/client'
import { randomUUID } from 'node:crypto'
import { ApiErrorResponseSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'

type ProductionMcpClient = Pick<Client, 'callTool' | 'listTools'>
type ToolRetryPolicy = { acceptsCommandId: boolean; readOnly: boolean }
const clientToolPolicies = new WeakMap<ProductionMcpClient, Promise<Map<string, ToolRetryPolicy>>>()

async function toolRetryPolicy(client: ProductionMcpClient, name: string) {
  let policies = clientToolPolicies.get(client)
  if (!policies) {
    policies = client.listTools().then(({ tools }) => new Map<string, ToolRetryPolicy>(tools.map(tool => [
      tool.name, {
        acceptsCommandId: Object.hasOwn(tool.inputSchema.properties ?? {}, 'commandId'),
        readOnly: tool.annotations?.readOnlyHint === true,
      },
    ]))).catch((error: unknown) => {
      clientToolPolicies.delete(client)
      throw error
    })
    clientToolPolicies.set(client, policies)
  }
  return (await policies).get(name)
}

export async function callProductionMcpTool(client: ProductionMcpClient,
  request: Parameters<Client['callTool']>[0], options?: Parameters<Client['callTool']>[1]) {
  const policy = await toolRetryPolicy(client, request.name)
  const acceptsCommandId = policy?.acceptsCommandId === true
  if (acceptsCommandId && request.arguments?.commandId === undefined) {
    request = { ...request, arguments: { ...request.arguments, commandId: randomUUID() } }
  }
  const commandId = request.arguments?.commandId
  const replayable = policy?.readOnly === true
    || (acceptsCommandId && typeof commandId === 'string' && commandId.trim().length > 0)
  for (let attempt = 0; ; attempt++) {
    const result = await client.callTool(request, options)
    if (!result.isError || !replayable || attempt >= 4) return result
    const failure = ApiErrorResponseSchema.safeParse(decodeMcpToolResult(result))
    const details = failure.success ? failure.data.error.details : undefined
    if (details?.retryable !== true || details.newCommandRequired === true) return result
    // Reuse the whole request so an admitted command is replayed with its original commandId.
    await new Promise<void>(resolve => setTimeout(resolve, 250 * 2 ** attempt))
  }
}
