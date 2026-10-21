import { basename } from 'node:path'
import type { McpDetection, AgentHarness } from '@foreman-code/contracts'
import type { NativeMcpEntryEvidence, NativeMcpHttpCredentialAcknowledgement } from '../mcpDetection.js'
import { appMcpServerName, isSupportedAppMcpServerName, isSupportedAppMcpTokenName } from '../appMcpLauncher.js'
import { DomainError } from '../../errors.js'

export function assertClaudeCredentialEndpoint(entry: NativeMcpEntryEvidence | undefined, endpoint: string): void {
  // Before bearer delivery, Claude's OAuth registration can fail on this bearer-only endpoint.
  // Connection health and the SDK credential acknowledgement are checked after delivery.
  if (!entry || !isSupportedAppMcpServerName(entry.name) || entry.transport !== 'streamable-http'
    || entry.endpoint !== endpoint || entry.enabled === false
    || !['connected', 'authentication_required', 'status_unavailable', 'broken'].includes(entry.status ?? '')) {
    throw new DomainError('APP_MCP_PREFLIGHT_FAILED',
      'The owned Claude query has no accepted Foreman Code HTTP endpoint.', 409, {
        expectedEndpoint: endpoint,
        observed: entry ? { name: entry.name, transport: entry.transport, endpoint: entry.endpoint,
          enabled: entry.enabled, status: entry.status } : null,
      })
  }
}

export interface ClaudeMcpControlServer {
  name: string
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
  source?: string
  configuration: { type?: string; url?: string; command?: string; argumentCount?: number } | null
  toolNames: readonly string[]
  credentialEnvironmentVariables: readonly string[]
}
export interface ClaudeMcpInspection {
  generation: string
  initializationAnswered: true
  servers: readonly ClaudeMcpControlServer[]
  checkedAt: string
  httpCredentialAcknowledgement?: NativeMcpHttpCredentialAcknowledgement
  currentAuthorizationScope?: string
}
function safeUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value)
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return undefined
    return parsed.toString()
  } catch { return undefined }
}
export function decodeClaudeMcpControl(rows: readonly unknown[], generation: string, checkedAt: string,
  credentials: Pick<ClaudeMcpInspection, 'httpCredentialAcknowledgement' | 'currentAuthorizationScope'> = {}): ClaudeMcpInspection {
  if (rows.length > 128) throw new Error('Claude MCP control snapshot exceeds the bounded server window')
  const servers = rows.map((raw): ClaudeMcpControlServer => {
    if (!raw || typeof raw !== 'object') throw new Error('Claude MCP control server is malformed')
    const row = raw as Record<string, unknown>
    if (typeof row.name !== 'string' || !row.name || !['connected', 'failed', 'needs-auth', 'pending', 'disabled'].includes(String(row.status))) throw new Error('Claude MCP control identity/status is malformed')
    const config = row.config && typeof row.config === 'object' ? row.config as Record<string, unknown> : undefined
    // Native config may contain resolved credentials. Only transport locator fields leave this boundary.
    const configuration = config ? {
      ...(typeof config.type === 'string' ? { type: config.type } : {}),
      ...(typeof config.url === 'string' && safeUrl(config.url) ? { url: safeUrl(config.url)! } : {}),
      ...(typeof config.command === 'string' ? { command: basename(config.command) } : {}),
      ...(Array.isArray(config.args) ? { argumentCount: config.args.length } : {}),
    } : null
    const toolNames = Array.isArray(row.tools) ? row.tools.slice(0, 512).flatMap((value) => value && typeof value === 'object' && typeof (value as Record<string, unknown>).name === 'string' ? [(value as { name: string }).name] : []) : []
    const environment = config?.env && typeof config.env === 'object' ? config.env as Record<string, unknown> : {}
    const credentialEnvironmentVariables = Object.keys(environment).filter(isSupportedAppMcpTokenName)
    return { name: row.name, status: row.status as ClaudeMcpControlServer['status'], configuration, toolNames, credentialEnvironmentVariables,
      ...(typeof row.source === 'string' ? { source: row.source } : {}) }
  })
  return { generation, initializationAnswered: true, servers, checkedAt, ...credentials }
}
export function claudeMcpDetection(snapshot: ClaudeMcpInspection, expected: { serverName: string; url?: string }): McpDetection {
  const entries = Object.fromEntries(snapshot.servers.map((entry) => [entry.name, entry]))
  const serverName = appMcpServerName(entries, expected.serverName)
  const server = snapshot.servers.find((entry) => entry.name === serverName)
  const endpointMatches = expected.url ? server?.configuration?.url === safeUrl(expected.url) : null
  const credentialVariable = server?.credentialEnvironmentVariables.find(isSupportedAppMcpTokenName)
  const environmentMatches = server?.configuration?.type === 'stdio' && credentialVariable !== undefined
  const acknowledgement = snapshot.httpCredentialAcknowledgement
  const headerMatches = Boolean(acknowledgement && acknowledgement.source === 'sdk_set_mcp_servers'
    && acknowledgement.serverName === serverName && snapshot.generation
    && acknowledgement.generation === snapshot.generation && snapshot.currentAuthorizationScope
    && acknowledgement.authorizationScope === snapshot.currentAuthorizationScope
    && expected.url && endpointMatches && server?.configuration?.type === 'http'
    && server.configuration.url === safeUrl(acknowledgement.endpoint) && server.status === 'connected')
  const state: McpDetection['state'] = !server ? 'not_detected'
    : endpointMatches === false ? 'misconfigured'
      : server.status === 'needs-auth' ? 'authentication_required' : server.status === 'failed' ? 'broken'
        : server.status === 'disabled' ? 'disabled' : server.status === 'pending' ? 'status_unavailable' : 'connected'
  return { harness: 'claude' as AgentHarness, serverName, state, endpointMatches,
    credentialEnvironmentVariable: environmentMatches ? credentialVariable : null,
    credentialArrangement: headerMatches ? { kind: 'scoped_http_header' }
      : environmentMatches ? { kind: 'environment_variable', environmentVariable: credentialVariable! } : { kind: 'unknown' },
    checkedAt: snapshot.checkedAt,
    detail: 'Observed SDK MCP control status/configuration on the same owned query; saved settings are not connection evidence.' }
}
