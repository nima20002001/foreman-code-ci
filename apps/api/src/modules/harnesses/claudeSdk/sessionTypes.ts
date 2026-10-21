/** Public Claude session manager contracts and the internal state shapes its modules share. */
import type { CompactionState, ContextSnapshot, SessionPreferences, AgentHarness, ExecutionResult, NativeHarnessEvent,
  NativeSessionReference } from '@foreman-code/contracts'
import { createHash } from 'node:crypto'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeTurnInput } from '../port.js'
import type { NativeMcpHttpCredentialAcknowledgement } from '../mcpDetection.js'
import type { ResponseAvailabilityInspector } from '../responseAvailability.js'
import type { ClaudeMcpInspection } from './mcpInspection.js'
import type { ClaudeLiveCallbackReader, ClaudeNativeCallbackContext, ClaudeCallbackAuthority,
  ClaudePendingNotification } from './callbackAvailability.js'
import { ClaudeBoundedQueue } from './queue.js'
import type { ClaudeSdkRunner, ClaudeSdkSession, ClaudeSessionScope } from './port.js'

/** Message receipts are distinct from native turns. The shared port consumes this additive seam. */
export interface ClaudeMessageSubmission {
  kind: 'message'
  nativeSessionId: string
  nativeMessageId: string
  clientCorrelationId: string
}
export interface ClaudeMessageTurnInput extends NativeTurnInput {
  callbackAuthority?: ClaudeCallbackAuthority
  onMessageSubmitted?(identity: ClaudeMessageSubmission): Promise<void>
}
export interface ClaudeSessionQualification {
  sdkVersion: string
  cliVersion: string
  basicTurns: boolean
  resume: boolean
  fork: boolean
  history: boolean
  interactions?: boolean
}
/** Stable client identity permits read-only recovery; it is not a native receipt before observation. */
export function claudePromptUuid(correlationId: string): string {
  const bytes = createHash('sha256').update(JSON.stringify(['graphql-claude-message-v2', correlationId])).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export interface ClaudeInitialTurnInput extends ClaudeMessageTurnInput {
  onSessionObserved(session: NativeSessionReference): Promise<void>
}

export interface ClaudeNativeSessionManager extends NativeHarnessSessionManager, ResponseAvailabilityInspector {
  hasResidentSession(session: NativeSessionReference): boolean
  observeSubagentHook?(sessionId: string, agentId: string, agentType: string, status: 'running' | 'unknown'): void
  /** Read-only SDK callback context from a proven root tool/message owner. */
  refreshInspectionCredentials(start: NativeSessionStart, servers: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<ClaudeMcpInspection>
  refreshSessionCredentials(session: NativeSessionReference, start: NativeSessionStart,
    servers: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<ClaudeMcpInspection>
  prepareInspection(start: NativeSessionStart, signal?: AbortSignal): Promise<ClaudeMcpInspection>
  startInitialTurn(start: NativeSessionStart, input: ClaudeInitialTurnInput, signal?: AbortSignal): AsyncIterable<NativeHarnessEvent>
  nativeCallbackContext(nativeSessionId: string, toolUseId: string): ClaudeNativeCallbackContext | undefined
  callbackAuthority(context: ClaudeNativeCallbackContext): ClaudeCallbackAuthority | undefined
  notifyPendingChanged(notification: ClaudePendingNotification): void
  waitNativeCallbackContext(toolUseId: string, signal: AbortSignal, nativeSessionId?: string): Promise<ClaudeNativeCallbackContext>
}

export interface Turn {
  correlationId: string
  promptUuid: string
  input: ClaudeMessageTurnInput
  submitted: boolean
  observing: boolean
  observerLease?: symbol
  replyObserved: boolean
  resultBeforeReply: boolean
  events: ClaudeBoundedQueue<NativeHarnessEvent>
  terminal?: ExecutionResult
  nativeMessageId?: string
  assistantMessageId?: string
  authority?: ClaudeCallbackAuthority
  cancelRequested?: boolean
}
export interface Runtime {
  startingTurn?: Turn | undefined
  start: NativeSessionStart
  models?: Array<{ value: string; resolvedModel?: string | undefined; displayName?: string | undefined }>
  defaultModelCapacity?: number
  modelCapacity?: number
  selectedModel?: string
  appliedPreferences?: SessionPreferences
  commands?: string[]
  context?: ContextSnapshot
  compaction?: { state: CompactionState; promptUuid: string; boundary: boolean;
    progress: import('../port.js').NativeCompactInput['onProgress']; finish(): void; fail(error: unknown): void } | undefined

  sdk: ClaudeSdkSession
  generation: string
  currentAuthorizationScope: string
  httpCredentialAcknowledgement?: NativeMcpHttpCredentialAcknowledgement
  credentialServers?: Readonly<Record<string, unknown>>
  replacingForResume?: boolean
  closed: boolean
  session?: NativeSessionReference
  nativeProviderVersion?: string
  events: NativeHarnessEvent[]
  nextSequence: number
  turns: Map<string, Turn>
  messageOwners: Map<string, Turn>
  toolOwners: Map<string, Turn>
  restoredReceipts: Map<string, ClaudeMessageSubmission>
  historyScanOffsets: Map<string, number>
  retiredTurns: boolean
  active?: Turn
  controlPending?: boolean
  pumping?: Promise<void>
  decode?: (raw: unknown) => readonly Pick<NativeHarnessEvent, 'type' | 'payload'>[]
  failure?: unknown
  onSessionObserved?: (session: NativeSessionReference) => Promise<void>
  initialized: Promise<NativeSessionReference>
  resolveInit(session: NativeSessionReference): void
  rejectInit(error: unknown): void
}

export interface ClaudeNativeSessionManagerOptions {
  runner: ClaudeSdkRunner
  scope: ClaudeSessionScope
  sdkOptions: Readonly<Record<string, unknown>>
  qualification: ClaudeSessionQualification
  now?: () => string
  decodeFactory?: (start: NativeSessionStart) => (raw: unknown) => readonly Pick<NativeHarnessEvent, 'type' | 'payload'>[]
  interactionPort?: Pick<NativeHarnessSessionManager, 'pending' | 'respond' | 'reconcileResponse' | 'stopAutomaticResponses'>
  cancelPendingRequests?(): void
  initializationTimeoutMs?: number
  liveCallbacks?: ClaudeLiveCallbackReader
  inspectionStart?: () => NativeSessionStart | Promise<NativeSessionStart>
  expectedMcp?: { serverName: string; url?: string }
  appMcpAccess?: 'management' | 'none'
  credentialEnvironmentVariables?: readonly string[]
  supportedInteractionKinds?: readonly string[]
  pendingInteractions?: (session: NativeSessionReference) => readonly import('@foreman-code/contracts').PendingNativeInteraction[]
  responseDeliveries?: (session: NativeSessionReference) => NonNullable<NativeHistory['responseDeliveries']>
    | Promise<NonNullable<NativeHistory['responseDeliveries']>>
  messageSubmitted?: (correlationId: string) => Promise<boolean>
}

export interface CallbackWaiter {
  toolUseId: string
  nativeSessionId?: string
  signal: AbortSignal
  abort(): void
  resolve(context: ClaudeNativeCallbackContext): void
  reject(error: unknown): void
}

/** Explicit state shared by one Claude session manager's functions, replacing closure variables. */
export interface ClaudeManagerContext {
  readonly options: ClaudeNativeSessionManagerOptions
  readonly configuredServers: Record<string, unknown>
  readonly expectedMcp: { serverName: string; url?: string }
  readonly harness: AgentHarness
  readonly resident: Map<string, Runtime>
  readonly retired: Map<string, Runtime>
  readonly all: Set<Runtime>
  readonly callbackWaiters: Set<CallbackWaiter>
  readonly forks: Map<string, { identity: string; promise: Promise<NativeSessionReference> }>
  readonly initialTurns: Map<string, { identity: string; turn: Turn; opening: Promise<NativeSessionReference> }>
  prepared: { identity: string; opening: Promise<Runtime> } | undefined
  readonly rolloverSources: Map<string, Runtime>
  readonly rollovers: Map<string, Promise<NativeSessionReference>>
  sessionPreferences: SessionPreferences | undefined
  disposed: boolean
  readonly now: () => string
}
