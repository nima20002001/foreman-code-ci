/** Explicit shared state of a Claude session manager and its small runtime helpers. */
import { sessionStartConfiguration, sessionStartSystemPrompt } from '../sessionStart.js'
import { SessionPreferencesSchema, nativeMcpServerAllowed, type AgentHarness, type NativeHarnessEvent,
  type NativeSessionReference } from '@foreman-code/contracts'
import { claudeSessionEnvironment } from './sessionControls.js'
import { APP_MCP_TOKEN_NAMES } from '@foreman-code/contracts/product'
import { readProductEnvironment } from '@foreman-code/contracts/product-environment'
import { appMcpServerName } from '../appMcpLauncher.js'
import { appMcpTokenEnvironment, isDatabaseCredentialVariable } from '../secrets.js'
import { agentInstructionBundle } from '../../skills/instructions.js'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { NativeSessionStart } from '../port.js'
import { HarnessExecutionError } from '../errors.js'
import { ClaudeBoundedQueue } from './queue.js'
import { claudePromptUuid, type ClaudeMessageTurnInput, type ClaudeNativeSessionManagerOptions,
  type ClaudeManagerContext, type Turn, type Runtime } from './sessionTypes.js'

/** A caller's signal bounds native startup only; it never owns the resident query afterwards. */
export function startupSignal(signal?: AbortSignal): { signal?: AbortSignal; release(): void } {
  if (!signal) return { release() {} }
  const controller = new AbortController()
  const forward = () => controller.abort(signal.reason)
  if (signal.aborted) forward(); else signal.addEventListener('abort', forward, { once: true })
  return { signal: controller.signal, release: () => signal.removeEventListener('abort', forward) }
}

export function sameJson(left: string, right: string): boolean {
  return isDeepStrictEqual(JSON.parse(left), JSON.parse(right))
}

export function createClaudeManagerContext(options: ClaudeNativeSessionManagerOptions): ClaudeManagerContext {
  const configuredServers = options.sdkOptions.mcpServers && typeof options.sdkOptions.mcpServers === 'object'
    ? options.sdkOptions.mcpServers as Record<string, unknown> : {}
  return {
    options,
    configuredServers,
    expectedMcp: options.expectedMcp ?? { serverName: appMcpServerName(configuredServers) },
    // The provider enum addition is integrated by the designated shared-contract writer.
    harness: 'claude' as AgentHarness,
    resident: new Map(),
    retired: new Map(),
    all: new Set(),
    callbackWaiters: new Set(),
    forks: new Map(),
    initialTurns: new Map(),
    prepared: undefined,
    rolloverSources: new Map(),
    rollovers: new Map(),
    sessionPreferences: undefined,
    disposed: false,
    now: options.now ?? (() => new Date().toISOString()),
  }
}

export function filterMcpServers(start: NativeSessionStart, servers: Readonly<Record<string, unknown>>) {
  const policy = sessionStartConfiguration(start).nativeTools
  return Object.fromEntries(Object.entries(servers).filter(([name]) =>
    name === 'graphql-files' || nativeMcpServerAllowed(name, policy)))
}

export function queryOptions(ctx: ClaudeManagerContext, start: NativeSessionStart, preferences = SessionPreferencesSchema.parse({})): Record<string, unknown> & { env: NodeJS.ProcessEnv } {
  const configuration = sessionStartConfiguration(start)
  const nativeTools = configuration.nativeTools
  const sdkOptions = { ...ctx.options.sdkOptions }
  if (nativeTools?.mcpServers !== undefined || nativeTools?.apps === false) {
    sdkOptions.mcpServers = filterMcpServers(start, ctx.configuredServers)
  }
  if (nativeTools?.apps === false) sdkOptions.plugins = []
  const environment = { ...(ctx.options.sdkOptions.env as Record<string, string> | undefined),
    ...start.environment?.variables }
  if (Object.keys(environment).some(isDatabaseCredentialVariable)) {
    throw new HarnessExecutionError('CLAUDE_ENVIRONMENT_INVALID',
      'The Claude environment cannot contain database credentials.')
  }
  const scoped = claudeSessionEnvironment(appMcpTokenEnvironment(environment, process.env), preferences)
  const instructions = agentInstructionBundle(configuration)
  const systemPrompt = sessionStartSystemPrompt(start)?.value.text
  if (!instructions && !systemPrompt) return { ...sdkOptions, env: scoped }
  const base = sdkOptions.systemPrompt
  if (base !== undefined && typeof base !== 'string') {
    throw new HarnessExecutionError('CLAUDE_SYSTEM_PROMPT_UNSUPPORTED',
      'Persistent Agent instructions require a string SDK system prompt.')
  }
  return { ...sdkOptions, env: scoped,
    systemPrompt: [base, systemPrompt, instructions?.text].filter(Boolean).join('\n\n') }
}

export function qualified(ctx: ClaudeManagerContext, capability: 'basicTurns' | 'resume' | 'fork' | 'history') {
  if (!ctx.options.qualification[capability]) throw new HarnessExecutionError('CLAUDE_CAPABILITY_UNQUALIFIED', `Claude ${capability} has not been qualified on the selected installation.`)
}

export function runtimeFor(ctx: ClaudeManagerContext, session: NativeSessionReference, access: { readOnly?: boolean } = {}): Runtime {
  const runtime = ctx.resident.get(session.nativeSessionId)
    ?? (access.readOnly ? ctx.rolloverSources.get(session.nativeSessionId) ?? ctx.retired.get(session.nativeSessionId) : undefined)
  if (!runtime || session.harness !== ctx.harness || session.providerVersion !== runtime.session?.providerVersion) throw new HarnessExecutionError('CLAUDE_SESSION_UNAVAILABLE', 'The exact owned Claude session is not resident.')
  return runtime
}

export async function record(ctx: ClaudeManagerContext, runtime: Runtime, type: string, payload: Record<string, unknown>, turn?: Turn): Promise<NativeHarnessEvent> {
  // The owned query generation scopes the adapter cursor without claiming an SDK-native sequence.
  const event: NativeHarnessEvent = {
    connectionId: runtime.generation,
    sequence: runtime.nextSequence++,
    occurredAt: ctx.now(),
    type,
    payload: turn ? { ...payload, clientCorrelationId: turn.correlationId } : payload,
  }
  runtime.events.push(event)
  if (runtime.events.length > 256) runtime.events.shift()
  if (turn?.observing) await turn.events.offer(event)
  return event
}

export function rememberOwner(map: Map<string, Turn>, id: string, turn: Turn): void {
  const previous = map.get(id)
  if (previous && previous !== turn) throw new HarnessExecutionError('CLAUDE_MESSAGE_IDENTITY_CONFLICT', 'Native provenance identity was reused across application messages.')
  if (!previous && map.size >= 2048) map.delete(map.keys().next().value!)
  map.set(id, turn)
}

export function canonicalStart(start: NativeSessionStart): NativeSessionStart {
  if (!start.environment) return start
  const variables = { ...start.environment.variables }
  const token = readProductEnvironment(variables, 'MCP_TOKEN')
  for (const name of APP_MCP_TOKEN_NAMES) delete variables[name]
  if (token !== undefined) variables.FOREMAN_CODE_MCP_TOKEN = token
  return { ...start, environment: { ...start.environment, variables } }
}

export function authorizationScope(ctx: ClaudeManagerContext, start: NativeSessionStart): string {
  const identity = ['claude-mcp-authorization-v1', ctx.options.scope, canonicalStart(start)]
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

export function sessionContext(start: NativeSessionStart) {
  start = canonicalStart(start)
  if (start.kind === 'agent-chat') return { kind: start.kind, configuration: start.configuration,
    conversationId: start.conversationId, workflowId: start.workflowId, workflowNodeId: start.workflowNodeId,
    cwd: start.workingDirectory, environment: start.environment, systemPrompt: start.systemPrompt }
  return start.kind === 'operator'
    ? { kind: start.kind, configuration: start.configuration,
      cwd: start.workingDirectory, environment: start.environment }
    : { kind: start.kind ?? 'workflow', request: start.request, environment: start.environment,
      ...(start.kind === 'workflow-consultation' ? { consultation: start.consultation } : {}) }
}

export function makeRuntime(ctx: ClaudeManagerContext, start: NativeSessionStart): Runtime {
  let resolveInit!: Runtime['resolveInit']
  let rejectInit!: Runtime['rejectInit']
  const initialized = new Promise<NativeSessionReference>((resolve, reject) => { resolveInit = resolve; rejectInit = reject })
  // The rejection is observed even if native startup fails before await initialized.
  void initialized.catch(() => {
    // ignore: startup awaits the original promise; observe early rejection here.
  })
  const runtime = {
    start: structuredClone(start),
    generation: randomUUID(),
    currentAuthorizationScope: authorizationScope(ctx, start),
    closed: false,
    events: [],
    nextSequence: 0,
    turns: new Map(),
    messageOwners: new Map(),
    toolOwners: new Map(),
    restoredReceipts: new Map(),
    historyScanOffsets: new Map(),
    retiredTurns: false,
    initialized,
    resolveInit,
    rejectInit,
  } as unknown as Runtime
  if (ctx.options.decodeFactory) runtime.decode = ctx.options.decodeFactory(start)
  ctx.all.add(runtime)
  return runtime
}

export function coalesceText(prior: NativeHarnessEvent, next: NativeHarnessEvent): NativeHarnessEvent | undefined {
  if (prior.type !== 'claude.text' || next.type !== 'claude.text'
    || prior.payload.itemId !== next.payload.itemId
    || prior.payload.clientCorrelationId !== next.payload.clientCorrelationId) return undefined
  if (next.payload.operation === 'replace') return next
  if (next.payload.operation !== 'append'
    || !['append', 'replace'].includes(String(prior.payload.operation))) return undefined
  if (typeof prior.payload.text !== 'string' || typeof next.payload.text !== 'string') return undefined
  return { ...next, payload: { ...next.payload, operation: prior.payload.operation,
    text: prior.payload.text + next.payload.text } }
}

export function createTurn(input: ClaudeMessageTurnInput): Turn {
  return { correlationId: input.clientCorrelationId, promptUuid: claudePromptUuid(input.clientCorrelationId), input,
    submitted: false, observing: true, replyObserved: false, resultBeforeReply: false, events: new ClaudeBoundedQueue(256, coalesceText),
    ...(input.callbackAuthority ? { authority: { ...input.callbackAuthority } } : {}) }
}

export function subscribe(turn: Turn, signal?: AbortSignal): AsyncIterable<NativeHarnessEvent> {
  return {
      [Symbol.asyncIterator]() {
        if (turn.observerLease) {
          throw new HarnessExecutionError('CLAUDE_OBSERVER_CONFLICT', 'This Claude message already has an observer.')
        }
        const lease = Symbol('Claude message observer')
        turn.observerLease = lease
        turn.observing = !turn.terminal
        const iterator = turn.events[Symbol.asyncIterator]()
        const detach = () => {
          if (turn.observerLease !== lease) return
          delete turn.observerLease
          turn.observing = false
          turn.events.discard()
          void iterator.return?.()
        }
        const aborted = () => detach()
        signal?.addEventListener('abort', aborted, { once: true })
        const cleanup = () => { signal?.removeEventListener('abort', aborted); detach() }
        return {
          async next() {
            try {
              signal?.throwIfAborted()
              const value = await iterator.next()
              signal?.throwIfAborted()
              if (value.done) cleanup()
              return value
            } catch (error) {
              cleanup()
              throw error
            }
          },
          async return() { cleanup(); return { done: true as const, value: undefined } },
          async throw(error: unknown) { cleanup(); throw error },
        }
      },
    }
}
