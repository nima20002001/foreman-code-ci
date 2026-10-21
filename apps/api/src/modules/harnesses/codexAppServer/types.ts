/** Shared state shapes of the Codex app-server session manager layers. */
import type { SessionPreferences, CompactionState, ContextSnapshot, ApprovalResponseOption, CodexHarnessConfiguration,
  ExecutionResult, NativeHarnessEvent, NativeSessionReference, PendingNativeInteraction } from '@foreman-code/contracts'
import type { HarnessExecutionError } from '../errors.js'
import type { CodexRuntimeFileTurn } from '../codexFiles/runtime.js'
import type { CodexRuntimeNativeOutputTurn, CodexNativeOutputSandbox } from '../codexNativeOutput.js'
import type { qualifyNativeCodexModel } from '../codexQualification.js'
import type { NativeSessionStart, NativeTurnInput } from '../port.js'
import type { runCommand } from '../process.js'
import type { assertCodexUnchanged, qualifyCodex, QualifiedCodex } from '../codexProtocol.js'
import type { NativeResponseDeliveryEvidence } from '../../interactions/delivery.js'
import type { CodexStdioTransport, JsonObject, RequestId, RpcRequest } from '../codexStdioTransport.js'
import type { safeEnvironment } from './support.js'

/** Structural client boundary shared by native production and recorded replay. */
export type CodexTransport = Pick<CodexStdioTransport, 'start' | 'request' | 'respond' | 'reject' | 'close'>
  & { isConnected?(): boolean; reattached?(): boolean; detachForRestart?(): Promise<void>
    originalProcessClosed?(): boolean
    retainedThreadSettings?(threadId: string): JsonObject | undefined }
export interface CodexSessionOperations {
  prepareEnvironment?: () => Promise<void>
  transport: (...args: ConstructorParameters<typeof CodexStdioTransport>) => CodexTransport
  qualify: typeof qualifyCodex
  assertUnchanged: typeof assertCodexUnchanged
  environment: typeof safeEnvironment
  runCommand: typeof runCommand
  qualifyModel: typeof qualifyNativeCodexModel
  id: () => string
  now: () => Date
  schedule: typeof setTimeout
  cancelTimer: typeof clearTimeout
  withDiagnostics<T>(pin: CodexDiagnosticPin, run: (io: CodexDiagnosticOperations) => Promise<T>): Promise<T>
}
export interface CodexDiagnosticPin {
  binary: string
  expectedVersion?: string
  cwd: string
  configurationIdentity: string
  scopedCredentialVariables: readonly string[]
  signal?: AbortSignal
}
export type CodexDiagnosticOperations = Pick<CodexSessionOperations,
  'qualify' | 'assertUnchanged' | 'runCommand' | 'qualifyModel' | 'environment'>
/** Replay must supply every IO boundary; partial replay cannot launch native IO. */
export type CodexSessionDependencies =
  | ({ mode: 'native' } & Partial<CodexSessionOperations>)
  | ({ mode: 'replay' } & CodexSessionOperations)
export interface CodexInspectionOptions {
  /** Original installed placement CWD; omitted local callers retain process.cwd(). */
  workingDirectory?: string
}

/** Manager-local residency evidence, never physical process or remote writer authority.
 * A saved thread resumed in a replacement app-server cannot produce this pin. */
export interface CodexOriginalResidency {
  readonly session: NativeSessionReference
  readonly connectionId: string
  readonly runtimeGeneration: number
  /** Only a native ACK past the onSubmitted admission gate establishes a turn here. */
  readonly nativeTurnId: string | undefined
}
export interface CodexOriginalSessionLifetime {
  readonly residency: CodexOriginalResidency
  /** Compose with the caller's existing Main/device/writer fence. */
  assertCurrent(): void
}

export type Delivery = 'pending' | 'submitting' | 'submitted' | 'uncertain'
export interface WaitingRequest {
  pending: PendingNativeInteraction
  requestId: RequestId
  method: string
  generation: number
  transport: CodexTransport
  conflictingIdentity?: boolean
  signature: string
  responses: Map<string, { option: ApprovalResponseOption; nativeResponse: JsonObject }>
  delivery: Delivery
  selectedOptionId?: string
  resolution: Promise<'resolved' | 'cleared'>
  resolve(value: 'resolved' | 'cleared'): void
}
export interface ResolvedRequest {
  signature: string
  nativeRequestId: string | undefined
  nativeTurnId: string | undefined
  method: string
  generation: number
  /** File identity is reserved before work/response awaits, not native acceptance. */
  pending?: boolean
}
export interface TurnSnapshot {
  activeTurnId: string | undefined
  activeCorrelationId: string | undefined
  terminalResult: ExecutionResult | undefined
  finalAnswer: string | undefined
  lastAgentMessage: string | undefined
  finalAnswerId: string | undefined
  lastAgentMessageId: string | undefined
}
export interface StartingTurn {
  correlationId: string
  nativeAttemptId?: string
  previous: TurnSnapshot
  cancelRequested: boolean
  preparationController: AbortController
  filePreparation?: Promise<CodexRuntimeFileTurn | undefined>
  nativeOutputPreparation?: Promise<CodexRuntimeNativeOutputTurn>
  onSubmitted?: NativeTurnInput['onSubmitted']
  acknowledgement?: Promise<void>
  acknowledgedTurnId?: string
  nativeIdentity: Promise<string | undefined>
  resolveIdentity(id: string | undefined): void
  staged: Array<{ method: string; params: JsonObject; arrivalOrdinal?: number } | { request: RpcRequest }>
  stagedBytes: number
}
export interface Runtime extends TurnSnapshot {
  capacityRetry?: {
    attempt: number
    canAdvanceIdentity: boolean
    controller: AbortController
    failure?: ExecutionResult
  }
  parent?: Runtime
  contextBudgetLimit?: number
  sessionPreferences?: SessionPreferences
  compactionPreviousTurns?: Set<string>
  compaction?: CompactionState
  context?: ContextSnapshot
  readonly connectionId: string
  readonly schemaIdentity: string
  arrivalOrdinal: number
  readonly attached: boolean
  readonly binding: string
  readonly ownerId: string
  readonly configurationIdentity: string
  input: NativeSessionStart
  workingDirectory: string
  configuration: CodexHarnessConfiguration
  scopedCredentialVariable: string | undefined
  approvedAppMcpServerName: string | undefined
  strippedCredentialVariable: string | undefined
  qualified: QualifiedCodex
  transport: CodexTransport
  session: NativeSessionReference
  generation: number
  phase: 'idle' | 'starting' | 'active' | 'uncertain'
  streamActive: boolean
  starting: StartingTurn | undefined
  files: CodexRuntimeFileTurn | undefined
  fileCleanup: Promise<void> | undefined
  nativeOutput?: CodexRuntimeNativeOutputTurn | undefined
  nativeOutputCleanup?: Promise<void> | undefined
  effectiveSandbox?: CodexNativeOutputSandbox | undefined
  fileRequests: Map<string, { signature: string; pending: boolean; conflictingIdentity?: boolean }>
  cancellation: { turnId: string; promise: Promise<boolean> } | undefined
  interactions: Map<string, WaitingRequest>
  resolvedRequests: Map<string, ResolvedRequest>
  callbackOwners: Map<string, string>
  rejectedStarts: Map<string, ExecutionResult>
  responseDecisions: Map<string, { pending: PendingNativeInteraction; option: ApprovalResponseOption;
    nativeResponse: JsonObject; sequence: number }>
  responseDeliveries: Map<string, NativeResponseDeliveryEvidence>
  events: NativeHarnessEvent[]
  /** First sequence the active turn stream has not yielded yet. */
  streamCursor?: number
  eventSizes: number[]
  eventBytes: number
  sequence: number
  seenNotifications: Set<string>
  wake: Set<() => void>
  closed: boolean
  observerUnavailable?: HarnessExecutionError
  disposed: boolean
}
export interface Prepared {
  contextBudgetLimit?: number | undefined
  input: NativeSessionStart
  harnessConfiguration: CodexHarnessConfiguration
  workingDirectory: string
  scopedCredentialVariable: string | undefined
  strippedCredentialVariable: string | undefined
  environment: NodeJS.ProcessEnv
  qualified: QualifiedCodex
  disabledMcpServerNames: readonly string[]
  mcpTransportOverrides?: Record<string, string>
  nativeApps?: boolean | undefined
  /** The App MCP server whose tools a workflow Agent calls without native prompts; app grants still authorize each call. */
  approvedAppMcpServerName?: string
  effectiveSandbox?: CodexNativeOutputSandbox
}
export interface Creation {
  identity: string
  status: 'creating' | 'uncertain' | 'ready' | 'rejected'
  source?: NativeSessionReference
  rejection?: unknown
  promise?: Promise<NativeSessionReference>
  session?: NativeSessionReference
  transport?: CodexTransport
  timer?: NodeJS.Timeout
}

export interface CodexMcpConfigurationInspection {
  providerVersion: string
  binary: string
  cwd: string
  serverName: string
  inspectionScope: 'effective_config'
  configured: {
    enabled: boolean; required: boolean; transport: 'stdio' | 'streamable_http' | 'unknown'
    url: string | null; bearerTokenEnvironmentVariable: string | null
    automaticEndpoint?: boolean
    enabledTools: string[] | null; disabledTools: string[]
    defaultToolsApprovalMode: string | null; tools: JsonObject
  }
}
export interface CodexQualificationEvidence {
  providerVersion: string
  schemaManifestSha256: string
  referenceSchemaManifestSha256: string
  stableSchemaGitBlob: string
  schemaVerification: 'installed-contract-validation'
  authentication: 'chatgpt'
  productionSupported: false
  productionRestriction: string
}
