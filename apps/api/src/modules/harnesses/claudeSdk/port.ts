import { HarnessExecutionError } from '../errors.js'

/** Narrow injectable boundary for the pinned official streaming SDK. */
export interface ClaudeSdkUserMessage {
  type: 'user'
  message: { role: 'user'; content: string }
  parent_tool_use_id: null
  uuid: string
}

export interface ClaudeSdkQuery extends AsyncIterable<unknown> {
  setPermissionMode?(mode: 'default' | 'plan'): Promise<void>
  getContextUsage?(options: { detail: 'summary' }): Promise<unknown>
  interrupt(): Promise<unknown>
  /** First-connect answer only; does not resend initialize or offer input. */
  initializationResult?(): Promise<unknown>
  mcpServerStatus?(): Promise<readonly unknown[]>
  setMcpServers?(servers: Readonly<Record<string, unknown>>): Promise<unknown>
  close(): void
  /** Positive process containment closure supplied by the owned host adapter. */
  joinClosed?(): Promise<void>
}

export interface ClaudeSdkClient {
  readonly sdkVersion: string
  query(input: { prompt: AsyncIterable<ClaudeSdkUserMessage>; scope?: ClaudeSessionScope; options: Readonly<Record<string, unknown>> }): ClaudeSdkQuery | Promise<ClaudeSdkQuery>
  requiresRuntimeClosure?(): boolean
  getSessionInfo(sessionId: string, options: { dir: string }): Promise<{ sessionId: string } | undefined>
  getSessionMessages(sessionId: string, options: { dir: string; limit?: number; offset?: number }): Promise<readonly unknown[]>
  listSubagents?(sessionId: string, options: { dir: string }): Promise<string[]>
  getSubagentMessages?(sessionId: string, agentId: string, options: { dir: string; limit: number; offset: number }): Promise<readonly unknown[]>
  forkSession(sessionId: string, options: { dir: string }): Promise<{ sessionId: string }>
}

export interface ClaudeSessionScope {
  readonly deviceId: string
  readonly profilePath: string
  readonly configRevision: string
  readonly cwd: string
}

export interface ClaudePersistedSession extends ClaudeSessionScope {
  readonly nativeSessionId: string
}

export interface ClaudeNativeObservation {
  nativeSessionId: string
  /** Native output frame identity, never an application/native turn ID. */
  providerMessageId?: string
  /** Client UUIDs from the native input echo that owns this response sequence; not native IDs. */
  promptUuids: readonly string[]
  kind: 'reply' | 'result'
}

export interface ClaudeSdkOutput {
  raw: unknown
  observation?: ClaudeNativeObservation
}

export interface ClaudeSdkOpenInput {
  scope: ClaudeSessionScope
  options: Readonly<Record<string, unknown>>
  resume?: ClaudePersistedSession
  signal?: AbortSignal
  /** Persistence completes before the corresponding output is exposed. */
  onObservation?(observation: ClaudeNativeObservation): Promise<void>
  /** Stop process-local permission/question callbacks, including before init. */
  cancelPendingRequests?(): void
}

export class ClaudeInputNotDeliveredError extends HarnessExecutionError {
  readonly code = 'CLAUDE_INPUT_NOT_DELIVERED'
  readonly deliveryState = 'not-delivered'
  readonly certainty = 'definite'
  readonly uncertain = false

  constructor(message: string, options?: ErrorOptions) {
    super('CLAUDE_INPUT_NOT_DELIVERED', message, true, options)
    this.name = 'ClaudeInputNotDeliveredError'
  }
}

export interface ClaudeSdkSession {
  readonly output: AsyncIterable<ClaudeSdkOutput>
  readonly nativeSessionId: string | undefined
  assertInputCapacity(): void
  offer(input: { promptUuid: string; content: string }, signal?: AbortSignal): Promise<{ state: 'queue-offered'; promptUuid: string }>
  setPermissionMode?(mode: 'default' | 'plan'): Promise<void>
  getContextUsage?(options: { detail: 'summary' }): Promise<unknown>
  interrupt(): Promise<unknown>
  initializationResult?(): Promise<unknown>
  mcpServerStatus?(): Promise<readonly unknown[]>
  setMcpServers?(servers: Readonly<Record<string, unknown>>): Promise<unknown>
  reconcile(promptUuid: string): readonly ClaudeNativeObservation[]
  close(): Promise<void>
  /** Native query.close terminates work: there is no qualified detach parity. */
  closeForRestart(): Promise<never>
}

export interface ClaudeSdkRunner {
  requiresRuntimeClosure?(): boolean
  open(input: ClaudeSdkOpenInput): Promise<ClaudeSdkSession>
  fork(source: ClaudePersistedSession, target: ClaudeSessionScope, signal?: AbortSignal): Promise<ClaudePersistedSession>
  history(session: ClaudePersistedSession, scope: ClaudeSessionScope, signal?: AbortSignal, page?: { offset: number; limit: number }): Promise<readonly unknown[]>
  subagentHistory?(session: ClaudePersistedSession, scope: ClaudeSessionScope, agentId?: string, offset?: number, signal?: AbortSignal): Promise<{ agentIds: string[]; agentId?: string; messages: readonly unknown[]; hasMore: boolean }>
  compactionOutcome?(session: ClaudePersistedSession, scope: ClaudeSessionScope, promptUuid: string):
    Promise<{ status: 'completed' | 'no-op' | 'failed'; observedAt: string } | null>
  compactionHistory?(session: ClaudePersistedSession, scope: ClaudeSessionScope,
    cursor?: import('./compactionHistory.js').ClaudeCompactionCursor, signal?: AbortSignal): Promise<{
      cursor: import('./compactionHistory.js').ClaudeCompactionCursor; boundaries: Record<string, unknown>[];
    }>
  dispose(): Promise<void>
}
