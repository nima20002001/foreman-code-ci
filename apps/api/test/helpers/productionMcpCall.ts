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
  // Read-only tools replay without a command identity; some accept commandId only on one input arm.
  const acceptsCommandId = policy?.acceptsCommandId === true && policy.readOnly !== true
  const injected = acceptsCommandId && request.arguments?.commandId === undefined
  if (injected) {
    const supplied = request
    request = { ...request, arguments: { ...request.arguments, commandId: randomUUID() } }
    const result = await replayProductionMcpTool(client, request, options, true)
    // Chat tools publish commandId for their exact-target arm only; call other arms as the caller supplied them.
    if (!result.isError || !/Unrecognized keys?:[^,]*commandId/.test(JSON.stringify(result.content))) return result
    return replayProductionMcpTool(client, supplied, options, false)
  }
  const commandId = request.arguments?.commandId
  const replayable = policy?.readOnly === true
    || (acceptsCommandId && typeof commandId === 'string' && commandId.trim().length > 0)
  return replayProductionMcpTool(client, request, options, replayable)
}

async function replayProductionMcpTool(client: ProductionMcpClient, request: Parameters<Client['callTool']>[0],
  options: Parameters<Client['callTool']>[1], replayable: boolean) {
  for (let attempt = 0; ; attempt++) {
    const result = await client.callTool(request, options)
    if (!result.isError || !replayable || attempt >= 4) return result
    const failure = ApiErrorResponseSchema.safeParse(decodedToolResult(result))
    const details = failure.success ? failure.data.error.details : undefined
    if (details?.retryable !== true || details.newCommandRequired === true) return result
    // Reuse the whole request so an admitted command is replayed with its original commandId.
    await new Promise<void>(resolve => setTimeout(resolve, 250 * 2 ** attempt))
  }
}

/** SDK input-validation failures are plain text, not a product error envelope. */
function decodedToolResult(result: Parameters<typeof decodeMcpToolResult>[0]): unknown {
  try {
    return decodeMcpToolResult(result)
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}
