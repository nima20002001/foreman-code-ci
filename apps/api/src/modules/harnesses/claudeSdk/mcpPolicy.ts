import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'
import { HarnessExecutionError } from '../errors.js'
import { appMcpServerName } from '../appMcpLauncher.js'

export interface ClaudeMcpToolManifest {
  serverName: string
  source: { kind: 'http'; url: string } | { kind: 'sdk'; name: 'graphql-files'; version: '1.0.0' }
  tools: string[]
}

/** Discover from the accepted endpoint with this owner's scoped credential, never native status or ambient config. */
export async function acceptedClaudeAppTools(input: {
  configuration: ClaudeHarnessConfiguration
  servers: Readonly<Record<string, unknown>>
  token: string | undefined
  signal?: AbortSignal
}): Promise<ClaudeMcpToolManifest[]> {
  const serverName = appMcpServerName(input.configuration.mcpServers)
  const accepted = input.configuration.mcpServers[serverName]
  const supplied = input.servers[serverName] as { type?: string; url?: string; headers?: Record<string, unknown> } | undefined
  if (!accepted || !supplied) return []
  if (!input.token || supplied.type !== 'http' || supplied.url !== accepted.url
    || supplied.headers?.Authorization !== `Bearer ${input.token}`) {
    throw new HarnessExecutionError('CLAUDE_MCP_MANIFEST_SCOPE_CONFLICT', 'MCP discovery requires the accepted server and owner credential.')
  }
  const client = new Client({ name: 'foreman-code-claude-tool-policy', version: '1.0.0' })
  const signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(input.signal ? [input.signal] : [])])
  const transport = new StreamableHTTPClientTransport(new URL(accepted.url), {
    requestInit: { signal, headers: { Authorization: `Bearer ${input.token}` } },
  })
  try {
    await client.connect(transport, { signal })
    const tools: string[] = []
    let cursor: string | undefined
    const cursors = new Set<string>()
    do {
      signal.throwIfAborted()
      const page = await client.listTools(cursor ? { cursor } : undefined, { signal })
      tools.push(...page.tools.map(tool => tool.name))
      cursor = page.nextCursor
      if (tools.length > 512 || cursor && cursors.has(cursor)) {
        throw new HarnessExecutionError('CLAUDE_MCP_MANIFEST_INVALID', 'The accepted MCP tool manifest exceeded its discovery bound.')
      }
      if (cursor) cursors.add(cursor)
    } while (cursor)
    return [{ serverName, source: { kind: 'http', url: accepted.url }, tools }]
  } finally {
    await client.close()
  }
}
