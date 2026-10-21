import { HarnessExecutionError } from './errors.js'
import { isObject, text } from './codexStdioTransport.js'

/** Plugin-backed servers may have no table in mcp_servers. Retain their transport when disabling them. */
export function codexDisabledMcpTransports(
  entries: readonly unknown[], names: readonly string[],
): Record<string, string> {
  const overrides: Record<string, string> = {}
  for (const name of names) {
    const entry = entries.find(value => isObject(value) && value.name === name)
    const transport = isObject(entry) && isObject(entry.transport) ? entry.transport : {}
    const command = text(transport.command)
    const url = text(transport.url)
    if (command) overrides[`mcp_servers.${name}.command`] = command
    else if (url) overrides[`mcp_servers.${name}.url`] = url
    else throw new HarnessExecutionError('CODEX_MCP_INSPECTION_FAILED',
      'Codex MCP configuration inspection did not establish a complete server transport.')
  }
  return overrides
}
