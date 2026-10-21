import type { ContextSnapshot, SessionMode, SessionPreferences, WorkflowSessionContinuation } from '@foreman-code/contracts'
import { readNativeExecutionBinding } from '../../placement/executionBinding.js'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { HarnessExecutionRequestSchema, AgentConfigurationVersionSchema, ApprovalResponseOptionSchema,
  RETIRED_OPENCODE_MESSAGE, withInteractionResponse, type NativeSessionReference, type HarnessExecutionRequest,
  type RecordedAgentHarness, type AgentHarness } from '@foreman-code/contracts'
import { canonicalGraphJson, OutputSchemaSchema } from '@foreman-code/contracts/wave25'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { DispatchIntentSchema, type AcceptedNodePlacement, type DispatchIntent, type NativeExecutionPlacement } from '@foreman-code/contracts/node-placement'
import { RemoteOwnerControlSchema, RemoteReviewerAssignmentSchema, remoteActiveNative, type RemoteReviewerRequest,
  type RemoteNativeIdentity, type RemoteTerminalEvidence, type RemoteOperationReceipt, type RemoteOwnerReconciliation, type RemoteApplicationAccess } from '@foreman-code/contracts/remote-execution'
import { RemoteExecutionRpcRequestSchema } from '@foreman-code/contracts/remote-execution-rpc'
import type { DeviceConnectionIdentity } from '@foreman-code/contracts/device-identity'
import type { NativeSessionManagerResolver, NativeManagerResolutionContext } from '../../interactions/runtimePorts.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeTurnInput, ChildProcessEnvironment } from '../../harnesses/port.js'
import { assertRuntimeLeafPath, assertRuntimeLeafBinding, type RuntimeLeafAttestation } from './runtimeLeaf.js'
import { readPlacement } from '../../placement/binding.js'
import type { RemoteOperationJournal } from './operationJournal.js'
import { HistoryObservationPages } from './historyObservationPages.js'
import { startNativeHistoryDownload } from './nativeHistoryPage.js'
import { DomainError } from '../../errors.js'
import { logIgnoredError } from '../../diagnostics/ignoredError.js'
import { inspectNativeResponse } from '../../harnesses/responseAvailability.js'

function executableHarness(harness: RecordedAgentHarness): AgentHarness {
  if (harness === 'opencode') {
    throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
  }
  return harness
}

export interface RemoteExecutionHostPorts {
  journal: RemoteOperationJournal
  connection: DeviceConnectionIdentity
  incarnationId: string
  managers: NativeSessionManagerResolver
  authorize(intent: DispatchIntent, placement: AcceptedNodePlacement, action: 'start' | 'read' | 'control' | 'stop', signal?: AbortSignal): Promise<void>
  authorizeReview?(intent: DispatchIntent, placement: AcceptedNodePlacement, review: RemoteReviewerRequest): Promise<void>
  /** Host-local credentials and sandbox policy; never copied from main. */
  attestRuntimeLeaf(intent: DispatchIntent, placement: AcceptedNodePlacement, request: HarnessExecutionRequest, executionPlacement?: NativeExecutionPlacement, signal?: AbortSignal): Promise<RuntimeLeafAttestation>
  preflight(request: HarnessExecutionRequest, applicationAccess: RemoteApplicationAccess | undefined, signal: AbortSignal): Promise<ChildProcessEnvironment | void>
  nativeEvidence(intent: DispatchIntent, session: NativeSessionReference, context?: { manager: NativeHarnessSessionManager; request: HarnessExecutionRequest; signal: AbortSignal }): Promise<RemoteNativeIdentity>
  /** W11/provider closure verification; terminal observation alone is insufficient. */
  verifyOwnerRenewal?(transition: RemoteOwnerReconciliation, receipt: RemoteOperationReceipt): Promise<void>
  verifyRecovery?(receipt: RemoteOperationReceipt, session: NativeSessionReference, evidenceDigest: string): Promise<void>
  settle(intent: DispatchIntent, history: NativeHistory, owner: { manager: NativeHarnessSessionManager; session: NativeSessionReference; request: HarnessExecutionRequest }): Promise<RemoteTerminalEvidence | null>
}
interface Resident { intent: DispatchIntent; placement: AcceptedNodePlacement; request: HarnessExecutionRequest; manager: NativeHarnessSessionManager; session: NativeSessionReference; controller: AbortController; turn?: Promise<void>; cancellation?: Promise<void>; settlementTask?: Promise<{ stopFence: boolean }>; settlementHistory?: NativeHistory; workflowHistory?: NativeHistory; settlementEvidence?: RemoteTerminalEvidence }
interface WorkflowPreparation {
  intent: unknown
  placement: unknown
  request: unknown
  sessionContinuation?: WorkflowSessionContinuation | undefined
  executionPlacement?: NativeExecutionPlacement | undefined
  applicationAccess?: RemoteApplicationAccess | undefined
  sessionPreferences?: SessionPreferences | undefined
}
/** Worker-only authenticated extension handler. No DB, scheduler, HTTP server or production composition. */
export class RemoteExecutionHost {
  private readonly historyPages = new HistoryObservationPages()
  private closing = false
  private shutdownTask: Promise<void> | undefined
  private readonly preparations = new Set<Promise<unknown>>()
  private readonly allocatedManagers = new Map<string, {
    manager: NativeHarnessSessionManager
    context: NativeManagerResolutionContext
  }>()
  private readonly inspections = new Map<string, Set<AbortController>>()
  private readonly launchControllers = new Map<string, AbortController>()
  private readonly pendingEntries = new Map<string, Set<Promise<unknown>>>()
  private readonly inFlightPreparations = new Map<string, { raw: WorkflowPreparation; task: Promise<unknown> }>()
  private readonly bindings = new Map<string, { intent: DispatchIntent; placement: AcceptedNodePlacement }>()
  private readonly residents = new Map<string, Resident>()
  constructor(private readonly ports: RemoteExecutionHostPorts) {}
  shutdown(): Promise<void> {
    return this.shutdownTask ??= this.shutdownOwned()
  }
  private async shutdownOwned(): Promise<void> {
    this.closing = true
    for (const controller of this.launchControllers.values()) controller.abort(new Error('Worker execution host is shutting down.'))
    for (const controllers of this.inspections.values()) for (const controller of controllers) controller.abort(new Error('Worker execution host is shutting down.'))
    for (const owned of this.residents.values()) owned.controller.abort(new Error('Worker execution host is shutting down.'))
    await Promise.allSettled([...this.preparations])
    const active = [...this.residents.values()]
    for (const owned of active) owned.controller.abort(new Error('Worker execution host is shutting down.'))
    await Promise.allSettled(active.flatMap(owned => owned.turn ? [owned.turn] : []))
    const managers = new Set([...this.allocatedManagers.values()].map(value => value.manager)
      .concat(active.map(owned => owned.manager)))
    await Promise.all([...managers].map(async manager => {
      if (!manager.dispose) throw new Error('An actual worker native manager has no disposal contract.')
      await manager.dispose()
    }))
  }
  handle(raw: unknown): Promise<unknown> {
    return this.track(() => this.handleOwned(raw))
  }
  async waitForSettlement(operationId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const task = this.residents.get(operationId)?.settlementTask
    if (!task) return
    await new Promise<void>((resolve, reject) => {
      const aborted = () => reject(signal.reason)
      signal.addEventListener('abort', aborted, { once: true })
      void task.then(() => {
        signal.removeEventListener('abort', aborted)
        resolve()
      }, error => {
        signal.removeEventListener('abort', aborted)
        reject(error)
      })
    })
    signal.throwIfAborted()
  }
  private track<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Worker execution host is shutting down.'))
    const task = work()
    this.preparations.add(task)
    void task.then(() => this.preparations.delete(task), () => this.preparations.delete(task))
    return task
  }
  private async handleOwned(raw: unknown) {
    const frame = RemoteExecutionRpcRequestSchema.parse(raw)
    const placement = readPlacement(frame.placement)
    if (placement.hostRef.kind !== 'device' || placement.hostRef.deviceId !== this.ports.connection.deviceId
      || placement.mainId !== this.ports.connection.mainId || frame.intent.bindingHash !== placement.bindingHash
      || frame.intent.runId !== placement.runId || frame.intent.nodeId !== placement.nodeId) throw new Error('RPC ownership mismatch')
    const recorded = await this.ports.journal.status(frame.intent.operationId)
    if (frame.method === 'renew-owner') {
      if (recorded.status !== 'known' || !this.ports.verifyOwnerRenewal || !isDeepStrictEqual(frame.intent.owner, frame.transition.nextOwner)
        || !isDeepStrictEqual({ ...recorded.receipt.intent, owner: frame.transition.nextOwner }, frame.intent)) throw new Error('Original owner renewal binding mismatch')
      await this.ports.authorize(frame.intent, placement, 'control')
      await this.ports.verifyOwnerRenewal(frame.transition, recorded.receipt)
      await this.ports.journal.reconcileOwner(frame.transition)
      this.bindings.set(frame.intent.operationId, { intent: frame.intent, placement })
      const resident = this.residents.get(frame.intent.operationId)
      if (resident) resident.intent = frame.intent
      return this.ports.journal.status(frame.intent.operationId)
    }
    if (recorded.status === 'known' && !isDeepStrictEqual(recorded.receipt.intent, frame.intent)) throw new Error('RPC stale execution owner')
    let action: 'start' | 'read' | 'control' | 'stop' = 'read'
    if (frame.method === 'control') action = frame.command.action.kind === 'stop' ? 'stop' : 'control'
    else if (frame.method === 'session-compact' || frame.method === 'session-preferences-apply') action = 'control'
    else if (frame.method === 'prepare' || frame.method === 'start-turn' && !frame.review) action = 'start'
    await this.ports.authorize(frame.intent, placement, action)
    if (frame.method === 'control-delivery') {
      const command = frame.command
      if (command.operationId !== frame.intent.operationId || command.executionId !== frame.intent.executionId
        || command.attemptId !== frame.intent.attemptId || command.bindingHash !== frame.intent.bindingHash
        || !isDeepStrictEqual(command.owner, frame.intent.owner)
          && (recorded.status !== 'known'
            || !recorded.receipt.controls.some(prior => isDeepStrictEqual(prior, command)))) {
        throw new Error('Control delivery ownership mismatch')
      }
      const phase = await this.ports.journal.controlDelivery(command)
      return { phase: phase ?? 'unknown', status: await this.ports.journal.status(frame.intent.operationId) }
    }
    if (frame.method === 'prepare') return this.prepare(frame)
    if (frame.method === 'reattach') return this.reattach(frame)
    if (frame.method === 'inspect-response-availability') {
      const resident = await this.resident(frame.intent.operationId, 'read')
      if (!isDeepStrictEqual(resident.session, frame.session)) throw new Error('Wrong native inspection session')
      return inspectNativeResponse(resident.manager, resident.session, frame.query, {
        signal: resident.controller.signal,
        isCurrent: () => this.residents.get(frame.intent.operationId) === resident && !this.closing,
      })
    }
    if (frame.method === 'capabilities' || frame.method === 'inspect-mcp') return this.inspect(frame, frame.method === 'capabilities' ? 'capabilities' : 'inspectMcp')
    if (frame.method === 'session-controls-read' || frame.method === 'session-preferences-apply' || frame.method === 'session-compact' || frame.method === 'session-compact-reconcile') {
      const resident = await this.resident(frame.intent.operationId, ['session-compact', 'session-preferences-apply'].includes(frame.method) ? 'control' : 'read')
      const status = await this.ports.journal.status(frame.intent.operationId)
      if (status.status !== 'known' || !isDeepStrictEqual(status.receipt.native, frame.native)
        || resident.session.nativeSessionId !== frame.native.sessionId) throw new Error('Wrong native control target or generation')
      if (frame.method === 'session-preferences-apply') {
        if (!resident.manager.applySessionPreferences) throw new Error('Native safe-resume preferences are unavailable')
        await resident.manager.applySessionPreferences(resident.session, frame.preferences, resident.controller.signal)
        return { status: await this.ports.journal.status(frame.intent.operationId) }
      }
      if (frame.method === 'session-controls-read') {
        if (!resident.manager.sessionControlCapabilities) throw new Error('Native session controls are unavailable')
        return { capabilities: await resident.manager.sessionControlCapabilities(resident.session),
          context: resident.manager.contextSnapshot?.(resident.session) ?? null,
          preferences: resident.manager.appliedSessionPreferences?.(resident.session) ?? null, status }
      }
      if (frame.method === 'session-compact-reconcile') {
        const saved = await this.ports.journal.sessionControl(frame.intent.operationId, frame.state.requestId)
        if (!saved || !isDeepStrictEqual(saved.native, frame.native)) throw new Error('The original compaction is not in this worker journal')
        const undispatched = saved.state.dispatchPhase && saved.state.dispatchPhase !== 'dispatched'
          && saved.state.reservationOwner !== this.ports.incarnationId
        const state = undispatched ? { ...saved.state, status: 'failed' as const,
          message: 'The worker stopped before native dispatch.' } : resident.manager.reconcileCompaction
          ? await resident.manager.reconcileCompaction(resident.session, saved.state) : saved.state
        return { compaction: await this.ports.journal.saveSessionControl(frame.intent.operationId, state), status }
      }
      if (!resident.manager.compactSession) throw new Error('Native compact is unavailable')
      const input = { requestId: frame.requestId, clientCorrelationId: frame.clientCorrelationId }
      const reserved = await this.ports.journal.reserveSessionControl(frame.intent.operationId, input, frame.native)
      if (!reserved.dispatch) return { compaction: reserved.state, status }
      let result = reserved.state
      let dispatched = false
      try {
        await this.ports.authorize(resident.intent, resident.placement, 'control')
        result = await resident.manager.compactSession(resident.session, { ...input,
          onProgress: async state => {
            result = { ...result, ...state }
            await this.ports.journal.saveSessionControl(frame.intent.operationId, result)
          }, onDispatch: async () => {
            result = { ...result, dispatchPhase: 'dispatched' }
            await this.ports.journal.saveSessionControl(frame.intent.operationId, result)
            dispatched = true
          } }, resident.controller.signal)
      } catch (error) {
        const definite = !dispatched || error && typeof error === 'object' && 'certainty' in error && error.certainty === 'definite'
        result = { ...result, status: definite ? 'failed' : 'uncertain', message: 'Read the original worker compaction to recover its outcome.' }
      }
      return { compaction: await this.ports.journal.saveSessionControl(frame.intent.operationId, result), status }
    }
    if (frame.method === 'reconcile-response') {
      const resident = await this.resident(frame.intent.operationId, 'read')
      // Settlement retains the last provider history before closing its runtime.
      // The caller still verifies the exact decision against that original source.
      let history = resident.settlementHistory
      if (!history) {
        if (!resident.manager.reconcileResponse) throw new Error('Exact native response recovery unavailable')
        history = await resident.manager.reconcileResponse(resident.session, frame.response)
      }
      return this.historyPages.remember({ ...startNativeHistoryDownload(history, { downloadId: frame.downloadId }),
        status: await this.ports.journal.status(frame.intent.operationId) }, frame.intent, frame.placement)
    }
    if (frame.method === 'control') return this.control(frame.command, frame)
    if (frame.method === 'prepare-review') {
      const resident = await this.resident(frame.intent.operationId, 'read')
      await this.authorizeReview(resident, frame.review)
      return this.ports.journal.status(frame.intent.operationId)
    }
    if (frame.method === 'start-turn') return this.startTurn(frame.intent.operationId, frame.prompt,
      frame.correlationId, frame.review, frame.sessionMode, frame)
    if (frame.method === 'settle-turn') {
      const resident = await this.resident(frame.intent.operationId, 'start')
      await resident.turn
      const history = resident.settlementHistory
        ?? await resident.manager.reconcile(resident.session, frame.correlationId)
      if (history.terminalTurn?.correlationId !== frame.correlationId
        || history.terminalTurn.providerId !== frame.nativeTurnId || history.pendingInteraction
        || history.pendingInteractions.length) throw new Error('Output validation requires the completed original turn')
      await this.ports.journal.completeOutputValidation(frame.intent.operationId, frame.correlationId, frame.nativeTurnId)
      await this.settle(resident, frame.correlationId)
      return this.ports.journal.status(frame.intent.operationId)
    }
    if (frame.method === 'status') return this.status(frame.intent.operationId)
    if (frame.method === 'physical-readout' || frame.method === 'physical-ack') throw new Error('Actual installed physical readout is unavailable on this generic execution host.')
    if (frame.method === 'receipt-continuation') throw new Error('Receipt continuations require the installed response owner.')
    if (frame.method === 'get-application-access') throw new Error('Application lease recovery requires the installed physical owner')
    if (frame.method === 'history') {
      if (frame.metadata) return this.historyPages.read(frame)
      const result = await this.read(frame.intent.operationId, 'history', frame.correlationId, frame.afterSequence) as {
        history: NativeHistory; context: ContextSnapshot | null;
        status: Awaited<ReturnType<RemoteOperationJournal['status']>>
      }
      const after = result.status.status === 'known' && frame.correlationId
        ? result.status.receipt.reviewTurns?.find(turn => turn.assignment.correlationId === frame.correlationId)?.afterSequence : undefined
      return this.historyPages.remember({ ...startNativeHistoryDownload(result.history, {
        afterSequence: frame.afterSequence ?? after, downloadId: frame.downloadId }),
        context: result.context, status: result.status }, frame.intent, frame.placement)
    }
    return this.read(frame.intent.operationId, frame.method)
  }
  async inspect(raw: { intent: unknown; placement: unknown; configuration: unknown; executionPlacement?: NativeExecutionPlacement | undefined }, method: 'capabilities' | 'inspectMcp') {
    if (this.closing) throw new Error('Worker execution host is shutting down.')
    const intent = DispatchIntentSchema.parse(raw.intent), placement = readPlacement(raw.placement), configuration = AgentConfigurationVersionSchema.parse(raw.configuration)
    const harness = executableHarness(configuration.harness.harness)
    if (placement.hostRef.kind !== 'device' || placement.hostRef.deviceId !== this.ports.connection.deviceId || placement.mainId !== this.ports.connection.mainId
      || intent.bindingHash !== placement.bindingHash || placement.payload.kind !== 'agent' || placement.payload.agentId !== configuration.agentId
      || placement.payload.agentConfigurationVersionId !== configuration.id) throw new Error('Remote discovery binding mismatch')
    await this.ports.authorize(intent, placement, 'read')
    const executionPlacement = 'kind' in placement.source && placement.source.kind === 'pending'
      ? readNativeExecutionBinding(placement, intent, raw.executionPlacement) : undefined
    this.bindings.set(intent.operationId, { intent, placement })
    await this.ports.journal.accept(intent, this.ports.connection, this.ports.incarnationId)
    const controller = new AbortController()
    const controllers = this.inspections.get(intent.operationId) ?? new Set<AbortController>()
    controllers.add(controller); this.inspections.set(intent.operationId, controllers)
    try {
      const context = { executionId: intent.executionId, agentId: configuration.agentId,
        harness, configuration,
        workingDirectory: executionPlacement?.workingTree.canonicalCwd ?? placement.destination.canonicalCwd }
      const resolved = this.ports.managers.resolve(context)
      if (this.closing) throw new Error('Worker execution host is shutting down.')
      this.allocatedManagers.set(intent.operationId, { manager: resolved.manager, context })
      return await resolved.manager[method](controller.signal)
    } finally { controllers.delete(controller); if (!controllers.size) this.inspections.delete(intent.operationId) }
  }
  prepare(raw: WorkflowPreparation) {
    const intent = DispatchIntentSchema.parse(raw.intent)
    // Main replays the same prepare when a dropped device link lost its reply; the replay joins the original.
    const inFlight = this.inFlightPreparations.get(intent.operationId)
    if (inFlight) {
      if (isDeepStrictEqual(inFlight.raw, raw)) return inFlight.task
      return Promise.reject(new Error('Remote preparation binding mismatch'))
    }
    const controller = new AbortController()
    this.launchControllers.set(intent.operationId, controller)
    const task = this.track(() => this.prepareOwned(raw, controller)).finally(() => {
      this.launchControllers.delete(intent.operationId)
    })
    this.inFlightPreparations.set(intent.operationId, { raw, task })
    const entries = this.pendingEntries.get(intent.operationId) ?? new Set<Promise<unknown>>()
    entries.add(task)
    this.pendingEntries.set(intent.operationId, entries)
    const completed = () => {
      entries.delete(task)
      if (!entries.size) this.pendingEntries.delete(intent.operationId)
      if (this.inFlightPreparations.get(intent.operationId)?.task === task) this.inFlightPreparations.delete(intent.operationId)
    }
    void task.then(completed, completed)
    return task
  }
  async abortPreparation(operationId: string): Promise<void> {
    this.launchControllers.get(operationId)?.abort(new Error('Original native preparation requires recovery.'))
    for (const controller of this.inspections.get(operationId) ?? []) controller.abort()
    await Promise.allSettled(this.pendingEntries.get(operationId) ?? [])
  }
  private async prepareOwned(raw: WorkflowPreparation, controller: AbortController) {
    const intent = DispatchIntentSchema.parse(raw.intent), placement = readPlacement(raw.placement), request = HarnessExecutionRequestSchema.parse(raw.request)
    const harness = executableHarness(request.configuration.harness.harness)
    const executionPlacement = 'kind' in placement.source && placement.source.kind === 'pending'
      ? readNativeExecutionBinding(placement, intent, raw.executionPlacement) : undefined
    if (placement.hostRef.kind !== 'device' || placement.hostRef.deviceId !== this.ports.connection.deviceId
      || placement.mainId !== this.ports.connection.mainId || placement.bindingHash !== intent.bindingHash
      || placement.runId !== intent.runId || placement.nodeId !== intent.nodeId || placement.payload.kind !== 'agent'
      || placement.payload.agentConfigurationVersionId !== request.configuration.id || placement.payload.agentId !== request.configuration.agentId
      || request.executionId !== intent.executionId || request.runId !== intent.runId || request.workflowNodeId !== intent.nodeId
      || request.workingDirectory !== (executionPlacement?.workingTree.canonicalCwd ?? placement.destination.canonicalCwd)
      || intent.inputDigest !== `sha256:${createHash('sha256').update(canonicalGraphJson(request.input)).digest('hex')}`) throw new Error('Remote launch binding mismatch')
    await this.ports.authorize(intent, placement, 'start', controller.signal)
    assertRuntimeLeafPath(request.runtimeDirectory, placement)
    assertRuntimeLeafBinding(await this.ports.attestRuntimeLeaf(intent, placement, request, executionPlacement, controller.signal), request.runtimeDirectory, intent, placement, executionPlacement)
    this.bindings.set(intent.operationId, { intent, placement })
    await this.ports.journal.accept(intent, this.ports.connection, this.ports.incarnationId)
    const existing = this.residents.get(intent.operationId)
    if (existing) return { session: existing.session, status: await this.ports.journal.status(intent.operationId) }
    const reservation = await this.ports.journal.reserveEntry(intent.operationId)
    if (!reservation.reserved) throw new Error('Original native execution requires reconciliation')
    if (this.closing) throw new Error('Worker execution host is shutting down.')
    try {
      const access = raw.applicationAccess
      if (access && (access.executionId !== intent.executionId || access.agentId !== request.configuration.agentId || access.operationId !== intent.operationId
        || access.attemptId !== intent.attemptId || access.bindingHash !== intent.bindingHash)) throw new Error('Wrong main worker MCP lease binding')
      const environment = await this.ports.preflight(request, access, controller.signal)
      if ((environment?.variables.GRAPHQL_MCP_TOKEN ?? undefined) !== access?.token) throw new Error('Worker must reuse the exact main-owned application lease')
      if (environment && environment.agentId !== request.configuration.agentId) throw new Error('Wrong worker-local credential owner')
      await this.ports.authorize(intent, placement, 'start', controller.signal)
      const before = await this.ports.journal.status(intent.operationId)
      if (before.status !== 'known' || before.receipt.stopFence) throw new Error('Remote launch stopped before native submission')
      const context = { executionId: intent.executionId, agentId: request.configuration.agentId,
        harness, configuration: request.configuration,
        workingDirectory: request.workingDirectory }
      const resolved = this.ports.managers.resolve(context)
      controller.signal.throwIfAborted()
      this.allocatedManagers.set(intent.operationId, { manager: resolved.manager, context })
      resolved.beginStart?.()
      if (raw.sessionPreferences) await resolved.manager.configureSessionPreferences?.(raw.sessionPreferences)
      if (raw.sessionContinuation) {
        const continuation = raw.sessionContinuation
        const previous = continuation.previousOperationId
          ? await this.ports.journal.status(continuation.previousOperationId) : undefined
        if (previous?.status !== 'known' || previous.receipt.phase !== 'confirmed_terminal'
          || !previous.receipt.terminal || !previous.receipt.native
          || previous.receipt.intent.executionId !== continuation.previousExecutionId
          || previous.receipt.intent.executionId === intent.executionId
          || previous.receipt.intent.runId !== intent.runId || previous.receipt.intent.nodeId !== intent.nodeId
          || previous.receipt.intent.bindingHash !== intent.bindingHash
          || previous.receipt.native?.sessionId !== continuation.session.nativeSessionId
          || continuation.session.harness !== harness) {
          throw new Error('Session continuation requires the closed execution on the same host and placement.')
        }
      }
      const session = await resolved.manager.createSession({ request, correlationId: `execution:${intent.executionId}`,
        ...(raw.sessionContinuation ? { sessionContinuation: raw.sessionContinuation } : {}),
        ...(environment ? { environment } : {}) }, controller.signal)
      if (raw.sessionContinuation && !isDeepStrictEqual(session, raw.sessionContinuation.session)) {
        throw new Error('Session continuation returned another native session.')
      }
      resolved.markResident?.()
      const native = await this.ports.nativeEvidence(intent, session, { manager: resolved.manager, request, signal: controller.signal })
      if (native.sessionId !== session.nativeSessionId) throw new Error('Native session attestation mismatch')
      const receipt = await this.ports.journal.acknowledgeStart(intent.operationId, native)
      const resident = { intent, placement, request, manager: resolved.manager, session, controller }
      this.residents.set(intent.operationId, resident)
      if (receipt.stopFence) await resident.manager.cancel(session)
      return { session, status: await this.ports.journal.status(intent.operationId) }
    } catch (error) { await this.ports.journal.uncertain(intent.operationId, 'Native session preparation acknowledgment unavailable'); throw error }
  }
  /** Observation of the existing lifetime only; never invokes provider attach,
   * which may start another process even for the same saved native thread. */
  private async reattach(raw: { intent: DispatchIntent; placement: AcceptedNodePlacement; request: HarnessExecutionRequest; session: NativeSessionReference }) {
    const resident = await this.resident(raw.intent.operationId, 'read')
    if (!isDeepStrictEqual(resident.intent, raw.intent) || !isDeepStrictEqual(resident.placement, raw.placement)
      || !isDeepStrictEqual(resident.request, raw.request) || !isDeepStrictEqual(resident.session, raw.session)) throw new Error('Original reattachment binding mismatch')
    const status = await this.ports.journal.status(raw.intent.operationId)
    if (status.status !== 'known' || !status.receipt.native
      || status.receipt.native.sessionId !== raw.session.nativeSessionId
      || !isDeepStrictEqual(status.receipt.intent, raw.intent)) {
      throw new Error('Original resident lifetime requires reconciliation')
    }
    if (status.receipt.terminal) {
      if (status.receipt.phase !== 'confirmed_terminal') throw new Error('Original terminal closure is unconfirmed')
      await this.ports.authorize(raw.intent, resident.placement, 'read')
      const current = await this.ports.journal.status(raw.intent.operationId)
      if (!isDeepStrictEqual(current, status)) throw new Error('Original terminal reattachment owner changed')
      return { session: structuredClone(resident.session), status: current }
    }
    const native = await this.ports.nativeEvidence(raw.intent, raw.session, { manager: resident.manager, request: resident.request, signal: resident.controller.signal })
    if (native.sessionId !== status.receipt.native.sessionId || native.processIdentityDigest !== status.receipt.native.processIdentityDigest
      || native.turnId !== undefined && native.turnId !== status.receipt.native.turnId) throw new Error('Reattachment replaced original native lifetime')
    await this.ports.authorize(raw.intent, resident.placement, 'read')
    const current = await this.ports.journal.status(raw.intent.operationId)
    if (current.status !== 'known' || !isDeepStrictEqual(current.receipt.intent, raw.intent)
      || !isDeepStrictEqual(current.receipt.native, status.receipt.native) || current.receipt.terminal) throw new Error('Original reattachment owner changed')
    if (current.receipt.phase === 'uncertain') {
      const confirmed = await this.ports.journal.confirmRecovered(raw.intent.operationId, current.receipt.native!)
      if (!isDeepStrictEqual(confirmed.intent, raw.intent)) throw new Error('Original reattachment owner changed')
      return { session: structuredClone(resident.session), status: { status: 'known' as const, receipt: confirmed } }
    }
    return { session: structuredClone(resident.session), status: current }
  }
  recover(raw: { intent: DispatchIntent; placement: AcceptedNodePlacement; request: HarnessExecutionRequest; session: NativeSessionReference; evidenceDigest: string; executionPlacement?: NativeExecutionPlacement }) {
    return this.track(() => this.recoverOwned(raw))
  }
  private async recoverOwned(raw: { intent: DispatchIntent; placement: AcceptedNodePlacement; request: HarnessExecutionRequest; session: NativeSessionReference; evidenceDigest: string; executionPlacement?: NativeExecutionPlacement }) {
    const status = await this.ports.journal.status(raw.intent.operationId)
    if (status.status !== 'known' || !status.receipt.native || !this.ports.verifyRecovery
      || status.receipt.terminal || !isDeepStrictEqual(status.receipt.intent, raw.intent)
      || status.receipt.native.sessionId !== raw.session.nativeSessionId) throw new Error('Original native recovery evidence required')
    const placement = readPlacement(raw.placement), request = HarnessExecutionRequestSchema.parse(raw.request)
    const harness = executableHarness(request.configuration.harness.harness)
    const executionPlacement = 'kind' in placement.source && placement.source.kind === 'pending'
      ? readNativeExecutionBinding(placement, raw.intent, raw.executionPlacement) : undefined
    if (placement.hostRef.kind !== 'device' || placement.hostRef.deviceId !== this.ports.connection.deviceId
      || placement.mainId !== this.ports.connection.mainId || placement.runId !== raw.intent.runId || placement.nodeId !== raw.intent.nodeId
      || placement.bindingHash !== raw.intent.bindingHash || placement.payload.kind !== 'agent'
      || placement.payload.agentConfigurationVersionId !== request.configuration.id || placement.payload.agentId !== request.configuration.agentId
      || request.executionId !== raw.intent.executionId || request.runId !== raw.intent.runId || request.workflowNodeId !== raw.intent.nodeId
      || raw.session.harness !== request.configuration.harness.harness
      || request.workingDirectory !== (executionPlacement?.workingTree.canonicalCwd ?? placement.destination.canonicalCwd)
      || raw.intent.inputDigest !== `sha256:${createHash('sha256').update(canonicalGraphJson(request.input)).digest('hex')}`) throw new Error('Recovery binding mismatch')
    await this.ports.authorize(raw.intent, placement, 'read')
    assertRuntimeLeafPath(request.runtimeDirectory, placement)
    assertRuntimeLeafBinding(await this.ports.attestRuntimeLeaf(raw.intent, placement, request, executionPlacement), request.runtimeDirectory, raw.intent, placement, executionPlacement)
    await this.ports.verifyRecovery(status.receipt, raw.session, raw.evidenceDigest)
    const existing = this.residents.get(raw.intent.operationId)
    if (existing && (!isDeepStrictEqual(existing.request, request) || !isDeepStrictEqual(existing.session, raw.session)
      || !isDeepStrictEqual(existing.placement, placement))) throw new Error('Recovery changed original resident')
    const resolved = this.ports.managers.resolve({ executionId: raw.intent.executionId, agentId: request.configuration.agentId,
      harness, configuration: request.configuration, workingDirectory: request.workingDirectory })
    // A saved provider thread is not the surviving original physical lifetime.
    // Cold attachment may launch a replacement process: never call it here.
    if (resolved.processState !== 'resident') throw new Error('Original resident native lifetime required; cold recovery unavailable')
    const controller = existing?.controller ?? new AbortController()
    const native = await this.ports.nativeEvidence(raw.intent, raw.session, { manager: resolved.manager, request, signal: controller.signal })
    if (native.sessionId !== status.receipt.native.sessionId || native.processIdentityDigest !== status.receipt.native.processIdentityDigest
      || native.turnId !== undefined && native.turnId !== status.receipt.native.turnId) throw new Error('Recovery replaced original native lifetime')
    await this.ports.authorize(raw.intent, placement, 'read')
    const current = await this.ports.journal.status(raw.intent.operationId)
    if (current.status !== 'known' || !isDeepStrictEqual(current.receipt.intent, raw.intent)
      || !isDeepStrictEqual(current.receipt.native, status.receipt.native) || current.receipt.terminal) throw new Error('Original recovery owner changed')
    const confirmed = await this.ports.journal.confirmRecovered(raw.intent.operationId, current.receipt.native!)
    if (!isDeepStrictEqual(confirmed.intent, raw.intent)) throw new Error('Original recovery owner changed')
    this.bindings.set(raw.intent.operationId, { intent: raw.intent, placement })
    this.residents.set(raw.intent.operationId, existing ?? { intent: raw.intent, placement, request, manager: resolved.manager, session: raw.session, controller })
    if (confirmed.stopFence) await resolved.manager.cancel(raw.session, undefined, confirmed.native!.turnId)
    return { session: raw.session, status: await this.ports.journal.status(raw.intent.operationId) }
  }
  /** Invoke on credential policy refresh/revocation; offline requested cancellation stays non-terminal. */
  async refreshAuthority() {
    for (const resident of this.residents.values()) {
      try { await this.ports.authorize(resident.intent, resident.placement, 'start') }
      catch {
        await this.ports.journal.revokeFence(resident.intent.operationId)
        resident.controller.abort(); resident.manager.stopAutomaticResponses?.(resident.session)
        try { await resident.manager.cancel(resident.session); await this.settle(resident, `execution:${resident.intent.executionId}`) }
        catch { await this.ports.journal.uncertain(resident.intent.operationId, 'Revoked authority; original native cancellation unconfirmed') }
      }
    }
  }
  private async resident(operationId: string, action: 'start' | 'read' | 'control') {
    const resident = this.residents.get(operationId)
    if (!resident) throw new Error('Original native owner requires reconciliation')
    await this.ports.authorize(resident.intent, resident.placement, action)
    return resident
  }
  private async authorizeReview(resident: Resident, review: RemoteReviewerRequest) {
    if (!this.ports.authorizeReview
      || (resident.request.configuration.productRole !== 'master' && resident.request.configuration.productRole !== 'orchestrator')
      || !isDeepStrictEqual(resident.session, review.session)
      || resident.request.configuration.agentId !== review.reviewerAgentId) throw new Error('Reviewer session binding mismatch')
    await this.ports.authorizeReview(resident.intent, resident.placement, review)
    await this.ports.journal.loadReviewTurn(resident.intent.operationId, review.correlationId)
  }
  startTurn(operationId: string, prompt: string, correlationId: string, review?: RemoteReviewerRequest,
    sessionMode?: SessionMode, output?: Pick<NativeTurnInput, 'outputSchema' | 'deferSettlement'>) {
    return this.track(() => this.startTurnOwned(operationId, prompt, correlationId, review, sessionMode, output))
  }
  private async startTurnOwned(operationId: string, prompt: string, correlationId: string, review?: RemoteReviewerRequest,
    sessionMode?: SessionMode, output?: Pick<NativeTurnInput, 'outputSchema' | 'deferSettlement'>) {
    const resident = await this.resident(operationId, review ? 'read' : 'start')
    if (review) return this.startReviewTurn(resident, prompt, correlationId, review)
    if (!prompt || prompt.length > 1_000_000) throw new Error('Native turn correlation mismatch')
    const before = await this.ports.journal.status(operationId)
    if (before.status !== 'known') throw new Error('Original workflow turn is unavailable')
    const correcting = before.receipt.turnInput !== undefined && before.receipt.turnInput.correlationId !== correlationId
    if (!before.receipt.turnInput && correlationId !== `execution:${resident.intent.executionId}`)
      throw new Error('Native turn correlation mismatch')
    if (correcting) await resident.turn
    const history = correcting ? await resident.manager.reconcile(resident.session, before.receipt.turnInput!.correlationId) : undefined
    const outputSchema = output?.outputSchema ? OutputSchemaSchema.parse(output.outputSchema) : undefined
    const reserved = await this.ports.journal.reserveTurn(operationId, {
      correlationId, promptDigest: createHash('sha256').update(prompt).digest('hex'), sessionMode: sessionMode ?? 'regular',
      ...(outputSchema ? { outputSchemaDigest: createHash('sha256').update(canonicalJson(outputSchema)).digest('hex') } : {}),
      ...(output?.deferSettlement ? { deferSettlement: output.deferSettlement } : {}),
    }, history)
    if (!reserved.reserved) return this.ports.journal.status(operationId)
    delete resident.settlementHistory
    delete resident.workflowHistory
    resident.turn = (async () => {
      try {
        await this.ports.authorize(resident.intent, resident.placement, 'start')
        const status = await this.ports.journal.status(operationId)
        if (status.status !== 'known' || status.receipt.stopFence) return
        let retry: { previousTurnId: string } | undefined = correcting && before.receipt.native?.turnId
          ? { previousTurnId: before.receipt.native.turnId } : undefined
        for await (const event of resident.manager.startTurn(resident.session, {
          prompt, clientCorrelationId: correlationId, ...(sessionMode ? { sessionMode } : {}),
          ...(outputSchema ? { outputSchema } : {}),
          onRetry: async previousTurnId => {
            await this.ports.authorize(resident.intent, resident.placement, 'start')
            const current = await this.ports.journal.status(operationId)
            if (current.status !== 'known' || current.receipt.stopFence) {
              resident.controller.abort(new Error('Execution stopped during capacity wait'))
              return
            }
            retry = { previousTurnId }
          },
          onSubmitted: async turnId => {
            await this.ports.journal.acknowledgeTurn(operationId, turnId, retry)
            retry = undefined
            const current = await this.ports.journal.status(operationId)
            if (current.status === 'known' && current.receipt.stopFence) {
              await resident.manager.cancel(resident.session, undefined, turnId)
            } else await this.ports.journal.markRunning(operationId)
          },
        }, resident.controller.signal)) { void event }
        await this.settle(resident, correlationId)
      } catch {
        try {
          await this.ports.journal.uncertain(operationId, 'Native turn acknowledgment or closure unavailable')
        } catch (journalError) {
          logIgnoredError('engine', 'record uncertain native turn', journalError, { operationId })
        }
      }
    })()
    return this.ports.journal.status(operationId)
  }
  private async startReviewTurn(resident: Resident, prompt: string, correlationId: string, review: RemoteReviewerRequest) {
    if (review.correlationId !== correlationId || !prompt || prompt.length > 1_000_000)
      throw new Error('Reviewer correlation mismatch')
    await this.authorizeReview(resident, review)
    const operationId = resident.intent.operationId
    const before = await resident.manager.history(resident.session)
    const afterSequence = before.nextSequence === undefined ? before.events.at(-1)?.sequence ?? -1 : before.nextSequence - 1
    const reserved = await this.ports.journal.reserveReviewTurn(operationId,
      RemoteReviewerAssignmentSchema.strip().parse(review), createHash('sha256').update(prompt).digest('hex'), afterSequence)
    if (!reserved.reserved) return this.ports.journal.status(operationId)
    await this.authorizeReview(resident, review)
    if (!await this.ports.journal.enterReviewTurn(operationId, correlationId)) return this.ports.journal.status(operationId)
    delete resident.settlementHistory
    resident.turn = (async () => {
      try {
        for await (const event of resident.manager.startTurn(resident.session, { prompt, clientCorrelationId: correlationId,
          onSubmitted: async providerId => {
            await this.ports.journal.acknowledgeReviewTurn(operationId, correlationId, providerId)
            const status = await this.ports.journal.status(operationId)
            if (status.status === 'known' && status.receipt.stopFence)
              await resident.manager.cancel(resident.session, undefined, providerId)
          } }, resident.controller.signal)) { void event }
        const history = await resident.manager.reconcile(resident.session, correlationId)
        await this.ports.journal.settleReviewTurn(operationId, history)
      } catch {
        await this.ports.journal.uncertain(operationId, 'Original review turn acknowledgement or settlement unavailable')
      }
    })()
    return this.ports.journal.status(operationId)
  }
  private async settle(resident: Resident, correlationId: string): Promise<void> {
    if (resident.settlementTask) {
      const settled = await resident.settlementTask
      if (settled.stopFence) return
      const current = await this.ports.journal.status(resident.intent.operationId)
      // Stop can arrive after the pending pass chose to retain this process.
      // Finish the fenced closure after that pass drains, without overlapping it.
      if (current.status === 'known' && current.receipt.stopFence && !current.receipt.terminal) {
        return this.settle(resident, correlationId)
      }
      return
    }
    const task = (async () => {
      const status = await this.ports.journal.status(resident.intent.operationId)
      const settled = { stopFence: status.status === 'known' && status.receipt.stopFence }
      if (status.status === 'known' && status.receipt.terminal) return settled
      const history = resident.settlementHistory ?? resident.workflowHistory ?? await resident.manager.reconcile(resident.session, correlationId)
      // Preserve the actual last provider snapshot before a closure producer removes its runtime.
      if (history.terminalTurn?.correlationId === correlationId || (history.correlationId === correlationId && history.terminalResult)) resident.settlementHistory = structuredClone(history)
      if (status.status === 'known' && status.receipt.turnInput?.deferSettlement
        && !status.receipt.outputValidationComplete && !status.receipt.stopFence) return settled
      const evidence = resident.settlementEvidence ?? await this.ports.settle(resident.intent, history, resident)
      const retained = await this.ports.journal.status(resident.intent.operationId)
      if (retained.status === 'known' && retained.receipt.retainedReviewer
        && correlationId === retained.receipt.turnInput?.correlationId) resident.workflowHistory = structuredClone(history)
      if (evidence) {
        resident.settlementHistory = structuredClone(history)
        resident.settlementEvidence = structuredClone(evidence)
        await this.ports.journal.terminal(resident.intent.operationId, evidence)
      }
      return settled
    })()
    resident.settlementTask = task
    void task.then(() => { if (resident.settlementTask === task) delete resident.settlementTask }, () => { if (resident.settlementTask === task) delete resident.settlementTask })
    await task
  }
  async closeRetainedReviewer(operationId: string, expiredReviewer?: { sequence: number }): Promise<boolean> {
    const resident = this.residents.get(operationId)
    const status = await this.ports.journal.status(operationId)
    if (!resident || status.status !== 'known' || !status.receipt.retainedReviewer
      || status.receipt.terminal || !isDeepStrictEqual(status.receipt.intent, resident.intent))
      throw new Error('Original retained reviewer owner unavailable')
    const fenced = await this.ports.journal.revokeFence(operationId, expiredReviewer)
    if (!fenced.stopFence || fenced.terminal) return false
    await this.cancelResident(resident)
    await this.settle(resident, `execution:${resident.intent.executionId}`)
    return true
  }
  private cancelResident(resident: Resident, nativeTurnId?: string): Promise<void> {
    if (resident.cancellation) return resident.cancellation
    resident.controller.abort()
    resident.manager.stopAutomaticResponses?.(resident.session)
    const cancellation = resident.manager.cancel(resident.session, undefined, nativeTurnId).then(() => undefined)
    // A Stop fence prevents another turn; keep successful cancellation while physical settlement closes this session.
    resident.cancellation = cancellation
    void cancellation.catch(() => {
      // ignore: the caller receives the failure; a later Stop can retry this original session.
      if (resident.cancellation === cancellation) delete resident.cancellation
    })
    return cancellation
  }
  async read(operationId: string, method: 'history' | 'pending' | 'capabilities' | 'inspectMcp',
    correlationId?: string, afterSequence?: number) {
    const resident = await this.resident(operationId, 'read')
    const recorded = await this.ports.journal.status(operationId)
    const workflowCorrelation = recorded.status === 'known'
      ? recorded.receipt.turnInput?.correlationId ?? `execution:${resident.intent.executionId}` : `execution:${resident.intent.executionId}`
    if (correlationId && correlationId !== workflowCorrelation) {
      await this.ports.journal.loadReviewTurn(operationId, correlationId)
    }
    const status = await this.ports.journal.status(operationId)
    const correlation = correlationId ?? (status.status === 'known'
      ? status.receipt.reviewTurns?.at(-1)?.assignment.correlationId : undefined) ?? workflowCorrelation
    if (correlation !== workflowCorrelation && (status.status !== 'known'
      || !status.receipt.reviewTurns?.some(turn => turn.assignment.correlationId === correlation)))
      throw new Error('Unknown reviewer reconciliation correlation')
    if (resident.settlementEvidence) await this.settle(resident, `execution:${resident.intent.executionId}`)
    if (method === 'history') {
      const review = status.status === 'known'
        ? status.receipt.reviewTurns?.find(turn => turn.assignment.correlationId === correlation) : undefined
      const workflow = correlation === workflowCorrelation && status.status === 'known'
        ? status.receipt.retainedReviewer : undefined
      let history: NativeHistory
      // Context usage is observed only from a live provider runtime, before settlement closes it.
      let context: ContextSnapshot | null = null
      if (workflow) {
        if (!resident.workflowHistory) throw new Error('Original workflow history requires durable recovery')
        history = structuredClone(resident.workflowHistory)
      } else {
        const archived = review?.settled ? await this.ports.journal.reviewHistory(operationId, correlation) : undefined
        if (archived) history = archived
        else if (resident.settlementHistory) history = structuredClone(resident.settlementHistory)
        else {
          const starting = !review && status.status === 'known' && status.receipt.phase === 'start_acknowledged'
            && (!status.receipt.native?.turnId || status.receipt.native.turnId === status.receipt.resultRepairs?.at(-1)?.previousTurnId)
            && resident.turn !== undefined
          // MCP startup can emit events before there is a submitted native turn to reconcile.
          if (starting) history = await resident.manager.history(resident.session)
          else if (afterSequence !== undefined && resident.manager.reconcileHistoryPage) {
            history = await resident.manager.reconcileHistoryPage(resident.session, correlation, afterSequence)
          } else history = await resident.manager.reconcile(resident.session, correlation)
          context = resident.manager.contextSnapshot?.(resident.session) ?? null
        }
      }
      if (!workflow && correlation === workflowCorrelation && history.terminalTurn?.correlationId === correlation)
        await this.settle(resident, correlation)
      if (review && history.correlationId === correlation && history.nativeTurnId) {
        await this.ports.journal.acknowledgeReviewTurn(operationId, correlation, history.nativeTurnId)
        if (history.terminalTurn?.correlationId === correlation) await this.ports.journal.settleReviewTurn(operationId, history)
      }
      return { context, history, status: await this.ports.journal.status(operationId) }
    }
    if (method === 'pending') return resident.settlementHistory
      ? resident.settlementHistory.pendingInteraction ?? resident.settlementHistory.pendingInteractions[0] : resident.manager.pending(resident.session)
    return resident.manager[method]()
  }
  async control(raw: unknown, binding?: { intent: DispatchIntent; placement: AcceptedNodePlacement }) {
    const command = RemoteOwnerControlSchema.parse(raw)
    const action = command.action.kind === 'stop' ? 'stop' : 'control'
    if (binding) {
      const intent = DispatchIntentSchema.parse(binding.intent), placement = readPlacement(binding.placement)
      if (intent.operationId !== command.operationId || intent.bindingHash !== placement.bindingHash
        || placement.hostRef.kind !== 'device' || placement.hostRef.deviceId !== this.ports.connection.deviceId
        || placement.mainId !== this.ports.connection.mainId) throw new Error('Control placement mismatch')
      await this.ports.authorize(intent, placement, action)
      this.bindings.set(command.operationId, { intent, placement })
      await this.ports.journal.accept(intent, this.ports.connection, this.ports.incarnationId)
    }
    const owned = this.bindings.get(command.operationId)
    if (!owned) throw new Error('Original control owner requires reconciliation')
    await this.ports.authorize(owned.intent, owned.placement, action)
    const resident = this.residents.get(command.operationId)
    if (!resident) {
      if (command.action.kind !== 'stop') throw new Error('Original native question unavailable')
      await this.ports.journal.control(command)
      this.launchControllers.get(command.operationId)?.abort()
      for (const controller of this.inspections.get(command.operationId) ?? []) controller.abort()
      return this.ports.journal.status(command.operationId)
    }
    const delivery = await this.ports.journal.controlDelivery(command)
    if (delivery === 'acknowledged' && command.action.kind === 'stop') {
      await this.settle(resident, `execution:${resident.intent.executionId}`)
      return this.ports.journal.status(command.operationId)
    }
    if (command.action.kind !== 'stop' && (delivery === 'entered' || delivery === 'acknowledged')) {
      return this.ports.journal.status(command.operationId)
    }
    if (command.action.kind === 'respond') {
      const history = await resident.manager.history(resident.session)
      const requestId = command.action.nativeInteractionId
      const pending = history.pendingInteractions.find(candidate => candidate.turn.nativeRequestId === requestId
        && isDeepStrictEqual(candidate.session, resident.session)
        && candidate.session.nativeSessionId === command.native?.sessionId
        && candidate.turn.nativeTurnId === command.native?.turnId)
      const requestDelivery = history.interactionDeliveries?.find(candidate => candidate.nativeRequestId === requestId)
      if (!pending || requestDelivery && requestDelivery.state !== 'pending') {
        throw new Error('Original native question no longer pending')
      }
      const selectedOption = ApprovalResponseOptionSchema.parse(command.action.response)
      const offered = pending.responseOptions.find(option => option.optionId === selectedOption.optionId)
      if (!offered || !isDeepStrictEqual(withInteractionResponse(offered, selectedOption.response), selectedOption)) {
        throw new Error('Response option is not offered by the original native question')
      }
      await this.ports.journal.interaction(command.operationId, { interactionId: command.action.interactionId, interactionRevision: command.action.interactionRevision, nativeInteractionId: command.action.nativeInteractionId, native: command.native! })
    }
    const recorded = await this.ports.journal.control(command)
    if (recorded.receipt.terminal || !recorded.dispatch && delivery !== 'reserved'
      && !(command.action.kind === 'stop' && delivery === 'entered')) {
      return this.ports.journal.status(command.operationId)
    }
    await this.ports.authorize(resident.intent, resident.placement, action)
    if (delivery !== 'entered' && !await this.ports.journal.enterControlDelivery(command)) {
      return this.ports.journal.status(command.operationId)
    }
    try {
      if (command.action.kind === 'stop') await this.cancelResident(resident, remoteActiveNative(recorded.receipt)?.turnId)
      else await resident.manager.respond(resident.session, command.action.nativeInteractionId, ApprovalResponseOptionSchema.parse(command.action.response))
      await this.ports.journal.acknowledgeControl(command)
      await this.settle(resident, `execution:${resident.intent.executionId}`)
    } catch (error) {
      logIgnoredError('engine', 'settle remote native control', error,
        { code: 'REMOTE_CONTROL_UNCONFIRMED', operationId: command.operationId, action: command.action.kind })
      await this.ports.journal.uncertain(command.operationId, 'Native control acknowledgment unavailable')
    }
    return this.ports.journal.status(command.operationId)
  }
  async retireSettled(operationId: string) {
    if (!await this.ports.journal.isRetired(operationId)) throw new Error('Settled journal retirement required')
    const resident = this.residents.get(operationId)
    if (resident) {
      await resident.turn
      await resident.settlementTask
    }
    let allocation = this.allocatedManagers.get(operationId)
    if (!allocation && resident) {
      allocation = { manager: resident.manager, context: {
        executionId: resident.intent.executionId, agentId: resident.request.configuration.agentId,
        harness: executableHarness(resident.request.configuration.harness.harness), configuration: resident.request.configuration,
        workingDirectory: resident.request.workingDirectory,
      } }
    }
    if (allocation) {
      await allocation.manager.dispose?.()
      this.ports.managers.release?.(allocation.context, allocation.manager)
      this.allocatedManagers.delete(operationId)
    }
    this.residents.delete(operationId)
    this.bindings.delete(operationId)
  }
  async drain() { await Promise.all([...this.residents.values()].flatMap(resident => resident.turn ? [resident.turn] : [])) }
  status(operationId: string) { return this.ports.journal.status(operationId) }
}
