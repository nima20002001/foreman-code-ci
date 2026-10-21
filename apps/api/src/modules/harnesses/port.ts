import type { NativeMessageSubmission } from '@foreman-code/contracts'
import type { DeviceHistoryGap } from '@foreman-code/contracts/device-application'
export type { NativeMessageSubmission } from '@foreman-code/contracts'
import type { CompactionState, ContextSnapshot, SessionControlCapabilities, SessionMode, SessionPreferences } from '@foreman-code/contracts'
import type {
  AgentHarness,
  ExecutionResult,
  HarnessExecutionRequest,
  HarnessQualification,
  HarnessConfiguration,
  ApprovalResponseOption,
  McpDetection,
  NativeHarnessCapabilities,
  NativeHarnessEvent,
  NativeSessionReference,
  PendingNativeInteraction,
  OperatorConfigurationVersion,
  ReviewJob,
  AgentConfigurationVersion,
  PromptSettingSnapshot,
  DurableInteraction,
} from '@foreman-code/contracts'
import type { ChatResponseIdentity } from '@foreman-code/contracts/interaction-activity'

import type { ResponseAvailabilityInspector } from './responseAvailability.js'
import type { RunSubagent } from '@foreman-code/contracts/subagents'
import type { SubagentControlLease } from '../subagents/types.js'

/**
 * Only a qualified adapter may produce these receipts from provider acknowledgements
 * or provider history. Local pending-list eviction and generic terminal events are
 * not evidence. Identity and the exact durable response must survive reconnects.
 */
export interface NativeResponseDeliveryEvidence {
  source: 'provider_acknowledgement' | 'provider_history'
  harness: DurableInteraction['harness']
  providerVersion: string
  nativeSessionId: string
  nativeRequestId: string
  nativeRequestType: string
  optionId: string
  semantic: NonNullable<DurableInteraction['selectedSemantic']>
  responseDigest?: string | undefined
  nativeIdentity?: ChatResponseIdentity
}

export interface NativeEventInput {
  type: string
  payload: Record<string, unknown>
}

/** Read-only settings discovery; this cannot launch, resume, or cancel workflow work. */
export interface HarnessConfigurationQualifier {
  qualify(configuration: HarnessConfiguration, workingDirectory: string, signal?: AbortSignal): Promise<HarnessQualification>
}

/** Values are supplied only to one child process and must never enter logs or persisted graph state. */
export interface ChildProcessEnvironment {
  readonly agentId: string
  readonly variables: Readonly<Record<string, string>>
}

export interface WorkflowNativeSessionStart {
  sessionContinuation?: import('@foreman-code/contracts').WorkflowSessionContinuation
  sessionPreferences?: SessionPreferences
  kind?: 'workflow'
  correlationId?: string
  nativeTurnId?: string
  request: HarnessExecutionRequest
  environment?: ChildProcessEnvironment
  /** The native session already carries its accepted startup instructions; attach/fork never resend them. */
  instructionsDelivered?: boolean
}

export interface OperatorNativeSessionStart {
  /** Observe or stop existing work without refreshing application credentials. */
  observationOnly?: true
  sessionPreferences?: SessionPreferences
  kind: 'operator'
  correlationId: string
  configuration: OperatorConfigurationVersion
  /** Durable identity of the addressed turn, not the latest turn in the session. */
  nativeTurnId?: string
  /** Dedicated validated application-global runtime directory; never inferred from process.cwd(). */
  workingDirectory: string
  environment?: ChildProcessEnvironment
}

export interface AgentChatNativeSessionStart {
  kind: 'agent-chat'
  conversationId: string
  workflowId: string
  workflowNodeId: string
  correlationId: string
  configuration: AgentConfigurationVersion
  systemPrompt?: PromptSettingSnapshot
  workingDirectory: string
  nativeTurnId?: string
  environment?: ChildProcessEnvironment
  instructionsDelivered?: boolean
  sessionPreferences?: SessionPreferences
}

export type NativeSessionStart = WorkflowNativeSessionStart | OperatorNativeSessionStart | AgentChatNativeSessionStart


export interface NativeCompactInput {
  requestId: string
  clientCorrelationId: string
  onProgress(state: CompactionState): Promise<void>
  /** Persist dispatch and recovery metadata before sending the native command. */
  onDispatch?(): Promise<void>
}

export interface NativeTurnInput {
  sessionMode?: SessionMode
  onSettingsApplied?(): Promise<void>
  sessionPreferences?: SessionPreferences
  prompt: string
  /** Native structured output for this turn when the harness supports it (Codex). Claude ignores it;
   * Foreman validates every deliverable either way. */
  outputSchema?: Record<string, unknown> | undefined
  /** Keep a Worker session resident while Main validates and, if needed, corrects its output. */
  deferSettlement?: true | undefined
  clientCorrelationId: string
  /** Await persistence of the provider identity immediately after submission acknowledgement. */
  onSubmitted?(nativeTurnId: string): Promise<void>
  /** Release the failed attempt's writer identity before a confirmed capacity retry.
   * Callers that persist turn IDs must supply this to enable retry. */
  onRetry?(nativeTurnId: string): Promise<void>
  /** Observer history loss does not change the provider's turn result. */
  onEventsSkipped?(gap: DeviceHistoryGap): Promise<void>
  onMessageSubmitted?(identity: NativeMessageSubmission): Promise<void>
  /** Save the matched native result before publishing completion or releasing its runtime. */
  onTerminal?(observation: NativeTerminalObservation): Promise<void>
}

export interface NativeTerminalObservation {
  submission: NativeMessageSubmission
  result: ExecutionResult
  nativeMessageId?: string
  /** Owned history saved with the result so settlement survives process replacement. */
  history?: NativeHistory
}

/** Input added to the exact active turn; the provider rejects it when that turn is no longer active. */
/** Providers that report their native session only after first input use this admitted atomic lifecycle. */
export interface NativeInitialTurnInput extends NativeTurnInput {
  /** Persist the actual provider identity before exposing input ACKs, callbacks or output. */
  onSessionObserved(session: NativeSessionReference): Promise<void>
}

export interface NativeSteerInput {
  prompt: string
  clientCorrelationId: string
  expectedTurnId: string
}

/** Positive acceptance of one steering correlation in one exact native turn; not proof of consumption. */
export interface NativeSteerReceipt {
  nativeSessionId: string
  nativeTurnId: string
  correlationId: string
}

/** Response identity is not a model-turn correlation and must never be used to replay a prompt. */
export interface NativeResponseIdentity {
  nativeRequestId: string
  nativeRequestType: string
  option: ApprovalResponseOption
}

export interface NativeHistory {
  nativeSubmission?: NativeMessageSubmission
  /** Definitive provider rejection of a correlated prompt before a turn exists. */
  nonSubmission?: { nativeSessionId: string; clientCorrelationId: string; result: ExecutionResult }
  /** Set only when the provider result was matched to this exact request. */
  correlationId?: string
  nativeTurnId?: string
  nativeMessageId?: string
  /** Opaque native cursor for older authoritative history; never interpreted as a message ID. */
  nextCursor?: string
  /** This is a bounded live window; callers persist streamed events at the durable boundary. */
  firstRetainedSequence?: number
  nextSequence?: number
  /** Events omitted from this bounded observation; terminal metadata remains original. */
  gap?: DeviceHistoryGap
  interactionDeliveries?: readonly {
    nativeRequestId: string
    state: 'pending' | 'submitting' | 'submitted' | 'uncertain'
    selectedOptionId?: string
  }[]
  /** Explicit provider cancellation evidence, scoped to this exact session. */
  canceledRequestIds?: readonly string[]
  /** Result of the exact requested correlation, never the session's latest turn. */
  terminalTurn?: { correlationId: string; providerId: string; result: ExecutionResult }
  /** Optional positive evidence; an empty pending list is never a delivery receipt. */
  responseDeliveries?: readonly NativeResponseDeliveryEvidence[]
  events: readonly NativeHarnessEvent[]
  pendingInteractions: readonly PendingNativeInteraction[]
  pendingInteraction?: PendingNativeInteraction
  terminalResult?: ExecutionResult
}

/** Provider-neutral native session lifecycle. */
export interface NativeSubagentHistoryPage {
  events: readonly NativeHarnessEvent[]
  nextCursor: string | null
}

export interface NativeHarnessSessionManager extends ResponseAvailabilityInspector {
  readonly harness: AgentHarness
  /** True after native query dispatch; false proves this manager never launched work. */
  requiresRuntimeClosure?(): boolean
  /** Disposal releases a settled remote process instead of stopping unresolved local work. */
  requiresSettledDisposal?(): boolean
  canDetachForRestart?(session: NativeSessionReference): boolean
  /** Original scoped credential for a gracefully detached local daemon. */
  originalEnvironment?(session: NativeSessionReference, signal?: AbortSignal): Promise<Record<string, string> | undefined>
  readonly retainsReviewerSession?: boolean
  prepareReview?(session: NativeSessionReference, job: ReviewJob, signal?: AbortSignal): Promise<void>
  originalApplicationAccess?(session: NativeSessionReference, signal?: AbortSignal):
    Promise<import('@foreman-code/contracts/remote-execution').RemoteApplicationAccess>
  mcpInspectionContext?(signal?: AbortSignal): Promise<{ runnerId: string; workingDirectory: string }>
  /** The domain supplies the authenticated control caller; native callbacks still require a message owner. */
  setSessionControlPrincipal?(principalId: string): void
  applySessionPreferences?(session: NativeSessionReference, preferences: SessionPreferences, signal?: AbortSignal): Promise<void>
  configureSessionPreferences?(preferences: SessionPreferences): Promise<void>
  sessionControlCapabilities?(session: NativeSessionReference): Promise<SessionControlCapabilities>
  compactSession?(session: NativeSessionReference, input: NativeCompactInput, signal?: AbortSignal): Promise<CompactionState>
  /** Inspect persisted native history without attaching a writer or offering input. */
  readCompaction?(session: NativeSessionReference, start: NativeSessionStart,
    state: CompactionState, signal?: AbortSignal): Promise<CompactionState>
  reconcileCompaction?(session: NativeSessionReference, state: CompactionState, signal?: AbortSignal): Promise<CompactionState>
  appliedSessionPreferences?(session: NativeSessionReference): SessionPreferences | null
  contextSnapshot?(session: NativeSessionReference): ContextSnapshot | null
  capabilities(signal?: AbortSignal): Promise<NativeHarnessCapabilities>
  inspectMcp(signal?: AbortSignal): Promise<McpDetection>
  createSession(input: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference>
  /** Look up the original creation only; never launches a process or sends another creation request. */
  reconcileSessionCreation?(input: NativeSessionStart, signal?: AbortSignal,
    forkSource?: NativeSessionReference): Promise<NativeSessionReference>
  /** Verify and rebind a persisted provider identity; never create a replacement session. */
  attachSession(session: NativeSessionReference, input: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference>
  startTurn(session: NativeSessionReference, input: NativeTurnInput, signal?: AbortSignal): AsyncIterable<NativeHarnessEvent>
  /** One first prompt under existing app admission; never a planned/local native session ID. */
  startInitialTurn?(start: NativeSessionStart, input: NativeInitialTurnInput, signal?: AbortSignal): AsyncIterable<NativeHarnessEvent>
  /** Add input to the exact active turn. Absent when the provider has no expected-turn precondition. */
  steerTurn?(session: NativeSessionReference, input: NativeSteerInput, signal?: AbortSignal): Promise<{ nativeTurnId: string }>
  /** Read-only receipt lookup; must not replace the runtime's active turn/correlation or replay input. */
  reconcileSteers?(session: NativeSessionReference,
    inputs: readonly Pick<NativeSteerInput, 'clientCorrelationId' | 'expectedTurnId'>[],
    signal?: AbortSignal): Promise<readonly NativeSteerReceipt[]>
  /** New native session copying a source session's history. The source session is never modified. */
  forkSession?(source: NativeSessionReference, input: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference>
  pending(session: NativeSessionReference, signal?: AbortSignal): Promise<PendingNativeInteraction | undefined>
  respond(session: NativeSessionReference, nativeRequestId: string, option: ApprovalResponseOption, signal?: AbortSignal): Promise<void>
  /** Synchronously stop client-side auto replies before cleanup reads; never terminal evidence. */
  stopAutomaticResponses?(session: NativeSessionReference): void
  cancel(session: NativeSessionReference, signal?: AbortSignal, nativeTurnId?: string): Promise<boolean>
  /** Read native descendants through their exact admitted parent. Never resumes a child or changes its input owner. */
  subagentHistory?(session: NativeSessionReference, cursor?: string, signal?: AbortSignal): Promise<NativeSubagentHistoryPage>
  /** Only an already-resident exact parent may expose child controls. Never allocate or attach here. */
  subagentControl?(child: RunSubagent, assertOwner: () => void): SubagentControlLease | undefined
  history(session: NativeSessionReference, signal?: AbortSignal): Promise<NativeHistory>
  /** Refresh authenticated remote ownership before a coordinator boundary check. */
  observeBoundary?(session: NativeSessionReference, signal?: AbortSignal): Promise<void>
  reconcile(session: NativeSessionReference, correlationId: string, signal?: AbortSignal): Promise<NativeHistory>
  /** Observe chronological retained output without native reconciliation or new output events. */
  historyPage?(session: NativeSessionReference, afterSequence: number, signal?: AbortSignal): Promise<NativeHistory>
  /** Finish Main's output validation and read the Worker's physically settled result. */
  settleTurn?(session: NativeSessionReference, correlationId: string, signal?: AbortSignal): Promise<NativeHistory>
  /** Reconcile ownership, then read chronological retained events without the recent observation window. */
  reconcileHistoryPage?(session: NativeSessionReference, correlationId: string,
    afterSequence: number, signal?: AbortSignal): Promise<NativeHistory>
  /** Release resident turn resources after the caller commits its result and history. */
  retireTurn?(session: NativeSessionReference, correlationId: string): Promise<void | { runtimeReleased: true }>
  /** Rebind a fresh turn credential on an idle, already owned native process. */
  rebindApplicationAccess?(session: NativeSessionReference, start: NativeSessionStart, signal?: AbortSignal): Promise<void>
  /** Read-only recovery of the exact response; missing evidence remains uncertain. */
  reconcileResponse?(session: NativeSessionReference, response: NativeResponseIdentity, signal?: AbortSignal): Promise<NativeHistory>
  close(session: NativeSessionReference, signal?: AbortSignal): Promise<void>
  /** Close an idle process while retaining the persisted session for a later cold resume. */
  closeForResume?(session: NativeSessionReference): Promise<void>
  /** Detach the local runtime for process restart without canceling unresolved provider work. */
  closeForRestart?(session: NativeSessionReference, signal?: AbortSignal): Promise<void>
  /** Stop every owned transport, including creations without a known session identity. */
  dispose?(signal?: AbortSignal): Promise<void>
}
