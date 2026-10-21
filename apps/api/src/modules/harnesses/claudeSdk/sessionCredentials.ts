/** Owned SDK control operations and scoped MCP credential delivery. */
import { readProductEnvironment } from '@foreman-code/contracts/product-environment'
import type { NativeSessionStart } from '../port.js'
import { HarnessExecutionError } from '../errors.js'
import { decodeClaudeMcpControl, type ClaudeMcpInspection } from './mcpInspection.js'
import type { ClaudeManagerContext, Runtime } from './sessionTypes.js'
import { filterMcpServers, authorizationScope } from './sessionState.js'

export async function ownedControl<T>(ctx: ClaudeManagerContext, runtime: Runtime, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  // Reserve before the first await and keep input fenced through actual SDK cleanup.
  if (runtime.active || runtime.controlPending) throw new HarnessExecutionError('CLAUDE_INSPECTION_BUSY', 'The pre-input control operation cannot overlap model work or another control operation.')
  if (runtime.closed || ctx.disposed) throw new HarnessExecutionError('CLAUDE_INSPECTION_CLOSED', 'The owned SDK query is closed.')
  runtime.controlPending = true
  let closing: Promise<void> | undefined
  const close = () => {
    runtime.closed = true
    delete runtime.httpCredentialAcknowledgement
    closing ??= runtime.sdk.close()
    void closing.catch(() => {
      // ignore: finally awaits the same close promise and propagates its failure.
    })
  }
  const timer = setTimeout(close, ctx.options.initializationTimeoutMs ?? 10_000)
  signal?.addEventListener('abort', close, { once: true })
  try {
    const value = await operation() // SDK close rejects/joins the actual control waiter; no abandoned RPC race.
    signal?.throwIfAborted()
    if (runtime.closed || ctx.disposed) throw new HarnessExecutionError('CLAUDE_INSPECTION_CLOSED', 'The owned SDK control operation closed or timed out.')
    return value
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', close)
    try { if (closing) await closing } finally { runtime.controlPending = false }
  }
}

export function inspectionCredentials(ctx: ClaudeManagerContext, runtime: Runtime): Pick<ClaudeMcpInspection, 'httpCredentialAcknowledgement' | 'currentAuthorizationScope'> {
  const acknowledgement = runtime.httpCredentialAcknowledgement
  if (runtime.closed || ctx.disposed || acknowledgement && (acknowledgement.generation !== runtime.generation
    || acknowledgement.authorizationScope !== runtime.currentAuthorizationScope)) delete runtime.httpCredentialAcknowledgement
  return { currentAuthorizationScope: runtime.currentAuthorizationScope,
    ...(runtime.httpCredentialAcknowledgement ? { httpCredentialAcknowledgement: { ...runtime.httpCredentialAcknowledgement } } : {}) }
}

export function managedHttpCredential(ctx: ClaudeManagerContext, start: NativeSessionStart, servers: Readonly<Record<string, unknown>>, serverName: string): { endpoint: string } | undefined {
  const config = servers[serverName] as Record<string, unknown> | undefined
  if (config?.type !== 'http') return undefined
  const headers = config.headers && typeof config.headers === 'object' ? config.headers as Record<string, unknown> : {}
  const authorization = Object.entries(headers).filter(([key]) => key.toLowerCase() === 'authorization')
  if (!authorization.length) return undefined
  const token = readProductEnvironment(start.environment?.variables ?? {}, 'MCP_TOKEN')
  let endpoint: URL | undefined
  let expectedEndpoint: URL | undefined
  try {
    if (typeof config.url === 'string') endpoint = new URL(config.url)
    if (ctx.options.expectedMcp?.url) expectedEndpoint = new URL(ctx.options.expectedMcp.url)
  } catch { /* ignore: invalid locators fail the credential scope validation below. */ }
  if (!token || authorization.length !== 1 || authorization[0]![1] !== `Bearer ${token}` || !endpoint
    || !['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || ctx.options.expectedMcp?.url && endpoint.toString() !== expectedEndpoint?.toString()) {
    throw new HarnessExecutionError('CLAUDE_MCP_CREDENTIAL_SCOPE_CONFLICT', 'Managed HTTP credentials do not match the admitted authorization scope and endpoint.')
  }
  return { endpoint: endpoint.toString() }
}

export async function deliverCredentials(ctx: ClaudeManagerContext, runtime: Runtime, start: NativeSessionStart, servers: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<ClaudeMcpInspection> {
  servers = filterMcpServers(start, servers)
  const managedName = ctx.expectedMcp.serverName
  const httpCredential = managedHttpCredential(ctx, start, servers, managedName)
  delete runtime.httpCredentialAcknowledgement
  delete runtime.credentialServers
  if (!runtime.sdk.setMcpServers) throw new HarnessExecutionError('CLAUDE_MCP_CONTROL_UNAVAILABLE', 'The actual SDK scoped MCP control update is unavailable.')
  return ownedControl(ctx, runtime, async () => {
    runtime.currentAuthorizationScope = authorizationScope(ctx, start)
    const raw = await runtime.sdk.setMcpServers!(servers).catch(() => {
      throw new HarnessExecutionError('CLAUDE_MCP_CREDENTIAL_DELIVERY_UNCONFIRMED', 'The SDK did not confirm its owned MCP control update.')
    })
    const response = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    if (!Array.isArray(response.added) || !Array.isArray(response.removed) || !response.errors || typeof response.errors !== 'object' || Object.keys(response.errors).length
      || httpCredential && !response.added.includes(managedName)) {
      throw new HarnessExecutionError('CLAUDE_MCP_CREDENTIAL_DELIVERY_UNCONFIRMED', 'The SDK did not confirm its owned MCP control update.')
    }
    signal?.throwIfAborted()
    if (runtime.closed || ctx.disposed) throw new HarnessExecutionError('CLAUDE_INSPECTION_CLOSED', 'The owned SDK query closed before credential acknowledgment.')
    if (httpCredential) runtime.httpCredentialAcknowledgement = { source: 'sdk_set_mcp_servers', serverName: managedName,
      endpoint: httpCredential.endpoint, generation: runtime.generation, authorizationScope: runtime.currentAuthorizationScope }
    if (!runtime.sdk.mcpServerStatus) throw new HarnessExecutionError('CLAUDE_MCP_CONTROL_UNAVAILABLE', 'The actual SDK MCP control status is unavailable')
    const rows = await runtime.sdk.mcpServerStatus!()
    signal?.throwIfAborted()
    runtime.credentialServers = { ...servers, ...(servers[managedName] ? { [managedName]: structuredClone(servers[managedName]) } : {}) }
    return decodeClaudeMcpControl(rows, runtime.generation, ctx.now(), inspectionCredentials(ctx, runtime))
  }, signal).catch((error: unknown) => { delete runtime.httpCredentialAcknowledgement; throw error })
}
