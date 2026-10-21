/** Pure helpers and limits shared by the Codex app-server session manager layers. */
import { hasWorkflowRequest, sessionStartConfiguration, sessionStartOwner, sessionStartSystemPrompt } from '../sessionStart.js'
import { readProductEnvironment } from '@foreman-code/contracts/product-environment'
import { isSupportedAppMcpTokenName } from '../appMcpLauncher.js'
import { createHash } from 'node:crypto'
import { CodexHarnessConfigurationSchema, DEFAULT_CODEX_ADVANCED_CONFIGURATION, type CodexAdvancedConfiguration,
  type CodexHarnessConfiguration } from '@foreman-code/contracts'
import { HarnessExecutionError } from '../errors.js'
import type { NativeSessionStart } from '../port.js'
import { appMcpTokenEnvironment, inheritedAgentEnvironment, isControllerEnvironmentVariable } from '../secrets.js'
import { agentInstructionBundle } from '../../skills/instructions.js'
import { canonicalJsonNumericKeysFirstLegacy } from '@foreman-code/contracts/canonical-json'
import { CodexRpcError, isObject, object, type JsonObject, type RequestId } from '../codexStdioTransport.js'
import type { CodexTransport, CodexSessionOperations, TurnSnapshot, Runtime, Prepared } from './types.js'

export const MAX_EVENTS = 1_024
export const MAX_EVENT_BYTES = 8 * 1024 * 1024
// The active turn stream persists every frame durably. Frames it has not read
// yet exist nowhere else, so retention never evicts them below this hard cap.
export const MAX_UNREAD_EVENT_BYTES = 128 * 1024 * 1024
export const MAX_HISTORY_BYTES = 128 * 1024
export const MAX_STAGED = 256
export const MAX_INTERACTIONS = 128
export const RESPONSE_DEADLINE_MS = 30_000
export const INTERRUPT_STARTUP_RETRIES = 20
export const INTERRUPT_STARTUP_RETRY_MS = 25

export function advanced(value: CodexHarnessConfiguration): CodexAdvancedConfiguration {
  return value.advanced ?? DEFAULT_CODEX_ADVANCED_CONFIGURATION
}
export function accepted(input: NativeSessionStart) { return sessionStartConfiguration(input) }
export function ownerId(input: NativeSessionStart): string {
  return sessionStartOwner(input)
}
export function binding(input: NativeSessionStart): string {
  if (input.kind === 'operator') return canonicalJsonNumericKeysFirstLegacy({ kind: 'operator', ownerId: ownerId(input), cwd: input.workingDirectory })
  if (input.kind === 'agent-chat') return canonicalJsonNumericKeysFirstLegacy({ kind: input.kind, conversationId: input.conversationId,
    ownerId: ownerId(input), workspaceId: input.configuration.workspaceId,
    workflowId: input.workflowId, workflowNodeId: input.workflowNodeId, cwd: input.workingDirectory })
  return canonicalJsonNumericKeysFirstLegacy({ kind: 'workflow', ownerId: ownerId(input), workspaceId: input.request.workspaceId,
      runId: input.request.runId, workflowNodeId: input.request.workflowNodeId, cwd: input.request.workingDirectory })
}
/** App-owned developer instructions: the accepted configuration's pinned bundle, never the live catalog.
 * Native base instructions stay Codex's own. Earlier accepted configurations keep their system prompt only. */
export function instructions(input: NativeSessionStart): string | null {
  if (input.kind === 'operator') return agentInstructionBundle(input.configuration)?.text ?? null
  const configuration = input.kind === 'agent-chat' ? input.configuration : input.request.configuration
  const agentInstructions = configuration.instructionDelivery === 'native-v1'
    ? agentInstructionBundle(configuration)?.text : configuration.prompt.system
  return [sessionStartSystemPrompt(input)?.value.text, agentInstructions].filter(Boolean).join('\n\n') || null
}
export function credentialIdentity(input: NativeSessionStart): string {
  return canonicalJsonNumericKeysFirstLegacy(input.environment ?? null)
}
export function validateEnvironmentVariables(input?: NativeSessionStart['environment']): void {
  for (const key of Object.keys(input?.variables ?? {})) {
    // Operator and Worker credentials use the admitted App token; the server resolves its role.
    if (!isSupportedAppMcpTokenName(key) && isControllerEnvironmentVariable(key)) {
      throw new HarnessExecutionError('CODEX_ENVIRONMENT_INVALID', 'An Agent environment cannot contain application-global secrets.')
    }
  }
}
export function safeEnvironment(input?: NativeSessionStart['environment'], scopedNames: readonly string[] = []): NodeJS.ProcessEnv {
  validateEnvironmentVariables(input)
  const environment = inheritedAgentEnvironment()
  for (const key of scopedNames) delete environment[key]
  if (input) {
    for (const [key, value] of Object.entries(input.variables)) {
      environment[key] = value
    }
  }
  return appMcpTokenEnvironment(environment, process.env)
}
export function validateEnvironmentOwner(input: NativeSessionStart, requiredVariable?: string): void {
  if (input.environment && input.environment.agentId !== ownerId(input)) {
    throw new HarnessExecutionError('CODEX_SESSION_OWNER_MISMATCH', 'The scoped process environment belongs to another Agent.')
  }
  if (hasWorkflowRequest(input) && input.request.workspaceId !== input.request.configuration.workspaceId) {
    throw new HarnessExecutionError('CODEX_SESSION_OWNER_MISMATCH', 'The accepted configuration belongs to another workspace.')
  }
  const token = requiredVariable && isSupportedAppMcpTokenName(requiredVariable)
    ? readProductEnvironment(input.environment?.variables ?? {}, 'MCP_TOKEN') : input.environment?.variables[requiredVariable ?? '']
  if (requiredVariable && !token) {
    throw new HarnessExecutionError('CODEX_SCOPED_ENVIRONMENT_REQUIRED', `The enabled App MCP server requires scoped '${requiredVariable}' credentials.`)
  }
}
export function configuration(input: NativeSessionStart): CodexHarnessConfiguration {
  const value = accepted(input).harness
  if (value.harness !== 'codex') throw new HarnessExecutionError('HARNESS_CONFIGURATION_MISMATCH', 'Codex received a non-Codex configuration.')
  const parsed = CodexHarnessConfigurationSchema.safeParse(value)
  if (!parsed.success) throw new HarnessExecutionError('CODEX_SETTING_INVALID', 'The accepted Codex configuration is invalid.')
  return parsed.data
}
export function configOverrides(value: CodexHarnessConfiguration): JsonObject {
  const draft = advanced(value)
  const config: JsonObject = {
    model_reasoning_effort: value.reasoningEffort,
    web_search: draft.webSearch,
    shell_environment_policy: {
      inherit: draft.shellEnvironment.inherit,
      ignore_default_excludes: draft.shellEnvironment.ignoreDefaultExcludes,
      filters: draft.shellEnvironment.filters, set: draft.shellEnvironment.set,
    },
  }
  if (value.sandbox === 'workspace-write') config.sandbox_workspace_write = {
    writable_roots: draft.additionalWritableDirectories,
    network_access: draft.workspaceWrite?.networkAccess ?? false,
    exclude_tmpdir_env_var: draft.workspaceWrite?.excludeTmpdirEnvVar ?? false,
    exclude_slash_tmp: draft.workspaceWrite?.excludeSlashTmp ?? false,
  }
  return config
}
export function threadParameters(
  prepared: Pick<Prepared, 'harnessConfiguration' | 'workingDirectory' | 'input' | 'disabledMcpServerNames'
    | 'mcpTransportOverrides' | 'nativeApps' | 'approvedAppMcpServerName'>,
  resume = false,
): JsonObject {
  const value = prepared.harnessConfiguration
  const draft = advanced(value)
  return {
    model: value.model,
    // Explicit default, rather than null/inherit, clears a prior native Fast tier.
    serviceTier: value.serviceTier === 'priority' ? 'fast' : 'default',
    cwd: prepared.workingDirectory,
    runtimeWorkspaceRoots: [prepared.workingDirectory, ...draft.additionalWritableDirectories],
    approvalPolicy: draft.approvalPolicy, approvalsReviewer: draft.approvalsReviewer,
    sandbox: value.sandbox, config: { ...configOverrides(value),
      ...(prepared.input.sessionPreferences?.contextBudget != null
        ? { model_context_window: prepared.input.sessionPreferences.contextBudget } : {}),
      ...(prepared.input.sessionPreferences?.autoCompactTokens != null
        ? { model_auto_compact_token_limit: prepared.input.sessionPreferences.autoCompactTokens } : {}),
      ...Object.fromEntries(prepared.disabledMcpServerNames.map((name) => [`mcp_servers.${name}.enabled`, false])),
      ...prepared.mcpTransportOverrides,
      ...(prepared.nativeApps !== undefined ? { 'features.apps': prepared.nativeApps } : {}),
      // Codex 0.16x prompts for every MCP tool call under on-request approval; an unattended workflow Agent would
      // wait on its own App tools (ci_run, context_get) forever. Each call is still authorized by the Agent's grants.
      ...(prepared.approvedAppMcpServerName
        ? { [`mcp_servers.${prepared.approvedAppMcpServerName}.default_tools_approval_mode`]: 'approve' } : {}),
      ...(prepared.input.kind === 'operator' ? { model_reasoning_summary: prepared.input.configuration.showThinking ? 'auto' : 'none' } : {}),
    },
    // A resumed or forked thread already carries its accepted developer instructions.
    ...(resume || (prepared.input.kind !== 'operator' && prepared.input.instructionsDelivered) ? {} : { developerInstructions: instructions(prepared.input) }),
  }
}
export function sameSet(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (!left || !right) return left === right
  return canonicalJsonNumericKeysFirstLegacy([...new Set(left)].sort()) === canonicalJsonNumericKeysFirstLegacy([...new Set(right)].sort())
}
export function stringArray(value: unknown): string[] | undefined {
  if (value == null) return undefined
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) throw new Error('Invalid native string list.')
  return value as string[]
}
export function requestKey(generation: number, id: RequestId): string { return `${generation}:${typeof id}:${String(id)}` }
export function itemNotificationKey(generation: number, method: string, turnId: unknown, itemId: unknown, itemType: unknown): string {
  return createHash('sha256').update(canonicalJsonNumericKeysFirstLegacy([generation, method, turnId, itemId, itemType])).digest('hex')
}
export function stagedNativeOutputTerminal(runtime: Runtime, turnId: string): boolean {
  return runtime.starting?.staged.some(event => 'method' in event && event.method === 'turn/completed'
    && event.params.threadId === runtime.session.nativeSessionId && isObject(event.params.turn)
    && event.params.turn.id === turnId && ['completed', 'failed', 'interrupted'].includes(String(event.params.turn.status))) ?? false
}

export function snapshot(runtime: Runtime): TurnSnapshot {
  return {
    activeTurnId: runtime.activeTurnId, activeCorrelationId: runtime.activeCorrelationId,
    terminalResult: runtime.terminalResult, finalAnswer: runtime.finalAnswer, lastAgentMessage: runtime.lastAgentMessage,
    finalAnswerId: runtime.finalAnswerId, lastAgentMessageId: runtime.lastAgentMessageId,
  }
}
export function isUncertain(error: unknown): boolean { return error instanceof CodexRpcError && error.uncertain }
export function deadline<T>(promise: Promise<T>, signal?: AbortSignal, milliseconds = RESPONSE_DEADLINE_MS, timers: Pick<CodexSessionOperations, 'schedule' | 'cancelTimer'> = { schedule: setTimeout, cancelTimer: clearTimeout }): Promise<T> {
  signal?.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (error: unknown, value?: T) => {
      if (settled) return
      settled = true
      timers.cancelTimer(timer)
      signal?.removeEventListener('abort', abort)
      if (error !== undefined) reject(error)
      else resolve(value as T)
    }
    const abort = () => finish(signal?.reason ?? new Error('Aborted'))
    const timer = timers.schedule(() => finish(new HarnessExecutionError('NATIVE_RECONCILIATION_REQUIRED', 'Native confirmation has not arrived; reconcile before retrying.')), milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
    void promise.then((value) => finish(undefined, value), (error: unknown) => finish(error))
  })
}

/** Codex refuses `thread/turns/list` until the first user message materializes the thread; undefined means no turns yet. */
export async function listCodexTurns(transport: CodexTransport, params: JsonObject, signal?: AbortSignal): Promise<JsonObject | undefined> {
  try {
    return object(await transport.request('thread/turns/list', params, signal), 'CODEX_THREAD_READ_INVALID')
  } catch (error) {
    if (error instanceof CodexRpcError && /is not materialized yet/.test(error.nativeMessage ?? '')) return undefined
    throw error
  }
}
