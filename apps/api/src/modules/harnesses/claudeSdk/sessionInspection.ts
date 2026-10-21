/** Provider capabilities and pre-input MCP inspection. */
import { sessionStartOwner } from '../sessionStart.js'
import { APP_MCP_TOKEN_NAMES } from '@foreman-code/contracts/product'
import type { McpDetection, NativeHarnessCapabilities, NativeSessionReference } from '@foreman-code/contracts'
import type { NativeSessionStart } from '../port.js'
import { HarnessExecutionError } from '../errors.js'
import { claudeMcpDetection, decodeClaudeMcpControl, type ClaudeMcpInspection } from './mcpInspection.js'
import type { ClaudeManagerContext, Runtime } from './sessionTypes.js'
import { sameJson, filterMcpServers, canonicalStart, runtimeFor } from './sessionState.js'
import { ownedControl, inspectionCredentials, deliverCredentials } from './sessionCredentials.js'
import { prepareRuntime } from './sessionOpening.js'

export async function capabilities(ctx: ClaudeManagerContext): Promise<NativeHarnessCapabilities> {
  const q = ctx.options.qualification
  return { provider: ctx.harness, providerVersion: [...ctx.resident.values()].find(runtime => runtime.nativeProviderVersion)?.nativeProviderVersion
      ?? q.cliVersion, persistentSessions: q.basicTurns, reconnect: q.resume,
    sameRequestResponses: Boolean(q.interactions && ctx.options.interactionPort), cancellation: q.basicTurns, history: q.history, configurationInspection: true,
    mcpDetection: true, supportedInteractionKinds: q.interactions && ctx.options.interactionPort ? [...(ctx.options.supportedInteractionKinds ?? ['permission'])] : [] }
}

export async function refreshInspectionCredentials(ctx: ClaudeManagerContext, start: NativeSessionStart, servers: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<ClaudeMcpInspection> {
  signal?.throwIfAborted()
  if (ctx.options.appMcpAccess !== 'management') throw new HarnessExecutionError('CLAUDE_MANAGEMENT_MCP_FORBIDDEN', 'This owner has no management MCP credential authority.')
  if (!ctx.prepared) throw new HarnessExecutionError('CLAUDE_INSPECTION_CONTEXT_REQUIRED', 'Credential delivery requires the existing inspected SDK query.')
  const inspected = ctx.prepared
  const runtime = await inspected.opening
  if (runtime.active || runtime.session || runtime.closed || ctx.disposed) throw new HarnessExecutionError('CLAUDE_INSPECTION_ALREADY_STARTED', 'Pre-input credential delivery cannot mutate an active/native session.')
  if (runtime.controlPending) throw new HarnessExecutionError('CLAUDE_INSPECTION_BUSY', 'Credential refresh cannot overlap another owned SDK control operation.')
  const original = JSON.parse(inspected.identity) as NativeSessionStart
  const snapshot = await refreshCredentials(ctx, runtime, original, start, servers, signal)
  inspected.identity = JSON.stringify(canonicalStart(start))
  return snapshot
}

export async function refreshSessionCredentials(ctx: ClaudeManagerContext, session: NativeSessionReference,
  start: NativeSessionStart, servers: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<ClaudeMcpInspection> {
  signal?.throwIfAborted()
  const runtime = runtimeFor(ctx, session)
  if (runtime.active || runtime.controlPending || runtime.turns.size || !runtime.retiredTurns) {
    throw new HarnessExecutionError('CLAUDE_SESSION_BUSY', 'Credential rebinding requires an idle session with its previous turn retired.')
  }
  if (ctx.options.appMcpAccess !== 'management') {
    throw new HarnessExecutionError('CLAUDE_MANAGEMENT_MCP_FORBIDDEN', 'This owner has no management MCP credential authority.')
  }
  if (!runtime.start.correlationId || !start.correlationId) {
    throw new HarnessExecutionError('CLAUDE_INSPECTION_CONTEXT_CONFLICT', 'The original session correlation is unavailable.')
  }
  const original = { ...runtime.start, correlationId: start.correlationId }
  const snapshot = await refreshCredentials(ctx, runtime, original, start, servers, signal)
  if (ctx.prepared && await ctx.prepared.opening === runtime) {
    ctx.prepared.identity = JSON.stringify(canonicalStart(start))
  }
  return snapshot
}

async function refreshCredentials(ctx: ClaudeManagerContext, runtime: Runtime, original: NativeSessionStart,
  start: NativeSessionStart, servers: Readonly<Record<string, unknown>>, signal?: AbortSignal) {
  delete runtime.httpCredentialAcknowledgement
  delete runtime.credentialServers
  const withoutCredentials = (value: NativeSessionStart): string => {
    const variables = { ...value.environment?.variables }
    for (const key of [...APP_MCP_TOKEN_NAMES, ...(ctx.options.credentialEnvironmentVariables ?? [])]) delete variables[key]
    const agentId = value.environment?.agentId ?? sessionStartOwner(value)
    return JSON.stringify({ ...value, environment: { agentId, variables } })
  }
  if (!sameJson(withoutCredentials(original), withoutCredentials(start))) throw new HarnessExecutionError('CLAUDE_INSPECTION_CONTEXT_CONFLICT', 'Credential delivery changed the accepted owner/configuration or noncredential environment.')
  const configured = filterMcpServers(start, ctx.configuredServers)
  servers = filterMcpServers(start, servers)
  const topology = (entries: Readonly<Record<string, unknown>>) => JSON.stringify(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => {
    const config = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    if (config.type === 'sdk') return [name, { type: 'sdk', name: config.name }]
    const { headers: rawHeaders, env: rawEnv, ...scope } = config
    const headers = rawHeaders && typeof rawHeaders === 'object' ? Object.fromEntries(Object.entries(rawHeaders).filter(([key]) => key.toLowerCase() !== 'authorization')) : {}
    const env = rawEnv && typeof rawEnv === 'object' ? { ...rawEnv as Record<string, unknown> } : {}
    for (const key of [...APP_MCP_TOKEN_NAMES, ...(ctx.options.credentialEnvironmentVariables ?? [])]) delete env[key]
    return [name, { ...scope, headers, env }]
  }))
  if (topology(configured) !== topology(servers)) throw new HarnessExecutionError('CLAUDE_MCP_SCOPE_CONFLICT', 'Credential delivery changed accepted SDK server names, endpoints, commands or arguments.')
  const managedName = ctx.expectedMcp.serverName
  for (const [name, config] of Object.entries(configured)) {
    if (name === managedName) continue
    const sdkServer = config && typeof config === 'object' && Reflect.get(config, 'type') === 'sdk'
    const same = sdkServer ? config === servers[name] : JSON.stringify(config) === JSON.stringify(servers[name])
    if (!same) throw new HarnessExecutionError('CLAUDE_MCP_SCOPE_CONFLICT', 'Credential delivery cannot refresh unrelated native MCP servers.')
  }
  const snapshot = await deliverCredentials(ctx, runtime, start, servers, signal)
  runtime.start = structuredClone(start)
  return snapshot
}

export async function prepareInspection(ctx: ClaudeManagerContext, start: NativeSessionStart, signal?: AbortSignal): Promise<ClaudeMcpInspection> {
  const runtime = await prepareRuntime(ctx, start, signal)
  signal?.throwIfAborted()
  if (!runtime.sdk.mcpServerStatus) throw new HarnessExecutionError('CLAUDE_MCP_CONTROL_UNAVAILABLE', 'The actual SDK MCP control status is unavailable.')
  const rows = await ownedControl(ctx, runtime, () => runtime.sdk.mcpServerStatus!(), signal)
  signal?.throwIfAborted()
  if (runtime.closed || ctx.disposed) throw new HarnessExecutionError('CLAUDE_INSPECTION_CLOSED', 'The owned SDK query closed during inspection.')
  return decodeClaudeMcpControl(rows, runtime.generation, ctx.now(), inspectionCredentials(ctx, runtime))
}

export async function inspectMcp(ctx: ClaudeManagerContext, signal?: AbortSignal): Promise<McpDetection> {
  if (!ctx.prepared && !ctx.options.inspectionStart) throw new HarnessExecutionError('CLAUDE_INSPECTION_CONTEXT_REQUIRED', 'An admitted SDK inspection context must be supplied.')
  const start = !ctx.prepared && ctx.options.inspectionStart ? await ctx.options.inspectionStart() : undefined
  const runtime = start ? await prepareRuntime(ctx, start, signal) : await ctx.prepared!.opening
  if (!runtime.sdk.mcpServerStatus) throw new HarnessExecutionError('CLAUDE_MCP_CONTROL_UNAVAILABLE', 'The actual SDK MCP control status is unavailable.')
  const rows = await ownedControl(ctx, runtime, () => runtime.sdk.mcpServerStatus!(), signal)
  signal?.throwIfAborted()
  if (runtime.closed || ctx.disposed) throw new HarnessExecutionError('CLAUDE_INSPECTION_CLOSED', 'The owned SDK query closed during inspection.')
  return claudeMcpDetection(decodeClaudeMcpControl(rows, runtime.generation, ctx.now(), inspectionCredentials(ctx, runtime)), ctx.expectedMcp)
}
