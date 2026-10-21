import { nativeChatPrompt, prepareWorkerChatFrame, workerInputProof, type AcceptedChatInput, type PreparedChatInput } from './nativeChatInput.js'
import { sessionStartConfiguration, sessionStartDirectory } from '../harnesses/sessionStart.js'
import { definedProperties } from '../definedProperties.js'
import { isDeepStrictEqual } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { readProductEnvironment } from '@foreman-code/contracts/product-environment'
import { APP_MCP_TOKEN_NAMES } from '@foreman-code/contracts/product'
import type { NativeMessageSubmission } from '@foreman-code/contracts/claude'
import {
  CompactionStateSchema, ContextSnapshotSchema, McpDetectionSchema, NativeHarnessCapabilitiesSchema,
  PendingNativeInteractionSchema, SessionControlCapabilitiesSchema, SessionPreferencesSchema,
  type CompactionState, type ContextSnapshot, type NativeSessionReference, type SessionPreferences,
} from '@foreman-code/contracts'
import {
  WorkerConversationHistorySchema, WorkerConversationReceiptSchema, WorkerMcpInspectionSchema, WorkerResponseAvailabilitySchema,
  type WorkerConversationBinding, type WorkerConversationConfiguration, type WorkerConversationRpcRequest,
  type WorkerConversationProfileFacts,
  type WorkerClaudeAuthorityRequest,
  WorkerConversationResponsePageSchema, WORKER_CONVERSATION_RESPONSE_BYTES,
} from '@foreman-code/contracts/remote-execution-rpc'
import { readJsonContinuation } from '../runs/remote/jsonContinuation.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeTurnInput,
  NativeInitialTurnInput, NativeCompactInput, NativeSteerInput, NativeResponseIdentity } from '../harnesses/port.js'
import { normalizeResponseAvailability, type NativeResponseAvailabilityQuery } from '../harnesses/responseAvailability.js'
import type { NativeMcpInspector } from '../harnesses/mcpDetection.js'
import { MainWorkerConversationBridge, type WorkerConversationCallbacks, type WorkerConversationChannel } from './workerBridge.js'
import { workerExecutionConfiguration } from './workerExecutionConfiguration.js'
import type { OperatorConfigurationVersion } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { logIgnoredError } from '../diagnostics/ignoredError.js'
import type { PrepareWorkerFiles } from './mainWorkerFiles.js'

function conflict(message: string): never { throw new DomainError('WORKER_CONVERSATION_CONFLICT', message, 409) }
export interface WorkerConversationManagerOptions {
  binding: WorkerConversationBinding
  configuration: WorkerConversationConfiguration
  /** Temporary readers own their observer, while native runtime ownership stays on Worker. */
  lifecycle?: 'owner' | 'observer'
  acceptedConfiguration?: OperatorConfigurationVersion
  channel: WorkerConversationChannel
  currentChannel?(): WorkerConversationChannel
  bridge: MainWorkerConversationBridge
  current(request: WorkerConversationRpcRequest, signal?: AbortSignal): Promise<void>
  currentForDisposal?(request: WorkerConversationRpcRequest, signal?: AbortSignal): Promise<void>
  observeSession?(session: NativeSessionReference): Promise<void>
  profile?(): Promise<WorkerConversationProfileFacts>
  claudeAuthority?(request: WorkerClaudeAuthorityRequest, signal: AbortSignal): Promise<unknown>
  sourceWorkingDirectory?: string
  files?: PrepareWorkerFiles
  previousConfiguration?: WorkerConversationConfiguration
  previousBinding?: WorkerConversationBinding
  /** D resolves the existing wire credential leaf from the exact accepted AgentSubject. */
  applicationAccess?(start: NativeSessionStart): Extract<WorkerConversationRpcRequest,
    { method: 'conversation.initial-turn' }>['applicationAccess']
}

export type WorkerChatInput =
  | { kind: 'initial'; start: NativeSessionStart; input: NativeInitialTurnInput }
  | { kind: 'turn'; session: NativeSessionReference; input: NativeTurnInput }
  | { kind: 'steer'; session: NativeSessionReference; input: NativeSteerInput }

/** Main's existing native port targets one conversation on its selected paired worker. */
export class WorkerConversationManager implements NativeHarnessSessionManager {
  readonly harness
  private session: NativeSessionReference | undefined
  private observedSession: NativeSessionReference | undefined
  private receipt: z.infer<typeof WorkerConversationReceiptSchema> | undefined
  private preferences: SessionPreferences | undefined
  private context: ContextSnapshot | null = null
  private applied: SessionPreferences | null = null
  private readonly leases = new Set<ReturnType<MainWorkerConversationBridge['capture']>>()
  private credentialLease: ReturnType<MainWorkerConversationBridge['capture']> | undefined
  private readonly recoveredCallbacks = new Map<string, ReturnType<MainWorkerConversationBridge['capture']>>()
  private preparationActive = false
  private runtimeAcquired = false
  private reconnecting: Promise<void> | undefined
  private readonly lifetime = new AbortController()
  private readonly preparedInputs = new Map<string, AcceptedChatInput>()
  private retainedStart: NativeSessionStart | undefined

  constructor(private readonly options: WorkerConversationManagerOptions) {
    this.harness = options.binding.harness
    this.startInitialTurn = this.initialTurn.bind(this)
    if (options.acceptedConfiguration) {
      if (!('operatorId' in options.configuration)) conflict('Presentation changes require an Operator configuration.')
      workerExecutionConfiguration(options.binding, options.acceptedConfiguration, options.configuration)
    }
  }

  private frame(input: Record<string, unknown>): WorkerConversationRpcRequest {
    return { ...input, binding: this.options.binding } as WorkerConversationRpcRequest
  }

  private inputFrame(input: WorkerChatInput): WorkerConversationRpcRequest {
    const common = { prompt: nativeChatPrompt(input.input.prompt, Boolean(this.options.files)),
      correlationId: input.input.clientCorrelationId }
    if (input.kind === 'steer') return this.frame({ method: 'conversation.steer', ...common,
      session: input.session, expectedTurnId: input.input.expectedTurnId })
    const preferences = { ...(input.input.sessionMode ? { sessionMode: input.input.sessionMode } : {}),
      ...(input.input.sessionPreferences ? { preferences: input.input.sessionPreferences } : {}) }
    if (input.kind === 'turn') return this.frame({ method: 'conversation.start-turn', ...common, ...preferences,
      session: input.session, ...(this.options.files ? { fileInputs: true } : {}) })
    return this.frame({ method: 'conversation.initial-turn', ...this.startFields(input.start), ...common, ...preferences,
      ...(this.options.previousBinding ? { previousBinding: this.options.previousBinding } : {}),
      ...(this.options.previousConfiguration ? { previousConfiguration: this.options.previousConfiguration } : {}) })
  }

  /** Pure preparation: callers invoke this before persisting a message, using accepted owner facts. */
  prepareInput(input: WorkerChatInput): PreparedChatInput {
    const frame = prepareWorkerChatFrame(this.inputFrame(input))
    return { prompt: 'prompt' in frame ? frame.prompt : input.input.prompt,
      workerFrames: [frame] }
  }

  restorePreparedInput(correlationId: string, accepted: AcceptedChatInput): void {
    this.preparedInputs.set(correlationId, structuredClone(accepted))
  }

  private acceptedInput(input: WorkerChatInput): WorkerConversationRpcRequest {
    const frame = prepareWorkerChatFrame(this.inputFrame(input))
    const prepared = this.preparedInputs.get(input.input.clientCorrelationId)
    if (!prepared) return frame // Historical commands predate retained preparation; new admission restores its proof.
    const proof = workerInputProof(frame)
    if (!prepared.workerProofs.some(saved => saved.method === proof.method && saved.inputHash === proof.inputHash)) {
      throw new DomainError('CHAT_PREFLIGHT_CHANGED', 'The native input no longer matches its accepted prepared frame.', 409)
    }
    this.preparedInputs.delete(input.input.clientCorrelationId)
    return frame
  }
  private currentChannel() {
    const channel = this.options.currentChannel?.() ?? this.options.channel
    for (const field of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const) {
      if (channel.binding[field] !== this.options.channel.binding[field]) conflict('The original paired worker authority changed.')
    }
    return channel
  }
  private waitForReconnect(task: Promise<void>, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (!signal) return task
    return new Promise<void>((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
      void task.then(() => {
        signal.removeEventListener('abort', abort)
        resolve()
      }, error => {
        signal.removeEventListener('abort', abort)
        reject(error)
      })
    })
  }
  private async reconnect(signal?: AbortSignal, options: { reattachSession?: boolean } = {}) {
    this.lifetime.signal.throwIfAborted()
    signal?.throwIfAborted()
    if (this.reconnecting) return this.waitForReconnect(this.reconnecting, signal)
    const channel = this.currentChannel()
    if (isDeepStrictEqual(channel.binding, this.options.channel.binding)) return
    const previousChannel = this.options.channel
    const task = (async () => {
      for (const lease of [...this.leases]) await this.release(lease)
      this.recoveredCallbacks.clear()
      this.credentialLease = undefined
      this.options.channel = channel
      if (!this.session || options.reattachSession === false) return
      const session = this.session
      const lease = this.captureConnected(this.frame({ method: 'conversation.open', mode: 'attach', source: session,
        operationId: this.receipt?.creation?.operationId ?? 'session-reconnect', configuration: this.options.configuration }))
      try {
        const receipt = this.adopt(await lease.request(this.lifetime.signal), session)
        if (!receipt?.session || !isDeepStrictEqual(receipt.session, session)) conflict('The worker attached a different session.')
      } catch (error) {
        this.options.channel = previousChannel
        throw error
      } finally { await this.release(lease) }
    })()
    this.reconnecting = task
    void task.then(() => {
      if (this.reconnecting === task) this.reconnecting = undefined
    }, error => {
      if (this.reconnecting === task) this.reconnecting = undefined
      if (!this.lifetime.signal.aborted) logIgnoredError('harness', 'reconnect Worker conversation', error)
    })
    return this.waitForReconnect(task, signal)
  }
  private async capture(frame: WorkerConversationRpcRequest, options: {
    callbacks?: WorkerConversationCallbacks; recoveredSubmission?: NativeMessageSubmission; recoveredTurnId?: string
    session?: NativeSessionReference
    current?: WorkerConversationManagerOptions['current']
  } = {}, signal?: AbortSignal) {
    await this.reconnect(signal, { reattachSession: frame.method !== 'conversation.release-runtime' })
    return this.captureConnected(frame, options)
  }
  private captureConnected(frame: WorkerConversationRpcRequest, options: {
    callbacks?: WorkerConversationCallbacks; recoveredSubmission?: NativeMessageSubmission; recoveredTurnId?: string
    session?: NativeSessionReference
    current?: WorkerConversationManagerOptions['current']
  } = {}): ReturnType<MainWorkerConversationBridge['capture']> {
    const channel = this.options.channel
    let requested = false
    const observedChannel: WorkerConversationChannel = { binding: channel.binding, request: async (...args) => {
      requested = true
      return channel.request(...args)
    } }
    const captured = this.options.bridge.capture({ request: frame, channel: observedChannel,
      callbacks: { ...(this.options.profile ? { profile: this.options.profile } : {}),
        ...(this.options.files ? { files: this.options.files } : {}),
        ...(this.options.claudeAuthority ? { claudeAuthority: this.options.claudeAuthority } : {}), ...options.callbacks },
      ...(options.recoveredSubmission ? { recoveredSubmission: options.recoveredSubmission } : {}),
      ...(options.recoveredTurnId ? { recoveredTurnId: options.recoveredTurnId } : {}),
      ...(options.session ? { session: options.session } : {}),
      current: async signal => {
        this.lifetime.signal.throwIfAborted()
        await (options.current ?? this.options.current)(frame, signal)
        if (!isDeepStrictEqual((this.options.currentChannel?.() ?? channel).binding, channel.binding)) {
          conflict('The admitted worker connection changed.')
        }
      } })
    const lease = { ...captured, request: async (signal?: AbortSignal) => {
      requested = false
      let raw: unknown
      try {
        raw = await captured.request(signal)
      } catch (error) {
        // A failed process change does not acquire its replacement owner.
        if (requested && ['conversation.preferences', 'conversation.open', 'conversation.initial-turn', 'conversation.start-turn']
          .includes(frame.method)) this.runtimeAcquired = false
        throw error
      }
      if (frame.method === 'conversation.response-continuation') return raw
      const parsed = WorkerConversationResponsePageSchema.safeParse(raw)
      if (!parsed.success) return raw
      const first = parsed.data
      return readJsonContinuation(first.metadata, async metadata => {
        const continuation = this.captureConnected(this.frame({
          method: 'conversation.response-continuation', transferId: first.transferId, metadata,
        }), { current: options.current ?? this.options.current })
        try {
          const next = WorkerConversationResponsePageSchema.parse(await continuation.request(signal))
          if (next.transferId !== first.transferId) conflict('The conversation response snapshot changed.')
          return next.metadata
        } finally { await this.release(continuation) }
      }, signal, { maxBytes: WORKER_CONVERSATION_RESPONSE_BYTES })
    } }
    this.leases.add(lease)
    return lease
  }
  private async release(lease: ReturnType<MainWorkerConversationBridge['capture']>) {
    await lease.close()
    this.leases.delete(lease)
  }
  private async releaseCredential() {
    if (this.credentialLease) await this.release(this.credentialLease)
    this.credentialLease = undefined
  }
  private async request(input: Record<string, unknown>, signal?: AbortSignal) {
    const lease = await this.capture(this.frame(input), {}, signal)
    try { return await lease.request(signal) } finally { await this.release(lease) }
  }
  private readReceipt(raw: unknown) {
    const value = z.object({ receipt: WorkerConversationReceiptSchema.optional() }).passthrough().parse(raw)
    const receipt = value.receipt
    if (!receipt) return undefined
    if (!isDeepStrictEqual(receipt.binding, this.options.binding)) conflict('The worker returned another conversation owner.')
    for (const field of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const) {
      if (receipt.connection[field] !== this.options.channel.binding[field]) conflict('The original worker installation changed.')
    }
    return receipt
  }
  private adopt(raw: unknown, attachment?: NativeSessionReference) {
    const receipt = this.readReceipt(raw)
    if (!receipt) return undefined
    if (receipt.connection.bootId !== this.options.channel.binding.bootId) conflict('The original worker installation changed.')
    return this.adoptReceipt(receipt, attachment)
  }
  private adoptReceipt(receipt: z.infer<typeof WorkerConversationReceiptSchema>, attachment?: NativeSessionReference) {
    const older = this.receipt && receipt.revision < this.receipt.revision
    const transitions = older ? this.receipt : receipt
    let transitioned = older ? receipt.nativeOwner : this.receipt?.nativeOwner
    for (const change of transitions?.ownerTransitions ?? []) {
      if (change.previous.sessionId !== receipt.session?.nativeSessionId
        || change.next.sessionId !== receipt.session?.nativeSessionId) {
        conflict('The worker process transition belongs to another native session.')
      }
      if (isDeepStrictEqual(change.previous, transitioned)) transitioned = change.next
    }
    const recovered = this.receipt?.nativeOwner && receipt.revision !== this.receipt.revision
      && isDeepStrictEqual(older ? this.receipt.nativeOwner : receipt.nativeOwner, transitioned)
    if (this.receipt && (this.receipt.session && !isDeepStrictEqual(receipt.session, this.receipt.session)
      || this.receipt.nativeOwner && !isDeepStrictEqual(receipt.nativeOwner, this.receipt.nativeOwner)
        && !recovered && (!attachment || !isDeepStrictEqual(this.receipt.session, attachment)
          || !isDeepStrictEqual(receipt.session, attachment)))) {
      conflict('The original worker native owner changed.')
    }
    if (this.receipt && receipt.revision < this.receipt.revision) return this.receipt
    this.receipt = receipt
    this.applied = receipt.appliedPreferences
    if (receipt.session) this.session = structuredClone(receipt.session)
    return receipt
  }
  private assertSession(session: NativeSessionReference) {
    if (!this.session || !isDeepStrictEqual(this.session, session)) conflict('This manager does not own the addressed native session.')
  }
  private startFields(start: NativeSessionStart) {
    const configuration = sessionStartConfiguration(start)
    const workingDirectory = sessionStartDirectory(start)
    const roleMatches = this.options.binding.owner.kind === 'operator' ? start.kind === 'operator' : start.kind === 'agent-chat'
    if (!roleMatches || commandInputHash(configuration) !== commandInputHash(this.options.acceptedConfiguration ?? this.options.configuration)
      || commandInputHash(this.options.configuration) !== this.options.binding.owner.configurationHash
      || workingDirectory !== (this.options.sourceWorkingDirectory ?? this.options.binding.workingDirectory) || !start.correlationId) {
      conflict('The native startup differs from its saved conversation admission.')
    }
    const owner = this.options.binding.owner
    if (owner.kind === 'agent' && (start.kind !== 'agent-chat'
      || start.conversationId !== owner.conversationId || start.workflowId !== owner.workflowId
      || start.workflowNodeId !== owner.workflowNodeId
      || !isDeepStrictEqual(start.systemPrompt, this.options.binding.systemPrompt))) {
      conflict('The native startup belongs to another node conversation.')
    }
    const environment = start.environment
    const ownerId = this.options.binding.owner.kind === 'operator'
      ? this.options.binding.owner.operatorId : this.options.binding.owner.agentId
    if (environment && (environment.agentId !== ownerId
      || Object.keys(environment.variables).some(name => !(APP_MCP_TOKEN_NAMES as readonly string[]).includes(name)))) {
      conflict('Only this conversation’s scoped application credential may cross the worker channel.')
    }
    const token = environment && readProductEnvironment(environment.variables, 'MCP_TOKEN')
    const applicationAccess = this.options.applicationAccess?.(start)
      ?? (token && this.options.binding.owner.kind === 'operator' ? { kind: 'operator-chat-mcp' as const, token } : undefined)
    if ((token || applicationAccess) && this.options.binding.appMcpAccess !== 'scoped'
      || token && !applicationAccess
      || applicationAccess?.kind === 'operator-chat-mcp' && this.options.binding.owner.kind !== 'operator') {
      conflict('The native credential does not match this conversation’s exact scoped owner.')
    }
    return { operationId: start.correlationId, configuration: this.options.configuration,
      ...(this.preferences ? { preferences: this.preferences } : {}),
      ...(applicationAccess ? { applicationAccess } : {}) }
  }
  private async open(start: NativeSessionStart, mode: 'create' | 'attach' | 'fork',
    source: NativeSessionReference | undefined, signal?: AbortSignal) {
    this.retainedStart = start
    const fields = this.startFields(start)
    if (mode === 'attach' && start.kind === 'operator' && start.observationOnly) delete fields.applicationAccess
    const frame = this.frame({ method: 'conversation.open', ...fields, mode,
      ...((mode === 'attach' || mode === 'create') && this.options.previousBinding ? { previousBinding: this.options.previousBinding } : {}),
      ...((mode === 'attach' || mode === 'create') && this.options.previousConfiguration
        ? { previousConfiguration: this.options.previousConfiguration } : {}),
      ...(source ? { source } : {}) })
    const lease = await this.capture(frame, { callbacks: { sessionObserved: async session => {
      if (session.harness !== this.harness || mode === 'fork' && session.nativeSessionId === source?.nativeSessionId) {
        conflict('The worker returned a foreign or non-independent session.')
      }
      this.session = structuredClone(session)
      await this.options.observeSession?.(session)
      await this.releaseCredential()
    } } })
    try {
      const receipt = this.adopt(await lease.request(signal), mode === 'attach' ? source : undefined)
      if (!receipt?.session) conflict('Native creation is unresolved; a replacement session will not be created.')
      if (mode === 'attach' && !isDeepStrictEqual(receipt.session, source)) conflict('The worker attached a different session.')
      if (this.options.previousBinding) {
        await this.options.observeSession?.(receipt.session)
        delete this.options.previousBinding
        delete this.options.previousConfiguration
      }
      this.runtimeAcquired = true
      return receipt.session
    } finally { await this.release(lease) }
  }
  async createSession(start: NativeSessionStart, signal?: AbortSignal) { return this.open(start, 'create', undefined, signal) }
  async attachSession(session: NativeSessionReference, start: NativeSessionStart, signal?: AbortSignal) {
    return this.open(start, 'attach', session, signal)
  }
  async forkSession(source: NativeSessionReference, start: NativeSessionStart, signal?: AbortSignal) {
    return this.open(start, 'fork', source, signal)
  }
  async reconcileSessionCreation(start: NativeSessionStart, signal?: AbortSignal, forkSource?: NativeSessionReference) {
    const fields = this.startFields(start)
    const raw = await this.request({ method: 'conversation.status' }, signal)
    const record = z.object({ receipt: WorkerConversationReceiptSchema.optional() }).parse(raw).receipt
    const initialTurn = !forkSource && Boolean(record?.turns.some(turn => turn.correlationId === fields.operationId
      && turn.creationOperationId === fields.operationId))
    const inputHash = commandInputHash(initialTurn
      ? { mode: 'initial-turn', correlationId: fields.operationId }
      : { mode: forkSource ? 'fork' : 'create', source: forkSource ?? null, preferences: fields.preferences ?? null })
    if (!record?.session || record.creation?.operationId !== fields.operationId
      || record.creation.inputHash !== inputHash
      || initialTurn && !record.turns.some(turn => turn.correlationId === fields.operationId
        && turn.creationOperationId === fields.operationId)) {
      conflict('The original worker session creation is not established.')
    }
    if (!isDeepStrictEqual(record.binding, this.options.binding)) conflict('The worker returned another conversation owner.')
    for (const field of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const) {
      if (record.connection[field] !== this.options.channel.binding[field]) conflict('The original worker installation changed.')
    }
    const observingTransition = this.options.previousBinding !== undefined
    const session = await this.attachSession(record.session, start, signal)
    if (!observingTransition) await this.options.observeSession?.(session)
    return session
  }
  async configureSessionPreferences(preferences: SessionPreferences) { this.preferences = SessionPreferencesSchema.parse(preferences) }
  async capabilities(signal?: AbortSignal) {
    this.preparationActive = true
    return NativeHarnessCapabilitiesSchema.parse(await this.request({ method: 'conversation.capabilities',
      configuration: this.options.configuration }, signal))
  }
  async inspectMcp(signal?: AbortSignal) {
    this.preparationActive = true
    return McpDetectionSchema.parse(await this.request({ method: 'conversation.inspect-mcp', configuration: this.options.configuration }, signal))
  }
  async mcpInspectionContext(signal?: AbortSignal) {
    signal?.throwIfAborted()
    this.lifetime.signal.throwIfAborted()
    return { runnerId: `device:${this.options.channel.binding.deviceId}`, workingDirectory: this.options.binding.workingDirectory }
  }
  readonly inspector: NativeMcpInspector = { inspect: async input => {
    this.preparationActive = true
    const value = WorkerMcpInspectionSchema.parse(await this.request({
    method: 'conversation.inspect-entry', configuration: this.options.configuration,
    inspection: { harness: input.harness, runnerId: input.runnerId, workingDirectory: input.workingDirectory,
      serverName: input.serverName, ...(input.phase ? { phase: input.phase } : {}) },
    }, input.signal))
    const entry = value.entry
    if (entry?.pairedEndpoint) {
      const host = this.options.binding.profile.target.hostRef
      const harness = this.options.configuration.harness
      const configured = harness.harness === 'claude' ? harness.mcpServers[entry.name] : undefined
      if (host.kind !== 'device' || entry.pairedEndpoint.mainId !== host.mainId
        || entry.pairedEndpoint.deviceId !== host.deviceId || configured?.type !== 'http'
        || configured.url !== entry.pairedEndpoint.configuredEndpoint
        || entry.endpoint !== entry.pairedEndpoint.nativeEndpoint) conflict('The paired MCP route differs from this saved profile.')
    }
    return { harness: value.harness, providerVersion: value.providerVersion, runnerId: value.runnerId,
      workingDirectory: value.workingDirectory, inspectedAt: value.inspectedAt,
      ...(value.generation !== undefined ? { generation: value.generation } : {}),
      ...(value.authorizationScope !== undefined ? { authorizationScope: value.authorizationScope } : {}),
      ...(entry ? { entry: { name: entry.name, transport: entry.transport,
        ...(entry.automaticEndpoint !== undefined ? { automaticEndpoint: entry.automaticEndpoint } : {}),
        ...(entry.endpoint !== undefined ? { endpoint: entry.endpoint } : {}),
        ...(entry.pairedEndpoint ? { pairedEndpoint: entry.pairedEndpoint } : {}),
        ...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
        ...(entry.credentialEnvironmentVariable !== undefined ? { credentialEnvironmentVariable: entry.credentialEnvironmentVariable } : {}),
        ...(entry.credentialArrangement ? { credentialArrangement: entry.credentialArrangement } : {}),
        ...(entry.status !== undefined ? { status: entry.status } : {}),
        ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
        ...(entry.enabledTools ? { enabledTools: entry.enabledTools } : {}),
        ...(entry.disabledTools ? { disabledTools: entry.disabledTools } : {}),
        ...(entry.nativeFilterDiagnostics ? { nativeFilterDiagnostics: entry.nativeFilterDiagnostics } : {}),
      } } : {}),
    }
  } }

  async deliverClaudeCredential(token: string, signal: AbortSignal) {
    if (this.harness !== 'claude' || this.options.binding.owner.kind !== 'operator'
      || this.options.binding.appMcpAccess !== 'scoped') conflict('This manager has no scoped Claude Operator credential.')
    return this.deliverScopedCredential({ kind: 'operator-chat-mcp', token }, signal)
  }

  private async deliverScopedCredential(applicationAccess: NonNullable<Extract<WorkerConversationRpcRequest,
    { method: 'conversation.initial-turn' }>['applicationAccess']>, signal: AbortSignal) {
    this.preparationActive = true
    const lease = await this.capture(this.frame({
      method: 'conversation.refresh-mcp', configuration: this.options.configuration,
      applicationAccess,
    }))
    try {
      const result = z.object({ acknowledged: z.literal(true) }).strict().parse(await lease.request(signal))
      await this.releaseCredential()
      // Before native SID persistence, the normal credential relay needs its live startup admission.
      if (this.session) await this.release(lease)
      else this.credentialLease = lease
      return result
    } catch (error) { await this.release(lease); throw error }
  }

  private checkRejection(correlationId: string) {
    const turn = this.receipt?.turns.find(turn => turn.correlationId === correlationId)
    if (turn?.status !== 'rejected' || !turn.result) return
    throw Object.assign(new Error(turn.result.error?.message ?? 'Native input was not delivered.'), {
      result: turn.result, certainty: 'definite', deliveryState: 'not-delivered',
    })
  }

  private async *stream(frame: WorkerConversationRpcRequest, input: NativeTurnInput,
    initial: NativeInitialTurnInput | undefined, signal?: AbortSignal, openSession?: NativeSessionReference) {
    // The Worker journals its session before its callback reaches Main, and Main can read that journaled session
    // (with the first native events) first. Whichever path comes first persists the observation exactly once.
    let observation: Promise<void> | undefined
    const observeSession = (session: NativeSessionReference) => observation ??= (async () => {
      if (!initial || session.harness !== this.harness) conflict('Unexpected initial native session observation.')
      await initial.onSessionObserved(session)
      this.session = structuredClone(session)
      await this.options.observeSession?.(session)
      await this.releaseCredential()
    })()
    const lease = await this.capture(frame, { ...(openSession ? { session: openSession } : {}), callbacks: {
      sessionObserved: observeSession,
      submitted: async (_correlationId, identity) => {
        if (identity.nativeTurnId) await input.onSubmitted?.(identity.nativeTurnId)
        if (identity.nativeSubmission) await input.onMessageSubmitted?.(identity.nativeSubmission)
      },
      settingsApplied: async () => { await input.onSettingsApplied?.() },
      terminalObserved: async observation => { await input.onTerminal?.(observation) },
    } })
    const pollSignal = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])])
    let sequence: number | undefined
    let pollDelayMs = 100
    try {
      if (this.session && !initial) {
        const history = await this.history(this.session, pollSignal)
        sequence = (history.nextSequence ?? Math.max(-1, ...history.events.map(event => event.sequence)) + 1) - 1
      }
      this.adopt(await lease.request(pollSignal))
      this.runtimeAcquired = true
      this.checkRejection(input.clientCorrelationId)
      while (true) {
        pollSignal.throwIfAborted()
        if (!this.session) {
          this.adopt(await this.request({ method: 'conversation.status' }, pollSignal))
          this.checkRejection(input.clientCorrelationId)
          if (!this.session) { await delay(100, undefined, { signal: pollSignal }); continue }
        }
        if (initial) await observeSession(this.session)
        const readStarted = performance.now()
        const value = z.object({ history: WorkerConversationHistorySchema, context: ContextSnapshotSchema.nullable(),
          receipt: WorkerConversationReceiptSchema }).parse(await this.request({ method: 'conversation.history',
          session: this.session, correlationId: input.clientCorrelationId,
          afterSequence: sequence ?? -1, waitForEvents: true }, pollSignal))
        this.adopt(value)
        this.checkRejection(input.clientCorrelationId)
        this.context = value.context
        if (sequence !== undefined && value.history.firstRetainedSequence !== undefined
          && sequence < value.history.firstRetainedSequence - 1) conflict('The worker event window has advanced; recover persisted history.')
        const previousSequence = sequence
        for (const event of value.history.events) {
          if (sequence !== undefined && event.sequence <= sequence) continue
          sequence = event.sequence
          yield event
        }
        const turn = value.receipt.turns.find(turn => turn.correlationId === input.clientCorrelationId)
        if (turn?.status === 'completed'
          && (value.history.nextSequence === undefined || (sequence ?? -1) >= value.history.nextSequence - 1)) return
        if (turn?.status === 'uncertain') conflict('The original worker turn needs native recovery; input was not replayed.')
        pollDelayMs = sequence === previousSequence ? Math.min(2000, pollDelayMs * 2) : 100
        // The event wait consumes the read interval; bursts still obey the existing request rate limit.
        const remainingDelay = pollDelayMs - (performance.now() - readStarted)
        if (remainingDelay > 0) await delay(remainingDelay, undefined, { signal: pollSignal })
      }
    } finally { await this.release(lease) }
  }
  startTurn(session: NativeSessionReference, input: NativeTurnInput, signal?: AbortSignal) {
    this.assertSession(session)
    if (this.preparedInputs.get(input.clientCorrelationId)?.workerProofs.some(proof => proof.method === 'conversation.initial-turn')) {
      if (!this.retainedStart) conflict('The accepted conversation-bound input has no restored startup facts.')
      const start = { ...this.retainedStart, correlationId: input.clientCorrelationId }
      const frame = this.acceptedInput({ kind: 'initial', start, input: { ...input,
        onSessionObserved: async observed => { this.assertSession(observed) } } })
      // The session is already open: its callbacks address it, as an initial frame carries no session of its own.
      return this.stream(frame, input, undefined, signal, session)
    }
    return this.stream(this.acceptedInput({ kind: 'turn', session, input }), input, undefined, signal)
  }
  readonly startInitialTurn?: NonNullable<NativeHarnessSessionManager['startInitialTurn']>
  private initialTurn(start: NativeSessionStart, input: NativeInitialTurnInput, signal?: AbortSignal) {
    this.retainedStart = start
    return this.stream(this.acceptedInput({ kind: 'initial', start, input }), input, input, signal)
  }
  async history(session: NativeSessionReference, signal?: AbortSignal): Promise<NativeHistory> {
    return this.readHistory(session, signal)
  }
  async rebindApplicationAccess(session: NativeSessionReference, start: NativeSessionStart, signal?: AbortSignal) {
    this.assertSession(session)
    const fields = this.startFields(start)
    if (!fields.applicationAccess) conflict('A fresh scoped application credential is required.')
    if (this.harness === 'claude') {
      await this.deliverScopedCredential(fields.applicationAccess, signal ?? new AbortController().signal)
    } else {
      await this.open(start, 'attach', session, signal)
    }
    this.retainedStart = start
  }
  async retireTurn(session: NativeSessionReference, correlationId: string) {
    this.assertSession(session)
    if (this.receipt?.creation?.operationId === correlationId
      && !this.receipt.turns.some(turn => turn.correlationId === correlationId)) return
    this.adopt(await this.request({ method: 'conversation.retire-turn', session, correlationId }))
    if (this.receipt?.runtimeReleased) return { runtimeReleased: true as const }
  }
  private async readHistory(session: NativeSessionReference, signal?: AbortSignal): Promise<NativeHistory> {
    this.assertSession(session)
    return this.historyResponse(await this.request({ method: 'conversation.history', session }, signal))
  }
  private historyResponse(raw: unknown): NativeHistory {
    const value = z.object({ history: WorkerConversationHistorySchema, context: ContextSnapshotSchema.nullable(),
      receipt: WorkerConversationReceiptSchema }).parse(raw)
    this.adopt(value)
    this.context = value.context
    const history = value.history
    return { events: history.events, pendingInteractions: history.pendingInteractions,
      ...(history.nonSubmission ? { nonSubmission: history.nonSubmission } : {}),
      ...(history.correlationId !== undefined ? { correlationId: history.correlationId } : {}),
      ...(history.nativeTurnId !== undefined ? { nativeTurnId: history.nativeTurnId } : {}),
      ...(history.nativeMessageId !== undefined ? { nativeMessageId: history.nativeMessageId } : {}),
      ...(history.nativeSubmission !== undefined ? { nativeSubmission: history.nativeSubmission } : {}),
      ...(history.nextCursor !== undefined ? { nextCursor: history.nextCursor } : {}),
      ...(history.firstRetainedSequence !== undefined ? { firstRetainedSequence: history.firstRetainedSequence } : {}),
      ...(history.nextSequence !== undefined ? { nextSequence: history.nextSequence } : {}),
      ...(history.pendingInteraction !== undefined ? { pendingInteraction: history.pendingInteraction } : {}),
      ...(history.terminalResult !== undefined ? { terminalResult: history.terminalResult } : {}),
      ...(history.terminalTurn !== undefined ? { terminalTurn: history.terminalTurn } : {}),
      ...(history.interactionDeliveries ? { interactionDeliveries: history.interactionDeliveries.map(delivery => ({
        nativeRequestId: delivery.nativeRequestId, state: delivery.state,
        ...(delivery.selectedOptionId !== undefined ? { selectedOptionId: delivery.selectedOptionId } : {}),
      })) } : {}),
      ...(history.responseDeliveries ? { responseDeliveries: history.responseDeliveries.map(definedProperties) } : {}),
      ...(history.canceledRequestIds ? { canceledRequestIds: history.canceledRequestIds } : {}),
    }
  }
  async reconcile(session: NativeSessionReference, correlationId: string, signal?: AbortSignal) {
    this.assertSession(session)
    await this.reconnect(signal)
    const live = this.recoveredCallbacks.get(correlationId)
    if (live) {
      const history = this.historyResponse(await live.request(signal))
      if (this.receipt?.turns.find(turn => turn.correlationId === correlationId)?.status === 'completed') {
        await this.release(live)
        this.recoveredCallbacks.delete(correlationId)
      }
      return history
    }
    const accepted = this.receipt?.turns.find(turn => turn.correlationId === correlationId)
    const submission = this.harness === 'claude' ? accepted?.nativeSubmission : undefined
    const files = this.harness === 'codex' && this.options.files
    const recoveredTurnId = files
      && accepted?.status !== 'completed' ? accepted?.nativeTurnId : undefined
    const frame = this.frame({ method: 'conversation.reconcile', session, correlationId,
      ...(accepted?.sessionMode ? { sessionMode: accepted.sessionMode } : {}) })
    const lease = await this.capture(frame, { ...(submission ? { recoveredSubmission: submission } : {}),
      ...(recoveredTurnId ? { recoveredTurnId } : {}) })
    try {
      const history = this.historyResponse(await lease.request(signal))
      const previous = this.recoveredCallbacks.get(correlationId)
      if (previous) await this.release(previous)
      this.recoveredCallbacks.delete(correlationId)
      const turn = this.receipt?.turns.find(turn => turn.correlationId === correlationId)
      if ((submission || recoveredTurnId) && turn?.status !== 'completed') this.recoveredCallbacks.set(correlationId, lease)
      else await this.release(lease)
      return history
    } catch (error) {
      await this.release(lease)
      throw error
    }
  }
  private async recoverPendingCallbacks(session: NativeSessionReference, signal?: AbortSignal) {
    if (this.harness !== 'claude') return
    const turns = this.receipt?.turns.filter(turn => turn.status !== 'completed' && turn.nativeSubmission) ?? []
    if (turns.length > 1) conflict('The active native message is ambiguous.')
    const turn = turns[0]
    if (turn && !this.recoveredCallbacks.has(turn.correlationId)) {
      await this.reconcile(session, turn.correlationId, signal)
    }
  }
  async pending(session: NativeSessionReference, signal?: AbortSignal) {
    this.assertSession(session)
    await this.recoverPendingCallbacks(session, signal)
    const raw = await this.request({ method: 'conversation.pending', session }, signal)
    return raw == null ? undefined : PendingNativeInteractionSchema.parse(raw)
  }
  async respond(session: NativeSessionReference, nativeRequestId: string,
    option: Parameters<NativeHarnessSessionManager['respond']>[2], signal?: AbortSignal) {
    this.assertSession(session)
    await this.recoverPendingCallbacks(session, signal)
    this.adopt(await this.request({ method: 'conversation.respond', session, nativeRequestId, option }, signal))
  }
  async reconcileResponse(session: NativeSessionReference, response: NativeResponseIdentity, signal?: AbortSignal) {
    this.assertSession(session)
    return this.historyResponse(await this.request({ method: 'conversation.response-reconcile', session, response }, signal))
  }
  async inspectResponseAvailability(session: NativeSessionReference, query: NativeResponseAvailabilityQuery, signal?: AbortSignal) {
    this.assertSession(session)
    await this.recoverPendingCallbacks(session, signal)
    const value = WorkerResponseAvailabilitySchema.parse(await this.request({
      method: 'conversation.response-availability', session, query }, signal))
    return normalizeResponseAvailability(session, query, { nativeSessionId: value.nativeSessionId,
      nativeRequestId: value.nativeRequestId, nativeRequestType: value.nativeRequestType,
      qualified: value.qualified, state: value.state, path: value.path, reason: value.reason,
      ...(value.nativeTurnId ? { nativeTurnId: value.nativeTurnId } : {}),
      ...(value.nativeMessageId ? { nativeMessageId: value.nativeMessageId } : {}),
      ...(value.generation ? { generation: value.generation } : {}) })
  }
  async cancel(session: NativeSessionReference, signal?: AbortSignal, nativeTurnId?: string) {
    this.assertSession(session)
    return z.object({ canceled: z.boolean() }).parse(await this.request({ method: 'conversation.cancel', session,
      ...(nativeTurnId ? { nativeTurnId } : {}) }, signal)).canceled
  }
  async steerTurn(session: NativeSessionReference, input: NativeSteerInput, signal?: AbortSignal) {
    this.assertSession(session)
    const lease = await this.capture(this.acceptedInput({ kind: 'steer', session, input }))
    try { return z.object({ nativeTurnId: z.string().min(1) }).parse(await lease.request(signal)) }
    finally { await this.release(lease) }
  }
  async reconcileSteers(session: NativeSessionReference, inputs: readonly Pick<NativeSteerInput, 'clientCorrelationId' | 'expectedTurnId'>[], signal?: AbortSignal) {
    this.assertSession(session)
    return z.array(z.object({ nativeSessionId: z.string(), nativeTurnId: z.string(), correlationId: z.string() })).parse(
      await this.request({ method: 'conversation.reconcile-steers', session, inputs }, signal))
  }
  async applySessionPreferences(session: NativeSessionReference, preferences: SessionPreferences, signal?: AbortSignal) {
    this.assertSession(session)
    this.adopt(await this.request({ method: 'conversation.preferences', session, preferences }, signal))
  }
  async sessionControlCapabilities(session: NativeSessionReference) {
    this.assertSession(session)
    const value = z.object({ capabilities: SessionControlCapabilitiesSchema, context: ContextSnapshotSchema.nullable(),
      preferences: SessionPreferencesSchema.nullable(), receipt: WorkerConversationReceiptSchema }).parse(
      await this.request({ method: 'conversation.controls-read', session }))
    const receipt = this.adopt(value)
    if (value.context && value.context.nativeSessionId !== session.nativeSessionId) conflict('The worker context belongs to another session.')
    this.context = value.context
    this.applied = receipt ? receipt.appliedPreferences : value.preferences
    return value.capabilities
  }
  contextSnapshot(session: NativeSessionReference) { this.assertSession(session); return this.context }
  appliedSessionPreferences(session: NativeSessionReference) { this.assertSession(session); return this.applied }
  async compactSession(session: NativeSessionReference, input: NativeCompactInput, signal?: AbortSignal) {
    this.assertSession(session)
    await input.onDispatch?.()
    const frame = this.frame({ method: 'conversation.compact', session,
      requestId: input.requestId, correlationId: input.clientCorrelationId })
    const lease = await this.capture(frame)
    try {
      let state = z.object({ compaction: CompactionStateSchema }).parse(await lease.request(signal)).compaction
      while (true) {
        if (state.requestId !== input.requestId || state.nativeSessionId !== session.nativeSessionId) conflict('The worker compact result belongs to another request.')
        await input.onProgress(state)
        if (!['accepted', 'running', 'uncertain'].includes(state.status)) return state
        signal?.throwIfAborted()
        await delay(100, undefined, signal ? { signal } : {})
        state = await this.reconcileCompaction(session, state, signal)
        if (state.status === 'uncertain') return state
      }
    } finally { await this.release(lease) }
  }
  async reconcileCompaction(session: NativeSessionReference, state: CompactionState, signal?: AbortSignal) {
    this.assertSession(session)
    return z.object({ compaction: CompactionStateSchema }).parse(await this.request({
      method: 'conversation.compact-reconcile', session, state }, signal)).compaction
  }
  private compactionReceipt(raw: unknown, session: NativeSessionReference, requestId: string) {
    const { receipt } = z.object({ receipt: WorkerConversationReceiptSchema.optional() }).passthrough().parse(raw)
    if (!receipt || !isDeepStrictEqual(receipt.binding, this.options.binding)
      || !isDeepStrictEqual(receipt.session, session)
      || !receipt.compactions.some(control => control.state.requestId === requestId
        && control.state.nativeSessionId === session.nativeSessionId)) {
      conflict('The persisted Worker compaction owner changed.')
    }
    for (const field of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const) {
      if (receipt.connection[field] !== this.options.channel.binding[field]) conflict('The original Worker authority changed.')
    }
    return receipt
  }
  async readCompaction(session: NativeSessionReference, start: NativeSessionStart, state: CompactionState, signal?: AbortSignal) {
    const fields = this.startFields(start)
    const record = this.compactionReceipt(await this.request({ method: 'conversation.status' }, signal),
      session, state.requestId)
    const result = z.object({ compaction: CompactionStateSchema, receipt: WorkerConversationReceiptSchema }).parse(
      await this.request({ method: 'conversation.compact-read', session, state,
        configuration: fields.configuration, correlationId: fields.operationId }, signal))
    const recovered = this.compactionReceipt(result, session, state.requestId)
    if (recovered.revision < record.revision) conflict('The persisted Worker compaction result is stale.')
    if (result.compaction.requestId !== state.requestId || result.compaction.nativeSessionId !== session.nativeSessionId) {
      conflict('The worker returned another compaction request.')
    }
    this.observedSession = structuredClone(session)
    return result.compaction
  }
  async close(session: NativeSessionReference) {
    this.assertSession(session)
    this.adopt(await this.request({ method: 'conversation.close', session }))
  }
  async closeRetainedSession(session: NativeSessionReference, signal: AbortSignal) {
    const record = this.readReceipt(await this.request({ method: 'conversation.status' }, signal))
    if (!record?.session || !isDeepStrictEqual(record.session, session)) conflict('The persisted worker session changed.')
    if (record.closed) return
    if (record.connection.bootId !== this.options.channel.binding.bootId && !record.runtimeReleased) {
      conflict('The previous Worker session has no confirmed process release.')
    }
    this.adoptReceipt(record)
    const closed = this.adopt(await this.request({ method: 'conversation.close', session }, signal))
    if (!closed?.closed) conflict('Closure of the persisted worker session is unconfirmed.')
  }
  async closeForResume(session: NativeSessionReference) {
    this.assertSession(session)
    this.adopt(await this.request({ method: 'conversation.release-runtime', session }))
    this.runtimeAcquired = false
  }
  async closeForRestart(session: NativeSessionReference) {
    if (this.session || !isDeepStrictEqual(this.observedSession, session)) this.assertSession(session)
    await this.detach()
  }
  requiresSettledDisposal() { return this.options.lifecycle !== 'observer' }
  async dispose() {
    if (this.options.lifecycle === 'observer') {
      await this.detach()
      return
    }
    if ((this.options.lifecycle === 'owner' || this.runtimeAcquired) && !this.lifetime.signal.aborted && this.session
      && !this.receipt?.closed && !this.receipt?.runtimeReleased) {
      this.options.channel = this.currentChannel()
      const lease = this.captureConnected(this.frame({ method: 'conversation.release-runtime', session: this.session }),
        { current: this.options.currentForDisposal ?? this.options.current })
      try { this.adopt(await lease.request()) } finally { await this.release(lease) }
    }
    if (this.preparationActive && !this.session && !this.lifetime.signal.aborted) {
      await this.request({ method: 'conversation.release-preparation' })
      this.preparationActive = false
    }
    await this.detach()
  }
  private async detach() {
    this.lifetime.abort(new DomainError('ENGINE_RESTART', 'Main detached its worker conversation observer.', 503))
    for (const lease of this.leases) await this.release(lease)
    this.recoveredCallbacks.clear()
    this.credentialLease = undefined
  }
}
