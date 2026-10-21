import { logIgnoredError } from '../diagnostics/ignoredError.js'
import type { ReadObservation } from '@foreman-code/contracts'
import { errorMessage } from '../../shared/errorMessage.js'
import { RETIRED_OPENCODE_MESSAGE } from '@foreman-code/contracts'
import type { ChatResponseAcknowledgment } from '@foreman-code/contracts/interaction-activity'
import { withInteractionResponse, isSessionNativeInteraction } from '@foreman-code/contracts'
import { publicOperatorConversation } from './operatorConversationRecord.js'
import { APP_MCP_TOKEN } from '../harnesses/appMcpLauncher.js'
import type { SessionControlRequest } from '@foreman-code/contracts'
import { operatorMessagePrompt } from './operatorMessagePrompt.js'
import { pendingSessionControls, type ChatModelCatalog } from '../harnesses/sessionControlDefaults.js'
import { validateSessionMessage } from './sessionControls/messageAdmission.js'
import type { SessionControlStore } from './sessionControls/store.js'
import { acceptedOperatorResponseControl } from './acceptedResponseControl.js'
import { nativeNonSubmission } from './nativeNonSubmission.js'
import type { OperatorChatCommands } from './operatorChatCommands.js'
import { pendingInteractionAfterHistory } from './pendingInteractionReadback.js'
import { qualifyChatActivity } from './qualifiedActivity.js'
import { reconcileKnownActivities } from './reconcileKnownActivities.js'
import { knownNativeActivity } from './knownNativeActivity.js'
import { committedNativeText } from './committedNativeText.js'
import { activityTextEnvelope } from './activityTextEnvelope.js'
import { nativeInteractionAvailability } from './interactionAvailability.js'
import { commandInputHash } from '../commands/postgres.js'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { access, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import {
  CodexSessionCompatibilitySchema, OperatorConversationStreamEventSchema, SendOperatorMessageRequestSchema,
  type ContextSnapshot, type NativeHarnessEvent, type OperatorActivityQuery, type OperatorConfigurationVersion, type OperatorConversationStreamEvent, type NativeSessionReference,
  type ExecutionResult, type SendOperatorMessageRequest, type RespondOperatorInteractionRequest, type OperatorChatSetup, type OperatorChatSetupQuery,
  type HarnessConfiguration,
} from '@foreman-code/contracts'
import type { HarnessProfileSelection } from '@foreman-code/contracts/harness-registry'
import type { ManagementAction, ManagementPrincipal } from '@foreman-code/contracts/management'
import type { OperatorConversationHistoryQuery } from '@foreman-code/contracts/operator-chat'

import { DomainError } from '../errors.js'
import { harnessSessionChanged } from '../harnesses/providerAccountConfiguration.js'
import { requireAuthorization, isAuthorized } from '../access/policy.js'
import type {
  ChildProcessEnvironment, NativeHarnessSessionManager, NativeHistory, NativeMessageSubmission, NativeSessionStart,
  NativeTerminalObservation,
} from '../harnesses/port.js'
import { NativeDeliveryError } from '../harnesses/errors.js'
import { componentLogger } from '../diagnostics/logger.js'
import { primeInitialNativeStream } from '../harnesses/claudeSdk/initialStream.js'
import type { PostgresOperatorRepository } from '../operators/postgres.js'
import { withFilesystemDeadline } from '../workspaces/filesystem.js'
import { nativeCorrelation, PostgresOperatorConversationRepository, type ConversationRow } from './operatorChatRepository.js'
import { nativePersistenceRedactor } from '../interactions/nativePersistence.js'
import { currentOperatorHistory, operatorActivity } from './operatorActivity.js'
import { completedNativeAssistantMessage } from './operatorText.js'
import { nativeActivityFence } from './nativeActivityFence.js'
import { createNativeTextStream } from './nativeTextStream.js'
import { ignoreError } from '../diagnostics/ignoredError.js'
import { sameOperatorExecutionConfiguration } from './workerExecutionConfiguration.js'

export { PostgresOperatorConversationRepository } from './operatorChatRepository.js'

/** Dedicated native cwd; it is neither a workspace nor an authority scope. */
export async function ensureOperatorRuntimeDirectory(managedRuntimeRoot: string): Promise<string> {
  const root = resolve(managedRuntimeRoot)
  return withFilesystemDeadline(async (check) => {
    await check(() => mkdir(root, { recursive: true }))
    const canonicalRoot = await check(() => realpath(root))
    const candidate = resolve(canonicalRoot, 'operator')
    await check(() => mkdir(candidate, { recursive: true }))
    const canonical = await check(() => realpath(candidate))
    const child = relative(canonicalRoot, canonical)
    if (!child || isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) {
      throw new DomainError('OPERATOR_RUNTIME_DIRECTORY_INVALID', 'The Operator runtime directory must remain inside managed runtime storage.', 422)
    }
    await check(() => access(canonical, constants.R_OK | constants.W_OK | constants.X_OK))
    return canonical
  })
}

export class OperatorConversationEvents {
  private sequence = 0
  private readonly listeners = new Map<string, Set<(event: OperatorConversationStreamEvent) => void>>()
  publish(conversationId: string, type: OperatorConversationStreamEvent['type'], data: Record<string, unknown>) {
    const event = OperatorConversationStreamEventSchema.parse({ id: this.sequence++, conversationId, type, data })
    for (const listener of this.listeners.get(conversationId) ?? []) {
      try { listener(event) } catch (error) { logIgnoredError('engine', 'publish conversation event', error) }
    }
  }
  subscribe(id: string, listener: (event: OperatorConversationStreamEvent) => void) {
    const listeners = this.listeners.get(id) ?? new Set()
    listeners.add(listener); this.listeners.set(id, listeners)
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id) }
  }
}

export interface NativeManagerResolver extends ChatModelCatalog {
  (configuration: OperatorConfigurationVersion, conversationId: string, fileInputs?: boolean): NativeHarnessSessionManager
  prepareAccountBinding?(configuration: OperatorConfigurationVersion, conversationId: string): Promise<void>
  /** Resolve the accepted receipt, not the caller's current route or upload owner. */
  recoverCompaction?(configuration: OperatorConfigurationVersion, conversationId: string,
    session: NativeSessionReference, start: import('../harnesses/port.js').NativeSessionStart,
    state: import('@foreman-code/contracts').CompactionState, principalId: string, signal: AbortSignal):
    Promise<import('@foreman-code/contracts').CompactionState>
  hasFileInputs?(conversationId: string, requestId: string): Promise<boolean>
  /** After durable native acknowledgement, before either file bridge issues authority. */
  recordFileSubmission?(conversationId: string, requestId: string, nativeTurnId: string): Promise<void>
  recordFileMessageSubmission?(conversationId: string, requestId: string, receipt: NativeMessageSubmission): Promise<void>
  /** Close the persisted process owner; absence of a registration is not positive closure. */
  closeRecoveredRuntime?(conversationId: string, signal: AbortSignal): Promise<boolean>
  release?(conversationId: string): void
}
export interface OperatorChatAuthority {
  current(principalId: string): Promise<ManagementPrincipal>
  assertConfiguration(configuration: OperatorConfigurationVersion): void
  setup(manager: NativeHarnessSessionManager, signal: AbortSignal): Promise<OperatorChatSetup>
  /** Installation inspection has read authority and no accepted native turn. */
  setupConfiguration?(principal: ManagementPrincipal, configuration: OperatorConfigurationVersion, signal: AbortSignal): Promise<OperatorChatSetup>
  prepare(manager: NativeHarnessSessionManager, configuration: OperatorConfigurationVersion, conversationId: string,
    principalId: string, signal: AbortSignal): Promise<ChildProcessEnvironment>
  /** Revoke turn authority while retaining a process whose credential channel can be rebound. */
  retireTurn?(conversationId: string, environment: ChildProcessEnvironment): Promise<boolean>
  release(conversationId: string): Promise<void>
}
interface Runtime {
  idleTimer?: ReturnType<typeof setTimeout>
  fileInputs?: boolean
  interactionHandled?: boolean
  configuration?: OperatorConfigurationVersion
  executionConfiguration?: OperatorConfigurationVersion
  manager: NativeHarnessSessionManager
  session?: NativeSessionReference
  creationInput?: NativeSessionStart
  environment?: ChildProcessEnvironment
  disposal?: Promise<void>
  disposalStarted?: boolean
  /** Recovery attachment cannot launch another turn. */
  observationOnly?: boolean
}
const OPERATOR_SESSION_IDLE_MS = 5 * 60_000
interface HistoryContext {
  context?: ContextSnapshot | null
  harness: NativeSessionReference['harness']
  session?: NativeSessionReference | undefined
  configuration?: OperatorConfigurationVersion | undefined
  environment?: ChildProcessEnvironment | undefined
  reconcile?(): Promise<void>
}
function failure(error: unknown): ExecutionResult {
  const provider = error && typeof error === 'object' && 'result' in error
    ? (error as { result?: ExecutionResult }).result?.error : undefined
  return { outcome: 'failed', error: { code: provider?.code ?? (error && typeof error === 'object'
    && 'code' in error && typeof error.code === 'string' ? error.code : 'OPERATOR_SETUP_FAILED'),
    message: provider?.message ?? (errorMessage(error, 'Operator setup failed.')), retryable: true } }
}

/** Only evidence about the attempted prompt, never a later history/approval error. */
function definitePromptRejection(error: unknown): boolean {
  if (error instanceof NativeDeliveryError) {
    return error.operation === 'turn_submission' && error.delivery === 'not_sent'
  }
  if (!error || typeof error !== 'object') return false
  if ('certainty' in error) return error.certainty === 'definite'
  // Codex's RPC contract predates NativeDeliveryCertainty. A rejected read or
  // interrupt is not evidence that turn/start was rejected.
  return 'method' in error && error.method === 'turn/start'
    && 'uncertain' in error && error.uncertain === false
}
function definiteCreationFailure(error: unknown): boolean {
  if (error instanceof NativeDeliveryError) {
    return error.operation === 'session_creation' && error.delivery === 'not_sent'
  }
  if (!error || typeof error !== 'object') return false
  if ('certainty' in error) return error.certainty === 'definite'
  return false
}

export class OperatorChatService {
  private readonly activityObservations = new Map<string, ReadObservation>()
  readonly events = new OperatorConversationEvents()
  private readonly runtimes = new Map<string, Runtime>()
  private readonly tasks = new Map<string, { requestId: string; controller: AbortController; promise: Promise<void> }>()
  private readonly accepting = new Set<Promise<unknown>>()
  private readonly acceptanceControllers = new Set<AbortController>()
  private readonly controls = new Map<string, Promise<unknown>>()
  private readonly responding = new Set<string>()
  private readonly lifetime = new AbortController()
  private reconciliation: Promise<void> | undefined
  private closing = false
  private shutdownTask: Promise<void> | undefined
  private sessionControlsStore: SessionControlStore | undefined
  private sessionControls() { return this.sessionControlsStore ??= this.repository.createSessionControls() }

  private commandReceipts: OperatorChatCommands | undefined
  private setupCheck: { configurationId: string; promise: Promise<OperatorChatSetup> } | undefined

  constructor(
    private readonly repository: PostgresOperatorConversationRepository,
    private readonly operators: PostgresOperatorRepository,
    private readonly managers: NativeManagerResolver,
    private readonly workingDirectory: string,
    private readonly authority: OperatorChatAuthority,
    private readonly prepareAccountProfile?: (principal: ManagementPrincipal, configuration: HarnessConfiguration,
      commandId: string) => Promise<HarnessProfileSelection | undefined>,
  ) {}

  private receipts() { return this.commandReceipts ??= this.repository.createControlCommands() }
  private async controlRead(id: string, principal: ManagementPrincipal, action: 'operator_chat:cancel' | 'operator_chat:respond') {
    await this.assertAccess(id, principal, action)
    return this.get(id, principal)
  }

  private control<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.controls.get(id) ?? Promise.resolve()
    const next = previous.catch(() => { /* ignore: the previous caller receives its failure; the queue must still admit the next operation. */ }).then(operation)
    this.controls.set(id, next)
    void next.finally(() => { if (this.controls.get(id) === next) this.controls.delete(id) }).catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })
    return next
  }
  private assertOpen(): void {
    if (this.closing) throw new DomainError('OPERATOR_CHAT_CLOSING', 'Operator chat is shutting down.', 503)
  }
  private validate(configuration: OperatorConfigurationVersion): void {
    if (configuration.harness.harness === 'opencode') {
      throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
    }
    if (configuration.harness.harness === 'codex') {
      CodexSessionCompatibilitySchema.parse({ configuration: configuration.harness, requiresResume: true })
    }
    this.authority.assertConfiguration(configuration)
  }
  async setup(principal: ManagementPrincipal, input: OperatorChatSetupQuery = {}): Promise<OperatorChatSetup> {
    this.assertOpen(); requireAuthorization(principal, 'harnesses:read')
    const row = input.conversationId ? await this.assertAccess(input.conversationId, principal) : undefined
    const accepted = row && input.requestId ? await this.repository.acceptedConfiguration(row.id, input.requestId) : undefined
    let configuration = accepted ?? (input.configurationVersionId
      ? await this.repository.configurationForInspection(input.configurationVersionId, principal) : undefined)
    if (input.configurationVersionId && !configuration) throw new DomainError('OPERATOR_CONFIGURATION_NOT_FOUND', 'The pending command configuration is unavailable.', 409)
    // Legacy pending payloads did not include a pin. Prefer their matching idle
    // conversation configuration, never a different current harness's defaults.
    if (!configuration && row && (!input.harness || input.harness === row.harness)) {
      configuration = await this.repository.configuration(row.operator_configuration_version_id)
    }
    // Before admission, a cross-harness command pins its source conversation
    // and the reviewed destination defaults. A persisted receipt wins above.
    if (!accepted && configuration && row && input.requestId && input.harness && configuration.harness.harness !== input.harness) {
      if (input.expectedDefaultsRevision === undefined || input.configurationVersionId !== row.operator_configuration_version_id) throw new DomainError(
        'OPERATOR_CONFIGURATION_CONFLICT', 'The pending harness change no longer matches its reviewed source configuration.', 409)
      configuration = await this.operators.inspectionConfiguration(input.expectedDefaultsRevision)
    }
    configuration ??= await this.operators.inspectionConfiguration(input.expectedDefaultsRevision)
    if ((input.harness && configuration.harness.harness !== input.harness)
      || (row && configuration.operatorId !== 'application-operator')) {
      throw new DomainError('OPERATOR_CONFIGURATION_CONFLICT', 'The requested message configuration does not match its Operator harness.', 409)
    }
    const selected = configuration
    if (selected.harness.harness === 'opencode') {
      throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
    }
    const configurationId = `${principal.id}:${selected.id}:${selected.contentHash}`
    if (this.setupCheck?.configurationId === configurationId) return this.setupCheck.promise
    const check = (async () => {
      const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)])
      if (selected.harness.harness === 'claude') {
        if (!this.authority.setupConfiguration) throw new DomainError('OPERATOR_SETUP_INSPECTION_UNAVAILABLE',
          'Claude installation inspection is unavailable.', 503)
        const result = await this.authority.setupConfiguration(principal, selected, signal)
        return { ...result, ...(selected.id === 'application-operator-inspection' ? {} : { configurationVersionId: selected.id }) }
      }
      const id = `operator-setup:${randomUUID()}`
      const manager = this.managers(selected, id)
      try {
        const result = await this.authority.setup(manager, signal)
        return { ...result, ...(selected.id === 'application-operator-inspection' ? {} : { configurationVersionId: selected.id }) }
      } finally { try { await manager.dispose?.() } finally { this.managers.release?.(id) } }
    })()
    this.setupCheck = { configurationId, promise: check }
    this.accepting.add(check)
    void check.finally(() => { if (this.setupCheck?.promise === check) this.setupCheck = undefined; this.accepting.delete(check) }).catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })
    return check
  }
  async assertAccess(id: string, principal: ManagementPrincipal, action: ManagementAction = 'operator_chat:read', includeDeleted = false) {
    requireAuthorization(principal, action)
    requireAuthorization(await this.authority.current(principal.id), action)
    const row = await this.repository.active(id)
    if (!row || (!includeDeleted && row.deleted_at) || row.owner_principal_id !== principal.id) {
      throw new DomainError('CONVERSATION_NOT_FOUND', 'Conversation was not found.', 404)
    }
    return row
  }
  async create(principal: ManagementPrincipal, title?: string, command?: { commandId: string; source: 'http' | 'mcp' }) {
    this.assertOpen()
    requireAuthorization(principal, 'operator_chat:write')
    requireAuthorization(await this.authority.current(principal.id), 'operator_chat:write')
    if (command) {
      return this.repository.createCommand(principal, { ...command, title }, async (client) => {
        this.assertOpen()
        return this.operators.ensure(client)
      })
    }
    const { operator, configuration } = await this.operators.ensure()
    this.assertOpen()
    return this.repository.create(operator.id, configuration, principal.id, title)
  }
  async setDeleted(id: string, principal: ManagementPrincipal, deleted: boolean,
    command?: { commandId: string; source: 'http' | 'mcp' }) {
    this.assertOpen()
    return this.control(id, async () => {
      const row = await this.assertAccess(id, principal, 'operator_chat:write', true)
      const result = await this.repository.setDeleted(id, row.owner_principal_id!, deleted,
        command ? { ...command, principal } : undefined)
      if (deleted && (await this.repository.active(id))?.deleted_at) await this.release(id)
      return result
    })
  }
  async list(principal: ManagementPrincipal) {
    requireAuthorization(principal, 'operator_chat:read')
    requireAuthorization(await this.authority.current(principal.id), 'operator_chat:read')
    const conversations = await this.repository.list(principal.id)
    requireAuthorization(await this.authority.current(principal.id), 'operator_chat:read')
    return conversations
  }
  summaries(principal: ManagementPrincipal, limit?: number, attentionOnly = false) {
    requireAuthorization(principal, 'operator_chat:read')
    return this.repository.summaries(principal.id, limit, attentionOnly)
  }
  async get(id: string, principal: ManagementPrincipal) {
    await this.assertAccess(id, principal)
    let state = await this.repository.getWithActivity(id)
    if (!state) throw new DomainError('CONVERSATION_NOT_FOUND', 'Conversation was not found.', 404)
    const current = await this.authority.current(principal.id)
    requireAuthorization(current, 'operator_chat:read')
    const runtime = this.runtimes.get(id)
    if (!state.activeRequestId && !state.pendingInteraction && runtime?.session && !runtime.disposal) {
      const pending = await runtime.manager.pending(runtime.session)
      if (pending && isSessionNativeInteraction(pending)) {
        await this.repository.pending(id, null, pending)
        state = await this.repository.getWithActivity(id)
        if (!state) throw new DomainError('CONVERSATION_NOT_FOUND', 'Conversation was not found.', 404)
      }
    }
    const responseAvailability = state.pendingInteraction ? await nativeInteractionAvailability(state.pendingInteraction,
      isAuthorized(current, 'operator_chat:respond'), runtime?.session ? { manager: runtime.manager, session: runtime.session } : undefined,
      { signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(5_000)]),
        isCurrent: () => this.runtimes.get(id) === runtime && !!runtime?.session && !runtime.disposal && !this.closing }) : undefined
    const finalPrincipal = await this.authority.current(principal.id)
    requireAuthorization(finalPrincipal, 'operator_chat:read')
    const qualifiedResponse = responseAvailability && !isAuthorized(finalPrincipal, 'operator_chat:respond')
      ? { ...responseAvailability, available: false, status: 'unavailable' as const, path: null,
        reason: 'unauthorized' as const, message: 'Your current grants do not allow responding to this interaction.' } : responseAvailability
    const activitySnapshot = { ...qualifyChatActivity(state.activitySnapshot, qualifiedResponse),
      ...(this.activityObservations.has(id) ? { observation: this.activityObservations.get(id) } : {}) }
    return { ...state, activitySnapshot, ...(qualifiedResponse ? { responseAvailability: qualifiedResponse } : {}),
      qualificationKey: commandInputHash({ principal: finalPrincipal, revision: state.revision, sourceRevisions: state.activitySnapshot.sourceRevisions,
        responseAvailability: qualifiedResponse ?? null }).slice(7) }
  }

  private async sessionControlBinding(id: string, principal: ManagementPrincipal, write = false) {
    const row = await this.assertAccess(id, principal, write ? 'operator_chat:write' : 'operator_chat:read')
    await this.assertAccess(id, principal)
    const configuration = await this.repository.configuration(row.operator_configuration_version_id)
    if (!configuration) throw new DomainError('OPERATOR_CONFIGURATION_NOT_FOUND', 'Conversation configuration is unavailable.', 409)
    const busy = !!row.active_request_id || !!row.pending_interaction
    const fileInputs = this.runtimes.get(id)?.fileInputs
      ?? (write && row.fork_request_id && this.managers.hasFileInputs
        ? await this.managers.hasFileInputs(id, row.fork_request_id) : false)
    const runtime = write && !busy && row.native_session_id
      ? await this.runtime(id, row, configuration, this.lifetime.signal, fileInputs, principal.id)
      : this.runtimes.get(id)
    const session = runtime?.session ?? (row.native_session_id ? {
      harness: configuration.harness.harness, providerVersion: row.provider_version ?? 'unknown',
      nativeSessionId: row.native_session_id,
    } : undefined)
    return { conversationId: id, principalId: principal.id, defaultSubject: 'application-operator', profileKey: configuration.contentHash,
      busyReason: row.active_request_id || row.pending_interaction ? 'Wait for the active turn and its approvals to finish.' : null,
      session,
      get manager() {
        return runtime && !runtime.disposal && !runtime.disposalStarted ? runtime.manager : undefined
      },
      ...(session && this.managers.recoverCompaction ? { recoverCompaction: (state: import('@foreman-code/contracts').CompactionState) =>
        this.managers.recoverCompaction!(configuration, id, session, { kind: 'operator',
          correlationId: `session-control:${id}`, configuration, workingDirectory: this.workingDirectory },
        state, principal.id, this.lifetime.signal) } : {}), pendingCapabilities: pendingSessionControls(configuration.harness,
        !session ? await this.managers.modelOptions?.(configuration.harness) : undefined) }
  }

  async readSessionControls(id: string, principal: ManagementPrincipal) {
    return this.sessionControls().read(await this.sessionControlBinding(id, principal))
  }

  async changeSessionControls(id: string, input: SessionControlRequest, principal: ManagementPrincipal,
    source: 'http' | 'mcp' = 'http') {
    this.assertOpen()
    return this.control(id, () => this.sessionControls().execute(principal, source, input,
      async () => {
        if (input.kind === 'save-default') requireAuthorization(await this.authority.current(principal.id), 'settings:update')
        return this.sessionControlBinding(id, principal, true)
      }, this.lifetime.signal))
  }

  async history(id: string, principal: ManagementPrincipal, query: Partial<OperatorConversationHistoryQuery> = {}) {
    // Read-only recovery uses the same owner boundary as the live transcript.
    // A recovered request ID is never submitted or approved by this endpoint.
    await this.assertAccess(id, principal)
    const page = await this.repository.history(id, query)
    if (!page) throw new DomainError('CONVERSATION_NOT_FOUND', 'Conversation was not found.', 404)
    requireAuthorization(await this.authority.current(principal.id), 'operator_chat:read')
    return page
  }

  async handoffHistory(principal: ManagementPrincipal, sourceConversationId?: string, before?: string) {
    this.assertOpen(); requireAuthorization(principal, 'operator_handoff:read')
    return this.repository.handoffHistory(principal.id, sourceConversationId, before)
  }

  async activityPage(id: string, principal: ManagementPrincipal, input: Partial<OperatorActivityQuery>) {
    await this.assertAccess(id, principal)
    const { activities, nextCursor } = await this.repository.activity.page(id, input)
    requireAuthorization(await this.authority.current(principal.id), 'operator_chat:read')
    return { activities, nextCursor }
  }

  private historyContext(id: string, requestId: string, runtime: Runtime): HistoryContext {
    return { harness: runtime.manager.harness, session: runtime.session, configuration: runtime.configuration,
      context: runtime.session ? runtime.manager.contextSnapshot?.(runtime.session) ?? null : null,
      environment: runtime.environment, reconcile: () => this.control(id, () => this.observe(id, requestId, runtime)) }
  }
  private async recordActivity(id: string, requestId: string, runtime: HistoryContext, event: NativeHarnessEvent, nativeTurnId: string | null, authoritativeReconciliation = false, nativeSubmission?: NativeMessageSubmission) {
    const context = runtime.context ?? null
    if (context) {
      const snapshot = structuredClone(context)
      void this.control(id, () => this.sessionControls().observeContext(id, snapshot, runtime.configuration?.contentHash ?? '')).catch(error => {
        this.events.publish(id, 'error', { message: errorMessage(error, 'Context usage could not be saved.') })
      })
    }
    const redact = nativePersistenceRedactor(Object.values(runtime.environment?.variables ?? {}))
    const known = knownNativeActivity(event, runtime.harness)
    if (known && (known.native.sessionId !== runtime.session?.nativeSessionId
      || known.native.turnId !== nativeTurnId)) {
      const settled = await this.repository.activity.settleKnownByNative(id, known.change, known.native, redact)
      if (settled) this.events.publish(id, 'activity', settled)
      return
    }
    const change = operatorActivity(event, runtime.harness, requestId)
    if (!change) return
    const showThinking = runtime.configuration?.showThinking === true
    if (change.kind === 'thinking' && !showThinking) return
    const safe = redact.value(change)
    if (!runtime.session || !nativeTurnId && !nativeSubmission) {
      this.events.publish(id, 'state', { requestId, snapshotRequired: true })
      void runtime.reconcile?.().catch(ignoreError('harness', 'reconcile native runtime', { chatId: id, requestId }))
      return
    }
    const accepted = await this.repository.activity.append(id, requestId, safe, {
      ...nativeActivityFence(runtime.session, nativeTurnId, event, authoritativeReconciliation, nativeSubmission),
      onReconciliationRequired: () => {
        this.events.publish(id, 'state', { requestId, snapshotRequired: true })
        void runtime.reconcile?.().catch(ignoreError('harness', 'reconcile native runtime', { chatId: id, requestId }))
      },
    })
    if (accepted) this.events.publish(id, 'activity', accepted)
  }
  private async recordAssistantMessage(id: string, requestId: string, runtime: HistoryContext, event: NativeHarnessEvent, precedingActivityId?: string | null) {
    const message = completedNativeAssistantMessage(event, runtime.harness)
    if (!message) return true
    const text = nativePersistenceRedactor(Object.values(runtime.environment?.variables ?? {})).text(message.text)
    if (await this.repository.appendAssistantMessage(id, requestId, message.id, text,
      message.parentMessageId || message.truncation ? {
        ...(message.parentMessageId ? { parentMessageId: message.parentMessageId } : {}),
        ...(message.truncation ? { truncation: message.truncation } : {}), complete: message.complete === true,
      } : undefined,
      precedingActivityId)) {
      this.events.publish(id, 'message', { requestId, nativeMessageId: message.id })
      return true
    }
    return false
  }

  send(id: string, value: SendOperatorMessageRequest, principal: ManagementPrincipal) {
    this.assertOpen()
    const controller = new AbortController()
    this.acceptanceControllers.add(controller)
    const promise = this.accept(id, value, principal, controller).finally(() => {
      this.accepting.delete(promise); this.acceptanceControllers.delete(controller)
    })
    this.accepting.add(promise)
    return promise
  }
  private async accept(id: string, value: SendOperatorMessageRequest, principal: ManagementPrincipal, controller: AbortController) {
    const input = SendOperatorMessageRequestSchema.parse(value)
    requireAuthorization(principal, 'operator_chat:read')
    const row = await this.assertAccess(id, principal, 'operator_chat:write')
    requireAuthorization(await this.authority.current(principal.id), 'operator_chat:read')
    // Resolve receipts before reading mutable defaults or validating a native
    // installation. A recovered receipt is not a request for a new native turn.
    const sourceReceipt = await this.repository.hasTurn(id, input.requestId)
    const childId = `operator-fork:${input.requestId}`
    const child = sourceReceipt ? undefined : await this.repository.active(childId)
    const childReceipt = child?.parent_conversation_id === id && child.owner_principal_id === row.owner_principal_id
      && child.fork_request_id === input.requestId && await this.repository.hasTurn(childId, input.requestId)
    const receiptId = sourceReceipt ? id : childReceipt ? childId : undefined
    if (input.recovery === 'receipt') {
      if (!receiptId) throw new DomainError('OPERATOR_RECEIPT_NOT_FOUND', 'No receipt is currently visible for this command.', 404)
      // This branch cannot call validate, setup, prepare, or runTurn, even for
      // a retryable receipt. A missing receipt is not evidence of non-delivery.
      return this.control(receiptId, async () => {
        const current = await this.authority.current(principal.id)
        requireAuthorization(current, 'operator_chat:write')
        requireAuthorization(current, 'operator_chat:read')
        const begun = await this.repository.beginTurn(receiptId, input, row.owner_principal_id!, undefined, undefined, true)
        requireAuthorization(await this.authority.current(principal.id), 'operator_chat:read')
        return begun
      })
    }
    if (publicOperatorConversation(row.record).status === 'archived') {
      throw new DomainError('CONVERSATION_ARCHIVED', 'This conversation is read-only.', 409)
    }
    if (!receiptId) validateSessionMessage(input.content, input.sessionMode)
    const configuration = receiptId ? undefined : await this.repository.configuration(row.operator_configuration_version_id)
    if (!receiptId && !configuration) throw new DomainError('OPERATOR_CONFIGURATION_NOT_FOUND', 'Pinned Operator configuration was not found.', 409)
    const harness = configuration ? await this.repository.harnessForMessage(configuration, input) : undefined
    let preparedProfile: HarnessProfileSelection | undefined
    if (harness?.harness === 'claude' && configuration && harnessSessionChanged(configuration.harness, harness)) {
      if (!this.prepareAccountProfile) throw new DomainError('HARNESS_PROFILE_SELECTION_UNAVAILABLE',
        'Claude account selection requires a checked local harness profile.', 503)
      preparedProfile = await this.prepareAccountProfile(principal, harness, input.requestId)
      if (!preparedProfile) throw new DomainError('HARNESS_PROFILE_UNAVAILABLE',
        'Check the selected Claude account profile before sending this message.', 409)
    }
    const fork = Boolean(harness && configuration && harnessSessionChanged(configuration.harness, harness)
      && await this.repository.hasMessages(id))
    const admit = () => this.control(id, async () => {
      this.assertOpen(); controller.signal.throwIfAborted()
      const current = await this.authority.current(row.owner_principal_id!)
      requireAuthorization(current, 'operator_chat:write')
      requireAuthorization(current, 'operator_chat:read')
      if (!receiptId) await this.sessionControls().assertSendAllowed(id)
      const begun = receiptId
        ? await this.repository.beginTurn(receiptId, input, row.owner_principal_id!, undefined, undefined, false,
            (accepted) => this.validate(accepted))
        : fork
          ? await this.repository.beginForkTurn(id, input, row.owner_principal_id!, harness!, configuration!.id,
              (accepted) => this.validate(accepted), preparedProfile)
          : await this.repository.beginTurn(id, input, row.owner_principal_id!, input.settings ? harness : undefined,
              configuration!.id, false, (accepted) => this.validate(accepted), preparedProfile)
      if (begun.replayed) {
        requireAuthorization(await this.authority.current(principal.id), 'operator_chat:read')
        return begun
      }
      const targetId = begun.state.conversation.id
      const acceptedId = begun.state.conversation.operatorConfigurationVersionId!
      let accepted: OperatorConfigurationVersion
      try {
        requireAuthorization(await this.authority.current(principal.id), 'operator_chat:read')
        const saved = await this.repository.configuration(acceptedId)
        if (!saved) throw new Error('Accepted Operator configuration disappeared.')
        accepted = saved
        this.validate(accepted)
        if (targetId !== id) await this.release(id)
        const resident = this.runtimes.get(targetId)
        if (resident) {
          this.clearIdleTimer(resident)
          if (!resident.configuration || !sameOperatorExecutionConfiguration(resident.configuration, accepted)) {
            await this.release(targetId)
          }
        }
        if (this.closing || controller.signal.aborted) throw new Error('Operator chat stopped before native submission.')
        requireAuthorization(await this.authority.current(principal.id), 'operator_chat:read')
      } catch (error) {
        await this.repository.finish(targetId, input.requestId, failure(error), undefined, true)
        throw error
      }
      const taskController = new AbortController()
      const promise = this.runTurn(targetId, input, accepted, row.owner_principal_id!, taskController.signal)
        .finally(() => { if (this.tasks.get(targetId)?.promise === promise) this.tasks.delete(targetId) })
      this.tasks.set(targetId, { requestId: input.requestId, controller: taskController, promise })
      void promise.catch(ignoreError('harness', 'finish operator turn', { chatId: targetId, requestId: input.requestId }))
      return begun
    })
    return fork || childReceipt ? this.control(childId, admit) : admit()
  }

  private async runtime(id: string, row: ConversationRow, configuration: OperatorConfigurationVersion, signal: AbortSignal,
    fileInputs: boolean, controlPrincipalId?: string): Promise<Runtime> {
    signal.throwIfAborted()
    const resident = this.runtimes.get(id)
    if (resident && (resident.observationOnly || resident.disposalStarted || resident.disposal
      || Boolean(resident.fileInputs) !== fileInputs)) await this.release(id)
    const existing = this.runtimes.get(id)
    if (controlPrincipalId) existing?.manager.setSessionControlPrincipal?.(controlPrincipalId)
    const fileOnly = fileInputs && configuration.harness.harness === 'claude'
    if (existing?.session) {
      const environment = await this.authority.prepare(existing.manager, configuration, id, row.owner_principal_id!, signal)
      if (commandInputHash(environment) !== commandInputHash(existing.environment)) {
        if (!existing.manager.rebindApplicationAccess) {
          throw new DomainError('OPERATOR_ENVIRONMENT_CHANGED', 'The retained native process requires a fresh credential channel.', 409)
        }
        await existing.manager.rebindApplicationAccess(existing.session, { kind: 'operator',
          configuration: existing.executionConfiguration ?? configuration,
          correlationId: nativeCorrelation(id, row.active_request_id!), workingDirectory: this.workingDirectory, environment }, signal)
      }
      existing.environment = environment
      existing.configuration = configuration; return existing
    }
    if (!existing) await this.managers.prepareAccountBinding?.(configuration, id)
    const runtime: Runtime = existing ?? { manager: this.managers(configuration, id, fileInputs), fileInputs }
    runtime.configuration = configuration
    runtime.executionConfiguration = configuration
    if (controlPrincipalId) runtime.manager.setSessionControlPrincipal?.(controlPrincipalId)
    if (!runtime.environment) {
      const preferences = await this.sessionControls().preferences(id)
      if (preferences) await runtime.manager.configureSessionPreferences?.(preferences)
    }
    this.runtimes.set(id, runtime) // Includes managers still starting; shutdown must see them.
    // Claude's file runtime has separate credential delivery composition.
    if (fileOnly) await this.authority.release(id)
    const environment = fileOnly ? { agentId: configuration.operatorId, variables: {} }
      : await this.authority.prepare(runtime.manager, configuration, id, row.owner_principal_id!, signal)
    runtime.environment = environment
    signal.throwIfAborted(); this.assertOpen()
    if (row.native_session_id) {
      runtime.session = await runtime.manager.attachSession({ harness: row.harness,
        providerVersion: row.provider_version ?? 'unknown', nativeSessionId: row.native_session_id }, {
        kind: 'operator', correlationId: nativeCorrelation(id, row.active_request_id ?? 'session-control'), configuration,
        workingDirectory: this.workingDirectory, environment,
        ...(row.active_native_turn_id ? { nativeTurnId: row.active_native_turn_id } : {}),
      }, signal)
    }
    return runtime
  }

  /** No setup check, delegated credential issuance, new session, or new prompt. */
  private async observationRuntime(id: string, row: ConversationRow, configuration: OperatorConfigurationVersion,
    signal: AbortSignal): Promise<Runtime> {
    signal.throwIfAborted()
    const resident = this.runtimes.get(id)
    if (resident?.session) { resident.configuration = configuration; return resident }
    return this.cleanupRuntime(id, row, configuration, signal)
  }

  /** Existing owned work can be inspected/stopped without authority to launch new work. */
  private async cleanupRuntime(id: string, row: ConversationRow, configuration: OperatorConfigurationVersion,
    signal: AbortSignal): Promise<Runtime> {
    if (!row.native_session_id || !row.active_request_id) throw new Error('Cleanup requires a durable native session and request.')
    const fileInputs = await this.managers.hasFileInputs?.(id, row.active_request_id) ?? false
    if (this.runtimes.has(id) && !this.runtimes.get(id)?.session) {
      // A failed credentialed attach may have left a bound manager. Dispose that
      // context before a cleanup-only attach; the durable request stays fenced.
      await this.release(id)
    }
    if (!this.runtimes.has(id)) await this.managers.prepareAccountBinding?.(configuration, id)
    const runtime: Runtime = this.runtimes.get(id) ?? { manager: this.managers(configuration, id, fileInputs), fileInputs }
    this.runtimes.set(id, runtime)
    if (!runtime.session) {
      const attach = runtime.manager.attachSession.bind(runtime.manager)
      runtime.session = await attach({ harness: row.harness,
        providerVersion: row.provider_version ?? 'unknown', nativeSessionId: row.native_session_id }, {
        kind: 'operator', correlationId: nativeCorrelation(id, row.active_request_id), configuration,
        observationOnly: true,
        workingDirectory: this.workingDirectory,
        // Required native environment references still need a value on attach.
        // This is deliberately NOT an issued credential: the App rejects it.
        // Do not mint fresh owner authority merely to inspect/stop old work.
        environment: { agentId: configuration.operatorId,
          variables: fileInputs && configuration.harness.harness === 'claude'
            ? {} : { [APP_MCP_TOKEN]: 'operator-cleanup-disabled' } },
        ...(row.active_native_turn_id ? { nativeTurnId: row.active_native_turn_id } : {}),
      }, signal)
    }
    runtime.configuration = configuration
    // Recovery must reacquire live launch authority before another turn.
    runtime.observationOnly = true
    runtime.manager.stopAutomaticResponses?.(runtime.session)
    return runtime
  }

  /** The tracked control queue owns cancellation delivery after the submission callback returns. */
  private deliverRequestedCancellation(id: string, requestId: string, runtime: Runtime) {
    void this.control(id, async () => {
      const current = await this.repository.active(id)
      if (!current || current.active_request_id !== requestId || !current.cancel_requested) return
      try {
        await this.interrupt(id, current, runtime)
        await this.observe(id, requestId, runtime, AbortSignal.timeout(5_000))
      } catch (error) {
        await this.repository.uncertain(id, requestId,
          errorMessage(error, 'Cancellation delivery is uncertain.'))
        this.events.publish(id, 'error', { requestId, turnState: 'uncertain' })
      } finally {
        // Native completion was checked above. Detach a silent SSE reader
        // so an unproven result remains recoverable by durable reconciliation.
        const task = this.tasks.get(id)
        if (task && task.requestId === requestId) task.controller.abort()
      }
    }).catch(ignoreError('harness', 'deliver cancellation to native turn', { chatId: id, requestId })) // Persistence failure leaves the accepted request fenced.
  }

  private async runTurn(id: string, input: SendOperatorMessageRequest, configuration: OperatorConfigurationVersion, ownerId: string, signal: AbortSignal) {
    let creating = false
    let submitting = false
    let submitted = false
    let initialStream: Awaited<ReturnType<typeof primeInitialNativeStream>> | undefined
    let nativeSubmission: NativeMessageSubmission | undefined
    let textStream: ReturnType<typeof createNativeTextStream> | undefined
    try {
      let row = await this.repository.active(id)
      if (!row || row.active_request_id !== input.requestId) return
      const initialPrompt = publicOperatorConversation(row.record).initialPrompt?.value.text
      const initialPromptText = initialPrompt && !await this.repository.hasNativeSubmission(id) ? initialPrompt : ''
      const messagePrompt = (handoffContext: string | null) => operatorMessagePrompt(input, initialPromptText, handoffContext)
      const fileInputs = Boolean(input.attachments?.length)
      const admittedFiles = await this.managers.hasFileInputs?.(id, input.requestId) ?? false
      if (fileInputs !== admittedFiles || fileInputs && !this.managers.recordFileSubmission) throw new DomainError(
        'OPERATOR_FILE_DELIVERY_UNAVAILABLE', 'The accepted Operator attachments have no native delivery binding.', 409)
      await this.sessionControls().read({ conversationId: id, principalId: ownerId,
        defaultSubject: 'application-operator', profileKey: configuration.contentHash,
        ...(input.sessionMode ? { initialMode: input.sessionMode } : {}), busyReason: null })
      const runtime = await this.runtime(id, row, configuration, signal, fileInputs)
      const onTerminal = async (observation: NativeTerminalObservation) => {
        submitted = true
        if (!await this.journalTerminal(id, input.requestId, observation.result, {
          submission: observation.submission,
          ...(observation.nativeMessageId ? { nativeMessageId: observation.nativeMessageId } : {}),
          retryable: false, requiresRuntimeClosure: true,
          ...(observation.history ? { history: observation.history } : {}),
        })) throw new Error('Native terminal ownership was lost.')
      }
      if (!runtime.session) {
        if (!await this.repository.phase(id, input.requestId, 'creating')) {
          await this.control(id, () => this.complete(id, input.requestId, { outcome: 'canceled' })); return
        }
        const environment = runtime.environment
        if (!environment || row.owner_principal_id !== ownerId) throw new Error('Operator launch authority is unavailable.')
        signal.throwIfAborted(); this.assertOpen()
        creating = true
        const start = { kind: 'operator' as const, correlationId: nativeCorrelation(id, input.requestId),
          configuration, workingDirectory: this.workingDirectory, environment }
        runtime.creationInput = structuredClone(start)
        if (runtime.manager.startInitialTurn) {
          requireAuthorization(await this.authority.current(ownerId), 'operator_chat:write')
          const initialHandoff = Boolean(row.handoff_context)
          if (!await this.repository.phase(id, input.requestId, 'submitting', initialHandoff)) {
            await this.control(id, () => this.complete(id, input.requestId, { outcome: 'canceled' })); return
          }
          if (runtime.fileInputs && !this.managers.recordFileMessageSubmission) throw new DomainError('OPERATOR_FILE_MESSAGE_BINDING_REQUIRED', 'The file bridge requires an observed native message receipt.', 409)
          submitting = true
          initialStream = await primeInitialNativeStream(runtime.manager.startInitialTurn(start, {
            ...await this.sessionControls().turnSettings(id, {
              requestId: input.requestId, nativeSessionId: null,
            }, input.sessionMode),
            prompt: messagePrompt(initialHandoff ? row.handoff_context : null),
            clientCorrelationId: start.correlationId,
            onTerminal,
            onSessionObserved: async (observed) => {
              await this.control(id, async () => {
                const current = await this.repository.active(id)
                if (!current || current.active_request_id !== input.requestId || current.owner_principal_id !== ownerId) throw new Error('Initial session ownership was lost.')
                requireAuthorization(await this.authority.current(ownerId), 'operator_chat:write')
                runtime.session = observed // Keep known identity even if its durable binding fails.
                await this.repository.bind(id, input.requestId, observed.providerVersion, observed.nativeSessionId)
              })
            },
            onMessageSubmitted: async (receipt) => {
              submitted = true
              await this.control(id, async () => {
                if (!runtime.session || receipt.nativeSessionId !== runtime.session.nativeSessionId
                  || receipt.clientCorrelationId !== start.correlationId || !await this.repository.submittedMessage(id, input.requestId, receipt)) throw new Error('Initial message ownership was lost.')
                nativeSubmission = receipt
                if (runtime.fileInputs) await this.managers.recordFileMessageSubmission!(id, input.requestId, receipt)
              })
            },
          }, signal))
          if (!runtime.session) throw new Error('Initial input has no observed native session.')
        } else runtime.session = await runtime.manager.createSession(start, signal)
        // Save the returned identity even when cancellation arrived during creation.
        if (!initialStream) await this.repository.bind(id, input.requestId, runtime.session.providerVersion, runtime.session.nativeSessionId)
        creating = false
      }
      signal.throwIfAborted(); this.assertOpen()
      row = await this.repository.active(id)
      if (!row || row.active_request_id !== input.requestId) { await this.release(id); return }
      requireAuthorization(await this.authority.current(ownerId), 'operator_chat:write')
      signal.throwIfAborted(); this.assertOpen()
      const includeHandoff = Boolean(row.handoff_context
        && !await this.repository.handoffInitialized(id, runtime.session.nativeSessionId))
      if (!initialStream && !await this.repository.phase(id, input.requestId, 'submitting', includeHandoff)) {
        await this.control(id, () => this.complete(id, input.requestId, { outcome: 'canceled' })); return
      }
      signal.throwIfAborted(); this.assertOpen()
      submitting = true
      const correlationId = nativeCorrelation(id, input.requestId)
      let submittedTurnId = row.active_native_turn_id
      const textOwner = () => ({ scope: { kind: 'operator_chat' as const, conversationId: id },
        requestId: input.requestId, sessionId: runtime.session!.nativeSessionId,
        ...(submittedTurnId ? { turnId: submittedTurnId } : {}) })
      const redactText = nativePersistenceRedactor(Object.values(runtime.environment?.variables ?? {}))
      const committed = committedNativeText({ id, requestId: input.requestId, repository: this.repository,
        harness: runtime.manager.harness, session: runtime.session, owner: textOwner, sanitize: (operation) => redactText.value(operation),
        reconcile: () => { void this.control(id, () => this.observe(id, input.requestId, runtime))
          .catch(ignoreError('harness', 'observe native turn after reconcile request', { chatId: id, requestId: input.requestId })) } })
      textStream = createNativeTextStream({
        signal, harness: runtime.manager.harness,
        owner: textOwner,
        publish: (operation) => {
          // Raw reasoning is never promoted to a public assistant answer; safe summaries use activity records.
          if (operation.identity.channel !== 'assistant') return
          this.events.publish(id, 'delta', { requestId: input.requestId, activityChange: activityTextEnvelope(redactText.value(operation), runtime.manager.harness),
            ...(committed.revision() ? { scopeRevision: committed.revision() } : {}) })
        },
        reconcile: () => this.events.publish(id, 'state', { requestId: input.requestId, snapshotRequired: true }),
      })
      for await (const event_ of initialStream?.output ?? runtime.manager.startTurn(runtime.session, {
        ...await this.sessionControls().turnSettings(id, {
          requestId: input.requestId, nativeSessionId: runtime.session.nativeSessionId,
        }, input.sessionMode),
        prompt: messagePrompt(includeHandoff ? row.handoff_context : null), clientCorrelationId: correlationId,
        onTerminal,
        onMessageSubmitted: async (receipt) => {
          submitted = true
          await this.control(id, async () => {
            if (receipt.nativeSessionId !== runtime.session!.nativeSessionId || receipt.clientCorrelationId !== correlationId
              || !await this.repository.submittedMessage(id, input.requestId, receipt)) throw new Error('Native message ownership was lost.')
            nativeSubmission = receipt
            if (runtime.fileInputs) await this.managers.recordFileMessageSubmission!(id, input.requestId, receipt)
          })
        },
        onSubmitted: async (nativeTurnId) => {
          submittedTurnId = nativeTurnId
          // A callback is native evidence even when saving its identity fails.
          // No subsequent definite error can make this prompt safe to replay.
          submitted = true
          // Reconciliation may own control() while the original callback is retried.
          // The repository fences this SQL write by its saved request, session and owner.
          if (!await this.repository.submitted(id, input.requestId, nativeTurnId,
            { nativeSessionId: runtime.session!.nativeSessionId, principalId: row.owner_principal_id })) {
            throw new Error('Native turn ownership was lost.')
          }
          if (runtime.fileInputs) await this.managers.recordFileSubmission!(id, input.requestId, nativeTurnId)
          const current = await this.repository.active(id)
          textStream?.flush()
          this.events.publish(id, 'state', { requestId: input.requestId, activeRequestId: input.requestId,
            revision: Number(current?.revision), turnState: current?.cancel_requested ? 'canceling' : 'active' })
          const cancelRequested = Boolean(current && current.active_request_id === input.requestId && current.cancel_requested)
          if (cancelRequested) {
            // Persist identity before acknowledging submission, but NEVER await
            // a native operation here. The tracked control queue owns delivery
            // after this callback returns and releases that native lock.
            this.deliverRequestedCancellation(id, input.requestId, runtime)
          }
        },
      }, signal)) {
        // After native output, errors from pending/history reads are not prompt rejections.
        submitted = true
        const event = event_
        textStream.before(event)
        const context = this.historyContext(id, input.requestId, runtime)
        await this.recordActivity(id, input.requestId, context, event, submittedTurnId, false, nativeSubmission)
        const text = await committed.record(event, submittedTurnId, nativeSubmission)
        if (text.allowed && (text.handled || await this.recordAssistantMessage(id, input.requestId, context, event))) textStream.push(event)
        else textStream.rejected(event)
        if (text.final) this.events.publish(id, 'message', { requestId: input.requestId, snapshotRequired: true,
          scopeRevision: committed.revision() })
        if (event.type === 'interaction.pending' || event.type === 'permission.asked') {
          const pending = await runtime.manager.pending(runtime.session, signal)
          if (pending) {
            await this.repository.pending(id, input.requestId, pending)
            this.events.publish(id, 'state', { requestId: input.requestId, pending: true })
            // Keep this consumer attached while respond() releases the native wait,
            // so later output continues streaming for the same accepted turn.
          }
        }
      }
      textStream.flush()
      submitted = true
      await this.control(id, () => this.observe(id, input.requestId, runtime))
    } catch (error) {
      logOperatorTurnFailure(error)
      if (signal.aborted) textStream?.dispose(); else textStream?.flush()
      if (submitted || (submitting && !definitePromptRejection(error)) || (creating && !definiteCreationFailure(error))) {
        await this.repository.uncertain(id, input.requestId, errorMessage(error, 'Native delivery is uncertain.'))
      } else {
        await this.control(id, async () => {
          const current = await this.repository.active(id)
          if (!current || current.active_request_id !== input.requestId) return
          if (error instanceof NativeDeliveryError && error.delivery === 'not_sent'
            && !await this.repository.recordNonSubmission(id, input.requestId, error.operation, failure(error))) {
            throw new Error('Non-submission ownership was lost.')
          }
          await this.complete(id, input.requestId, current.cancel_requested ? { outcome: 'canceled' } : failure(error),
            undefined, !current.cancel_requested)
        })
      }
      this.events.publish(id, 'error', { requestId: input.requestId, message: errorMessage(error, 'Operator turn failed.') })
    } finally { await initialStream?.close(); textStream?.dispose() }
  }

  private async complete(id: string, requestId: string, result: ExecutionResult, nativeMessageId?: string, retryable = false) {
    if (!await this.journalTerminal(id, requestId, result, {
      ...(nativeMessageId ? { nativeMessageId } : {}), retryable,
      requiresRuntimeClosure: this.runtimes.get(id)?.manager.requiresRuntimeClosure?.() ?? this.runtimes.has(id),
    })) return
    await this.settleTerminal(id, requestId)
  }
  private journalTerminal(id: string, requestId: string, result: ExecutionResult,
    options: Parameters<PostgresOperatorConversationRepository['journalTerminal']>[3]) {
    const environment = this.runtimes.get(id)?.environment
    const redact = nativePersistenceRedactor(Object.values(environment?.variables ?? {}))
    return this.repository.journalTerminal(id, requestId, redact.value(result), {
      ...options, ...(options.history ? { history: redact.value(options.history) } : {}),
    })
  }
  private async settleTerminal(id: string, requestId: string): Promise<void> {
    const terminal = await this.repository.terminal(id, requestId)
    if (!terminal) return
    const { result, nativeMessageId, retryable } = terminal.observation
    if (terminal.history && !terminal.historyPersisted) {
      const row = await this.repository.active(id)
      if (!row || row.active_request_id !== requestId) return
      const configuration = await this.repository.configuration(row.operator_configuration_version_id)
      if (!configuration || !row.native_session_id || !row.provider_version) {
        throw new Error('The saved native history has no pinned conversation context.')
      }
      const context: HistoryContext = { harness: row.harness, configuration,
        session: { harness: row.harness, nativeSessionId: row.native_session_id, providerVersion: row.provider_version } }
      await this.persistObservedHistory(id, requestId, context, terminal.history, terminal.history.nativeSubmission)
      if (!await this.repository.terminalHistoryPersisted(id, requestId)) throw new Error('Native history ownership was lost.')
    }
    const runtime = this.runtimes.get(id)
    let reusable = runtime?.session && runtime.manager.retireTurn && !runtime.disposalStarted && !runtime.disposal
      && !this.closing && !runtime.observationOnly && !runtime.fileInputs && !runtime.interactionHandled
      && result.outcome === 'succeeded'
      && (Object.keys(runtime.environment?.variables ?? {}).length === 0
        || runtime.environment && await this.authority.retireTurn?.(id, runtime.environment) === true)
    if (runtime?.session && runtime.session.nativeSessionId !== terminal.observation.nativeSessionId) {
      throw new DomainError('OPERATOR_NATIVE_CLOSURE_CONFLICT', 'The result belongs to a different native runtime.', 409)
    }
    if (terminal.closureState === 'observed' && reusable && runtime) {
      const retirement = await runtime.manager.retireTurn!(runtime.session!, nativeCorrelation(id, requestId))
      if (retirement?.runtimeReleased) reusable = false
      else {
        if (!await this.repository.turnRetired(id, requestId, runtime.session!.nativeSessionId)) return
        terminal.closureState = 'retired'
      }
    }
    const retained = terminal.closureState === 'retired' && reusable
    if (terminal.closureState !== 'closed' && !retained) {
      const recovered = terminal.observation.requiresRuntimeClosure && !runtime
      if (recovered && !this.managers.closeRecoveredRuntime) {
        throw new DomainError('OPERATOR_NATIVE_CLOSURE_UNCERTAIN',
          'The result was saved, but closure of its original native runtime is unconfirmed.', 409)
      }
      if (!await this.repository.closurePending(id, requestId)) return
      if (recovered) await this.closeRecoveredRuntime(id, requestId)
      else await this.stopRuntime(id, runtime)
      this.runtimes.delete(id)
      this.managers.release?.(id)
    }
    if (await this.repository.finish(id, requestId, result, nativeMessageId, retryable)) {
      if (retained) this.scheduleIdleClose(id, runtime!)
      this.events.publish(id, 'message', { requestId })
      this.events.publish(id, 'state', { requestId, turnState: result.outcome === 'failed' ? 'error' : 'idle' })
    }
  }

  private clearIdleTimer(runtime: Runtime) {
    clearTimeout(runtime.idleTimer)
    delete runtime.idleTimer
  }

  private scheduleIdleClose(id: string, runtime: Runtime) {
    this.clearIdleTimer(runtime)
    const timer = setTimeout(() => {
      void this.control(id, async () => {
        if (this.runtimes.get(id) !== runtime || runtime.idleTimer !== timer) return
        if ((await this.repository.active(id))?.active_request_id) return
        await this.release(id)
      }).catch(ignoreError('harness', 'close idle Operator session', { chatId: id }))
    }, OPERATOR_SESSION_IDLE_MS)
    runtime.idleTimer = timer
    timer.unref()
  }
  private async closeRecoveredRuntime(id: string, requestId: string): Promise<void> {
    const results = await Promise.allSettled([
      this.authority.release(id),
      this.managers.closeRecoveredRuntime!(id, AbortSignal.timeout(10_000)),
    ])
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Operator recovered runtime closure failed.')
    const closure = results[1]!
    if (closure.status !== 'fulfilled' || closure.value !== true) {
      throw new DomainError('OPERATOR_NATIVE_CLOSURE_UNCERTAIN',
        'The result was saved, but closure of its original native runtime is unconfirmed.', 409)
    }
    if (!await this.repository.closureProven(id, requestId)) throw new Error('Native closure ownership was lost.')
  }
  private async stopRuntime(id: string, runtime: Runtime | undefined): Promise<void> {
    if (runtime) this.clearIdleTimer(runtime)
    // Revoke credentials even when saving a terminal result prevents native disposal.
    const revoking = this.authority.release(id)
    if (runtime && !runtime.disposal) {
      const disposal = (async () => {
        if (!runtime.disposalStarted) {
          await this.journalResidentTerminal(id, runtime)
          const row = await this.repository.active(id)
          if (row?.active_request_id) {
            const terminal = await this.repository.terminal(id, row.active_request_id)
            if (terminal && ['observed', 'retired'].includes(terminal.closureState)
              && !await this.repository.closurePending(id, row.active_request_id)) {
              throw new Error('Native closure ownership was lost.')
            }
          }
          // Native reads stop once disposal begins, including failed cleanup attempts.
          runtime.disposalStarted = true
        }
        if (runtime.session && runtime.configuration?.harnessProfileSelection?.target.hostRef.kind === 'device') {
          if (!runtime.manager.closeForResume) throw new DomainError('NATIVE_RUNTIME_RELEASE_UNAVAILABLE',
            'The Worker cannot confirm closure of its resumable process.', 409)
          await runtime.manager.closeForResume(runtime.session)
        }
        if (runtime.manager.dispose) await runtime.manager.dispose()
        else if (runtime.session) await runtime.manager.close(runtime.session)
      })()
      runtime.disposal = disposal
      void disposal.catch(() => { if (runtime.disposal === disposal) delete runtime.disposal })
    }
    const results = await Promise.allSettled([revoking, ...(runtime?.disposal ? [runtime.disposal] : [])])
    const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Operator native disposal or credential revocation failed.')
    const row = await this.repository.active(id)
    if (row?.active_request_id) {
      const terminal = await this.repository.terminal(id, row.active_request_id)
      if (terminal?.closureState === 'pending' && !await this.repository.closureProven(id, row.active_request_id)) {
        throw new Error('Native closure ownership was lost.')
      }
    }
  }
  private async journalResidentTerminal(id: string, runtime: Runtime): Promise<void> {
    if (!runtime.session) return
    const row = await this.repository.active(id)
    if (!row?.active_request_id || row.native_session_id !== runtime.session.nativeSessionId) return
    // Accepted input has no native effect; settings replacement is closing the preceding idle turn.
    if (row.active_phase === 'accepted') return
    if (nativeNonSubmission(row.record, row.active_request_id)
      || await this.repository.terminal(id, row.active_request_id)) return
    const correlationId = nativeCorrelation(id, row.active_request_id)
    const history = await runtime.manager.reconcile(runtime.session, correlationId, AbortSignal.timeout(5_000))
    const submission = history.nativeSubmission
    const messageMatches = submission?.kind === 'message' && submission.nativeSessionId === row.native_session_id
      && submission.clientCorrelationId === correlationId && history.terminalTurn?.correlationId === correlationId
      && history.terminalTurn.providerId === submission.nativeMessageId
    const turnMatches = row.harness !== 'claude'
      && Boolean(history.nativeTurnId && history.nativeTurnId === row.active_native_turn_id)
    if (!history.terminalResult || history.correlationId !== correlationId || !messageMatches && !turnMatches) return
    await this.journalTerminal(id, row.active_request_id, history.terminalResult, {
      ...(history.nativeMessageId ? { nativeMessageId: history.nativeMessageId } : {}),
      ...(messageMatches ? { submission: submission! } : {}), retryable: false, requiresRuntimeClosure: true,
      history,
    })
    await this.persistObservedHistory(id, row.active_request_id, this.historyContext(id, row.active_request_id, runtime),
      history, messageMatches ? submission : undefined)
  }
  private async release(id: string) {
    await this.stopRuntime(id, this.runtimes.get(id))
    this.runtimes.delete(id); this.managers.release?.(id)
  }
  private async persistObservedHistory(id: string, requestId: string, runtime: HistoryContext, history: NativeHistory,
    receipt?: NativeMessageSubmission) {
    for (const event of currentOperatorHistory(history, runtime.harness)) {
      await this.recordActivity(id, requestId, runtime, event, history.nativeTurnId ?? null, true, receipt)
      await this.recordAssistantMessage(id, requestId, runtime, event)
    }
    const currentOwner = await this.repository.active(id)
    if (!currentOwner || currentOwner.active_request_id !== requestId || currentOwner.native_session_id !== runtime.session!.nativeSessionId) return undefined
    const pending = pendingInteractionAfterHistory(currentOwner.pending_interaction, history)
    await this.repository.pending(id, requestId, pending)
    if ((!this.responding.has(id) || this.closing) && receipt !== undefined) {
      const state = await this.repository.get(id)
      if (state) await this.receipts().reconcileStoredResponses(id, requestId, { kind: 'operator_chat', conversationId: id },
        runtime.session!, receipt!, state)
    }
    // Message acknowledgements are journaled by the response before history settles them.
    const canReconcileResponses = !this.responding.has(id) || this.closing || receipt === undefined
    if (canReconcileResponses && history.responseDeliveries?.length) {
      const state = await this.repository.get(id)
      for (const proof of history.responseDeliveries) {
        const identity = proof.nativeIdentity ?? (history.nativeTurnId ? { kind: 'turn' as const, nativeTurnId: history.nativeTurnId } : undefined)
        if (state && identity) await this.receipts().reconcileResponses(id, requestId, { kind: 'operator_chat', conversationId: id },
          runtime.session!, identity, history.responseDeliveries, state)
      }
    }
    return pending
  }
  private async observe(id: string, requestId: string, runtime: Runtime, signal = this.lifetime.signal): Promise<void> {
    if (!runtime.session) return
    const row = await this.repository.active(id)
    if (!row || row.active_request_id !== requestId) return
    const correlationId = nativeCorrelation(id, requestId)
    const history: NativeHistory = await runtime.manager.reconcile(runtime.session, correlationId, signal)
    const rejected = history.nonSubmission
    if (rejected && rejected.nativeSessionId === row.native_session_id
      && rejected.clientCorrelationId === correlationId && !row.active_native_turn_id) {
      if (!await this.repository.recordNonSubmission(id, requestId, 'turn_submission', rejected.result)) return
      await this.complete(id, requestId, row.cancel_requested ? { outcome: 'canceled' } : rejected.result,
        undefined, !row.cancel_requested)
      return
    }
    const receipt = history.nativeSubmission
    const messageIdentity = receipt?.kind === 'message' && receipt.nativeSessionId === runtime.session.nativeSessionId && receipt.clientCorrelationId === correlationId
    if (runtime.session.nativeSessionId !== row.native_session_id || history.correlationId !== correlationId || !history.nativeTurnId && !messageIdentity
      || (row.active_native_turn_id && row.active_native_turn_id !== history.nativeTurnId)) {
      await this.repository.uncertain(id, requestId, 'The provider has not proven the identity of this request. No new turn will be submitted.')
      return
    }
    if (messageIdentity) {
      if (!await this.repository.submittedMessage(id, requestId, receipt!)) return
      if (runtime.fileInputs) await this.managers.recordFileMessageSubmission!(id, requestId, receipt!)
    } else {
      if (!await this.repository.submitted(id, requestId, history.nativeTurnId!,
        { nativeSessionId: runtime.session.nativeSessionId, principalId: row.owner_principal_id })) return
      if (runtime.fileInputs) await this.managers.recordFileSubmission!(id, requestId, history.nativeTurnId!)
    }
    const terminalMatches = history.terminalResult && (!messageIdentity
      || history.terminalTurn?.correlationId === correlationId && history.terminalTurn.providerId === receipt!.nativeMessageId)
    if (terminalMatches) {
      await this.journalTerminal(id, requestId, history.terminalResult!, {
        ...(history.nativeMessageId ? { nativeMessageId: history.nativeMessageId } : {}),
        retryable: false, requiresRuntimeClosure: true,
        history,
      })
    }
    const pending = await this.persistObservedHistory(id, requestId, this.historyContext(id, requestId, runtime),
      history, messageIdentity ? receipt : undefined)
    if (!this.responding.has(id) && history.terminalResult && !pending && (!messageIdentity || history.terminalTurn?.correlationId === correlationId
      && history.terminalTurn.providerId === receipt!.nativeMessageId)) {
      await this.complete(id, requestId, history.terminalResult, history.nativeMessageId)
    } else {
      const current = await this.repository.active(id)
      if (!current || current.active_request_id !== requestId) return
      if (current.cancel_requested) {
        await this.interrupt(id, { ...current, active_native_turn_id: history.nativeTurnId ?? null }, runtime)
        return
      }
      this.events.publish(id, 'state', { requestId, turnState: 'active', pending: Boolean(pending) })
    }
  }
  /** Returns false when no native turn or Claude message receipt is known yet to interrupt. */
  private async interrupt(id: string, row: ConversationRow, runtime: Runtime, markDispatchAttempt?: () => void): Promise<boolean> {
    if (!runtime.session || !row.active_request_id) return false
    const target = row.active_native_turn_id ?? await this.repository.submittedMessageId(id, row.active_request_id)
    if (!target) return false
    markDispatchAttempt?.()
    const acknowledged = await runtime.manager.cancel(runtime.session, AbortSignal.timeout(5_000), target)
    // Neither false nor an interrupt ACK establishes terminal completion.
    if (!acknowledged) await this.repository.uncertain(id, row.active_request_id, 'The provider did not acknowledge cancellation; reconciliation will continue.')
    this.events.publish(id, 'state', { requestId: row.active_request_id, turnState: 'canceling' })
    return true
  }

  async cancel(id: string, requestId: string, principal: ManagementPrincipal, commandId?: string, source: 'http' | 'mcp' = 'http') {
    this.assertOpen()
    await this.assertAccess(id, principal, 'operator_chat:cancel')
    const key = commandId ?? `operator-cancel:${commandInputHash([id, requestId]).slice(7)}`
    return this.receipts().execute(principal, source, id, key, { kind: 'cancel', requestId },
      (markDispatchAttempt) => this.cancelNative(id, requestId, principal, markDispatchAttempt), () => this.controlRead(id, principal, 'operator_chat:cancel'))
  }

  private async cancelNative(id: string, requestId: string, principal: ManagementPrincipal, markDispatchAttempt: () => void) {
    this.assertOpen()
    await this.assertAccess(id, principal, 'operator_chat:cancel')
    // Intent is a request-fenced database transition, not a native write. Do not
    // queue it behind a slow approval response. Native delivery stays serialized.
    if (!await this.repository.requestCancel(id, requestId)) return this.get(id, principal)
    const task = this.tasks.get(id)
    if (task?.requestId === requestId) task.controller.abort(new Error('Operator cancellation requested.'))
    const responseInFlight = this.responding.has(id)
    const delivery = this.control(id, async () => {
      const row = await this.repository.active(id)
      if (!row || row.active_request_id !== requestId || !row.cancel_requested) return
      const initialSessionBound = row.harness === 'claude' && row.native_session_id
      const beforeSubmission = row.active_phase === 'accepted' || row.active_phase === 'ready' && !initialSessionBound
      if (beforeSubmission && !this.tasks.has(id)) {
        await this.complete(id, requestId, { outcome: 'canceled' }); return
      }
      try {
        let runtime = this.runtimes.get(id)
        if (!runtime && row.native_session_id) {
          const configuration = await this.repository.configuration(row.operator_configuration_version_id)
          if (!configuration) throw new Error('Pinned Operator configuration was not found.')
          runtime = await this.cleanupRuntime(id, row, configuration,
            AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)]))
        }
        runtime?.manager.setSessionControlPrincipal?.(principal.id)
        if (runtime) {
          await this.interrupt(id, row, runtime, markDispatchAttempt)
          await this.observe(id, requestId, runtime, AbortSignal.timeout(5_000))
        }
      } catch (error) {
        await this.repository.uncertain(id, requestId, errorMessage(error, 'Cancellation delivery is uncertain.'))
        this.events.publish(id, 'error', { requestId, turnState: 'uncertain' })
      } finally {
        // Once submission identity is durable, a silent event stream must not
        // pin the task forever after cancellation. Recovery still requires
        // exact provider evidence; detaching observation never finishes a turn.
        if (row.active_native_turn_id) {
          const task = this.tasks.get(id)
          if (task && task.requestId === requestId) task.controller.abort()
        }
      }
    })
    // Preserve the ordinary immediate-cancel response, but never wait behind
    // an approval delivery just to acknowledge durable cancellation intent.
    void delivery.catch(ignoreError('harness', 'deliver operator cancellation', { chatId: id, requestId }))
    if (!responseInFlight) await delivery
    return this.get(id, principal)
  }

  async respond(id: string, input: RespondOperatorInteractionRequest, principal: ManagementPrincipal, source: 'http' | 'mcp' = 'http') {
    this.assertOpen()
    await this.assertAccess(id, principal, 'operator_chat:respond')
    let providerAcknowledgment: ChatResponseAcknowledgment | undefined
    const acceptedControl = acceptedOperatorResponseControl(await this.get(id, principal), input.requestId,
      input.nativeRequestId, input.optionId, input.response)
    const key = input.commandId ?? `operator-respond:${commandInputHash([id, input.requestId, input.nativeRequestId]).slice(7)}`
    return this.receipts().execute(principal, source, id, key,
      { kind: 'respond', requestId: input.requestId, nativeRequestId: input.nativeRequestId, optionId: input.optionId,
        ...(input.response !== undefined ? { response: input.response } : {}) },
      (markDispatchAttempt) => this.respondNative(id, input, principal, markDispatchAttempt, (proof) => { providerAcknowledgment = proof }),
      () => this.controlRead(id, principal, 'operator_chat:respond'), acceptedControl, () => providerAcknowledgment)
  }

  private async respondNative(id: string, input: RespondOperatorInteractionRequest, principal: ManagementPrincipal, markDispatchAttempt: () => void,
    recordEvidence: (proof: ChatResponseAcknowledgment) => void) {
    this.assertOpen()
    await this.assertAccess(id, principal, 'operator_chat:respond')
    await this.control(id, async () => {
      const row = await this.repository.active(id)
      const pending = row?.pending_interaction
      const offered = pending?.responseOptions.find((item) => item.optionId === input.optionId)
      const standalone = pending && isSessionNativeInteraction(pending)
      const requestId = row?.active_request_id ?? (standalone ? pending.turn.nativeRequestId : undefined)
      if (!row || requestId !== input.requestId || pending?.turn.nativeRequestId !== input.nativeRequestId || !offered) {
        throw new DomainError('NATIVE_RESPONSE_UNKNOWN_REQUEST', 'This approval is no longer offered for this turn.', 409)
      }
      const option = withInteractionResponse(offered, input.response)
      const configuration = await this.repository.configuration(row.operator_configuration_version_id)
      if (!configuration) throw new DomainError('OPERATOR_CONFIGURATION_NOT_FOUND', 'Pinned Operator configuration was not found.', 409)
      const owner = await this.authority.current(row.owner_principal_id!)
      requireAuthorization(owner, 'operator_chat:write')
      requireAuthorization(owner, 'operator_chat:respond')
      const runtime = await this.observationRuntime(id, row, configuration, this.lifetime.signal)
      if (!runtime.session || !await this.repository.claimResponse(id, row.active_request_id, input.nativeRequestId)) {
        throw new DomainError('NATIVE_RESPONSE_UNCERTAIN', 'A response was already submitted. Reconcile it before retrying.', 409)
      }
      runtime.interactionHandled = true
      let delivered = false
      this.responding.add(id)
      try {
        markDispatchAttempt()
        runtime.manager.setSessionControlPrincipal?.(principal.id)
        await runtime.manager.respond(runtime.session, input.nativeRequestId, option, this.lifetime.signal)
        delivered = true
        if (runtime.manager.reconcileResponse && pending) {
          const history = await runtime.manager.reconcileResponse(runtime.session, { nativeRequestId: input.nativeRequestId,
            nativeRequestType: pending.nativeRequestType, option }, this.lifetime.signal)
          const proofs = (history.responseDeliveries ?? []).filter((proof) => proof.nativeSessionId === runtime.session!.nativeSessionId
            && proof.nativeRequestId === input.nativeRequestId)
          if (proofs.length && proofs.every((proof) => proof.harness === runtime.session!.harness
            && proof.providerVersion === runtime.session!.providerVersion && proof.nativeRequestType === pending.nativeRequestType
            && proof.optionId === option.optionId && proof.semantic === option.semantic)) recordEvidence(proofs[0]!)
        }
        await this.repository.pending(id, row.active_request_id)
        if (row.active_request_id) await this.observe(id, input.requestId, runtime)
      } catch (error) {
        const code = error && typeof error === 'object' && 'result' in error
          ? (error as { result?: ExecutionResult }).result?.error?.code : undefined
        const definite = !delivered && ((error && typeof error === 'object' && 'certainty' in error && error.certainty === 'definite')
          || ['NATIVE_RESPONSE_DELIVERY_FAILED', 'NATIVE_RESPONSE_OPTION_INVALID', 'NATIVE_RESPONSE_UNKNOWN_REQUEST'].includes(code ?? ''))
        if (definite) await this.repository.responseFailed(id, input.requestId, input.nativeRequestId)
        else await this.repository.responseUncertain(id, input.requestId)
        throw error
      } finally { this.responding.delete(id) }
    })
    return this.get(id, principal)
  }

  reconcileActive(): Promise<void> {
    if (this.reconciliation) return this.reconciliation
    if (this.closing) return Promise.resolve()
    const promise = this.reconcile().finally(() => { this.reconciliation = undefined })
    this.reconciliation = promise
    return promise
  }
  /** This preflight does no native writes and must not wait for a response lane. */
  private async recoveryAuthority(row: ConversationRow): Promise<boolean> {
    if (!row.owner_principal_id || !row.active_request_id) return false
    try {
      requireAuthorization(await this.authority.current(row.owner_principal_id), 'operator_chat:write')
      return false
    } catch (error) {
      if (!(error instanceof DomainError) || !/AUTH_|ACCESS_DENIED/.test(error.code)) throw error
      if (!await this.repository.requestCancel(row.id, row.active_request_id)) return true
      const resident = this.runtimes.get(row.id)
      if (resident?.session) resident.manager.stopAutomaticResponses?.(resident.session)
      const task = this.tasks.get(row.id)
      if (task?.requestId === row.active_request_id) task.controller.abort(new Error('Operator owner authority ended.'))
      await this.authority.release(row.id)
      return true
    }
  }

  private async reconcile() {
    await reconcileKnownActivities({ kind: 'operator', activity: this.repository.activity,
      observations: this.activityObservations,
      onObservation: id => this.events.publish(id, 'state', { snapshotRequired: true }),
      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(5_000)]),
      runtimeFor: (id) => {
        const runtime = this.runtimes.get(id)
        return runtime?.session && !runtime.disposal ? { manager: runtime.manager, session: runtime.session, redact: nativePersistenceRedactor(Object.values(runtime.environment?.variables ?? {})) } : undefined
      }, publish: (id, settled) => this.events.publish(id, 'activity', settled) })
    const candidates = (await this.repository.unfinished())[Symbol.iterator]()
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (const candidate of candidates) {
        if (this.closing) return
        if (candidate.harness === 'opencode') continue
        await this.reconcileConversation(candidate)
      }
    }))
  }

  private async reconcileConversation(candidate: ConversationRow) {
    let revoked = false
    let terminalObserved: boolean
    try {
      terminalObserved = Boolean(await this.repository.terminal(candidate.id, candidate.active_request_id!))
      if (!terminalObserved) {
        revoked = await this.recoveryAuthority(candidate)
      }
    } catch (error) {
      await this.repository.uncertain(candidate.id, candidate.active_request_id!,
        errorMessage(error, 'Owner recovery authority is unavailable.'))
      return
    }
    // Do not wait behind a native response. Once a terminal result is saved,
    // join its queued settlement so recovery waits for receipts and closure.
    if (this.controls.has(candidate.id) && (!terminalObserved || this.responding.has(candidate.id))) return
    await this.control(candidate.id, async () => {
      const row = await this.repository.active(candidate.id)
      if (!row?.active_request_id || row.active_request_id !== candidate.active_request_id) return
      const requestId = row.active_request_id
      try {
        if (!row.owner_principal_id) throw new Error('This legacy conversation needs an explicit owner assignment before recovery.')
        // Startup owns submission until its receipt is saved. After submission,
        // a live stream can stay attached while recovery settles response receipts.
        if (this.tasks.has(row.id) && row.active_phase !== 'submitted') return
        if (await this.repository.terminal(row.id, requestId)) {
          await this.settleTerminal(row.id, requestId)
          return
        }
        const nonSubmission = nativeNonSubmission(row.record, requestId)
        if (nonSubmission) {
          await this.complete(row.id, requestId, row.cancel_requested ? { outcome: 'canceled' } : nonSubmission.result,
            undefined, !row.cancel_requested)
          return
        }
        const initialSessionBound = row.harness === 'claude' && row.native_session_id
        if (row.active_phase === 'accepted' || row.active_phase === 'ready' && !initialSessionBound) {
          await this.complete(row.id, requestId, row.cancel_requested ? { outcome: 'canceled' }
            : failure(new Error('The server stopped before native submission. Retry the same request.')), undefined, !row.cancel_requested)
          return
        }
        if (!row.native_session_id) {
          let resident = this.runtimes.get(row.id)
          const initialTurn = row.harness === 'claude' && row.active_phase === 'submitting'
          const creating = row.active_phase === 'creating' || initialTurn
          if (!resident && creating) {
            const configuration = await this.repository.configuration(row.operator_configuration_version_id)
            if (configuration?.harnessProfileSelection?.target.hostRef.kind === 'device') {
              const fileInputs = await this.managers.hasFileInputs?.(row.id, requestId) ?? false
              resident = { manager: this.managers(configuration, row.id, fileInputs), fileInputs,
                configuration, observationOnly: true,
                creationInput: { kind: 'operator', configuration, workingDirectory: this.workingDirectory,
                  correlationId: nativeCorrelation(row.id, requestId) } }
              this.runtimes.set(row.id, resident)
              const preferences = await this.sessionControls().preferences(row.id)
              if (preferences) await resident.manager.configureSessionPreferences?.(preferences)
            }
          }
          if (!resident || resident.disposal || !creating) {
            throw new Error('Native session creation is uncertain; a replacement will not be created automatically.')
          }
          const creationInput = resident.creationInput
          if (!resident.session && creationInput && resident.manager.reconcileSessionCreation) {
            try {
              resident.session = await resident.manager.reconcileSessionCreation(creationInput, this.lifetime.signal)
            } catch (error) {
              if (!definiteCreationFailure(error)) throw error
              if (!await this.repository.recordNonSubmission(row.id, requestId, 'session_creation', failure(error))) {
                throw new Error('Non-creation ownership was lost.', { cause: error })
              }
              await this.complete(row.id, requestId, row.cancel_requested ? { outcome: 'canceled' } : failure(error),
                undefined, !row.cancel_requested)
              return
            }
          }
          this.lifetime.signal.throwIfAborted()
          if (this.runtimes.get(row.id) !== resident || resident.disposal
            || !resident.session || resident.session.harness !== row.harness
            || !creationInput || creationInput.correlationId !== nativeCorrelation(row.id, requestId)
            || creationInput.kind !== 'operator'
            || creationInput.configuration.id !== row.operator_configuration_version_id) {
            throw new Error('The original native session creation is not established.')
          }
          await this.repository.bind(row.id, requestId, resident.session.providerVersion, resident.session.nativeSessionId)
          if (initialTurn) {
            await this.observe(row.id, requestId, resident)
            return
          }
          await this.complete(row.id, requestId, row.cancel_requested ? { outcome: 'canceled' }
            : failure(new Error('Session binding recovered before prompt submission. Retry the same request.')), undefined, !row.cancel_requested)
          return
        }
        const configuration = await this.repository.configuration(row.operator_configuration_version_id)
        if (!configuration) throw new Error('Pinned Operator configuration was not found.')
        const cleanup = revoked || row.cancel_requested
        // Existing-turn observation is not new-work qualification. Native attach still verifies its protocol.
        const attachSignal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)])
        const runtime = cleanup ? await this.cleanupRuntime(row.id, row, configuration, attachSignal)
          : await this.observationRuntime(row.id, row, configuration, attachSignal)
        const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(5_000)])
        if (cleanup) await this.interrupt(row.id, row, runtime)
        await this.observe(row.id, requestId, runtime, signal)
      } catch (error) {
        await this.repository.uncertain(row.id, requestId, errorMessage(error, 'Native recovery is uncertain.'))
        // Revoked authority must not leave a resident model running with native tools.
        if (error instanceof DomainError && /AUTH_|ACCESS_DENIED/.test(error.code)) {
          const runtime = this.runtimes.get(row.id)
          await this.repository.requestCancel(row.id, requestId)
          if (runtime) await this.interrupt(row.id, row, runtime)
            .catch(ignoreError('harness', 'interrupt native turn after failed delivery', { chatId: row.id, requestId }))
        }
        this.events.publish(row.id, 'error', { requestId, turnState: 'uncertain' })
      }
    })
  }

  shutdown(): Promise<void> {
    this.closing = true
    this.lifetime.abort(new Error('Operator chat is shutting down.'))
    for (const controller of this.acceptanceControllers) controller.abort()
    for (const task of this.tasks.values()) task.controller.abort()
    this.shutdownTask ??= (async () => {
      // Dispose before waiting for stream consumers. Creation-time managers are already registered.
      const first = await Promise.allSettled([
        ...[...this.runtimes.entries()].map(([id, runtime]) => this.stopRuntime(id, runtime)),
        ...this.accepting, ...this.controls.values(),
        ...[...this.tasks.values()].map((task) => task.promise),
        ...(this.reconciliation ? [this.reconciliation] : []),
      ])
      const second = await Promise.allSettled([...this.runtimes.keys()].map((id) => this.release(id)))
      const errors = [...first, ...second].flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
      await this.commandReceipts?.drain()
      if (errors.length) throw new AggregateError(errors, 'Operator chat shutdown was incomplete.')
    })()
    return this.shutdownTask
  }
}

function logOperatorTurnFailure(error: unknown) {
  const code = failure(error).error?.code
  componentLogger('harness').error({
    errorType: error instanceof Error ? error.constructor.name : typeof error,
    ...(code && /^[A-Za-z0-9_-]{1,64}$/.test(code) ? { errorCode: code } : {}),
    stackFrames: error instanceof Error
      ? error.stack?.split('\n').filter(frame => /^\s+at\s/.test(frame)).slice(0, 8) ?? [] : [],
  }, 'Operator native turn failed')
}
