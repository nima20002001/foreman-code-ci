import { isWorkflowStart } from '../../src/modules/harnesses/sessionStart.js'
import {
  CODEX_APPROVAL_OPTIONS_FIXTURE, NativeHarnessEventSchema,
  type HarnessExecutionRequest, type NativeHarnessCapabilities, type NativeHarnessEvent, type NativeSessionReference,
  type PendingNativeInteraction,
} from '@foreman-code/contracts'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart } from '../../src/modules/harnesses/port.js'
import type { NativeResponseDeliveryEvidence } from '../../src/modules/interactions/delivery.js'
import { unavailableNativeResponse, type NativeResponseAvailabilityQuery, type NativeResponseAvailability } from '../../src/modules/harnesses/responseAvailability.js'

/** A deterministic external-provider port, NOT a replacement coordinator. State
 * survives construction of another API engine in this fixture. No native binary,
 * filesystem tool, model or BR1-002 normalized-evidence producer is simulated. */
export class CheckpointTestProvider implements NativeHarnessSessionManager {
  readonly harness = 'codex' as const
  readonly counts = { sessions: 0, starts: 0, responses: 0, attaches: 0 }
  readonly startedNodes: string[] = []
  readonly startedExecutions: string[] = []
  readonly closedSessions = new Set<string>()
  private readonly environments = new Map<string, Record<string, string>>()
  private readonly requests = new Map<string, HarnessExecutionRequest>()
  private readonly waits = new Map<string, PendingNativeInteraction[]>()
  private readonly terminals = new Map<string, NonNullable<NativeHistory['terminalResult']>>()
  private readonly continuationEvents = new Map<string, NativeHarnessEvent>()
  private readonly receipts = new Map<string, NativeResponseDeliveryEvidence[]>()
  private readonly histories = new Map<string, NativeHistory>()
  /** Fault/timing observation only; receives no SQL or authority capability. */
  beforeRespond?: () => Promise<void>
  beforeClose?: () => Promise<void>

  constructor(private readonly approvalNodes: ReadonlySet<string>, private readonly pendingPerExecution: 1 | 2 = 1,
    private readonly acknowledgeStarts = true, private readonly disconnectAfterStart = false,
    private readonly outputFor?: (nodeId: string, request: HarnessExecutionRequest) => NonNullable<NativeHistory['terminalResult']>['output']) {}

  connection(): NativeHarnessSessionManager {
    const startTurn = this.startTurn.bind(this)
    const sessions = new Map<string, NativeSessionReference>()
    let disposed = false
    const ownsLiveSession = (session: NativeSessionReference) => {
      const original = sessions.get(session.nativeSessionId)
      return !disposed && original?.harness === session.harness
        && original.providerVersion === session.providerVersion
        && !this.closedSessions.has(session.nativeSessionId)
    }
    const close = async (session: NativeSessionReference) => {
      await this.close(session)
      sessions.delete(session.nativeSessionId)
    }
    // Separate transport facades per execution; only external history is shared.
    return { harness: this.harness, capabilities: this.capabilities.bind(this), inspectMcp: this.inspectMcp.bind(this),
      createSession: async (input) => {
        if (disposed) throw new Error('The checkpoint connection is disposed')
        const session = await this.createSession(input)
        if (input.environment) this.environments.set(session.nativeSessionId, { ...input.environment.variables })
        sessions.set(session.nativeSessionId, session)
        return session
      },
      attachSession: async (reference, input) => {
        if (disposed) throw new Error('The checkpoint connection is disposed')
        const session = await this.attachSession(reference, input)
        sessions.set(session.nativeSessionId, session)
        return session
      },
      startTurn: async function* (session, input) {
        if (!ownsLiveSession(session)) throw new Error('The checkpoint connection does not own a live session')
        yield* startTurn(session, input)
      },
      originalEnvironment: async session => this.environments.get(session.nativeSessionId),
      pending: this.pending.bind(this), respond: this.respond.bind(this),
      inspectResponseAvailability: this.inspectResponseAvailability.bind(this),
      history: this.history.bind(this), reconcile: this.reconcile.bind(this),
      canDetachForRestart: session => {
        const request = this.requests.get(session.nativeSessionId)
        return ownsLiveSession(session) && !!request
          && !this.startedExecutions.includes(request.executionId)
          && !this.terminals.has(session.nativeSessionId)
      },
      cancel: this.cancel.bind(this), close, closeForRestart: close,
      dispose: async () => {
        disposed = true
        for (const session of sessions.values()) await this.close(session)
        sessions.clear()
      } }
  }
  async capabilities(): Promise<NativeHarnessCapabilities> {
    return { provider: this.harness, providerVersion: '0.154.0', persistentSessions: true,
      reconnect: true, sameRequestResponses: true, cancellation: true, history: true,
      configurationInspection: true, mcpDetection: true, supportedInteractionKinds: ['approval'] }
  }
  async inspectMcp() {
    return { harness: this.harness, serverName: 'graphql', state: 'connected' as const,
      endpointMatches: true, credentialEnvironmentVariable: null, checkedAt: new Date().toISOString() }
  }
  async createSession(input: NativeSessionStart): Promise<NativeSessionReference> {
    if (!isWorkflowStart(input)) throw new Error('The checkpoint fixture accepts only workflow requests')
    const continuation = input.sessionContinuation
    const session = continuation?.session
      ?? { harness: this.harness, providerVersion: '0.154.0', nativeSessionId: `native-${input.request.executionId}` }
    const previous = this.requests.get(session.nativeSessionId)
    if (continuation) {
      if (previous?.executionId !== continuation.previousExecutionId) throw new Error('Unknown session continuation')
      const correlationId = `execution:${previous.executionId}`
      this.histories.set(correlationId, structuredClone(await this.reconcile(session, correlationId)))
      this.closedSessions.delete(session.nativeSessionId)
      this.terminals.delete(session.nativeSessionId)
      this.continuationEvents.delete(session.nativeSessionId)
      this.waits.delete(session.nativeSessionId)
      this.receipts.delete(session.nativeSessionId)
    } else {
      if (previous) throw new Error('Duplicate native session creation')
      this.counts.sessions++
    }
    this.requests.set(session.nativeSessionId, input.request)
    return session
  }
  async attachSession(session: NativeSessionReference, input: NativeSessionStart): Promise<NativeSessionReference> {
    if (!isWorkflowStart(input) || !this.requests.has(session.nativeSessionId)) throw new Error('Unknown persisted provider session')
    const original = this.requests.get(session.nativeSessionId)!
    if (original.executionId !== input.request.executionId) throw new Error('Attachment changed the execution identity')
    this.counts.attaches++
    this.closedSessions.delete(session.nativeSessionId)
    return session
  }
  async *startTurn(session: NativeSessionReference, input: Parameters<NativeHarnessSessionManager['startTurn']>[1]): AsyncIterable<NativeHarnessEvent> {
    const request = this.requests.get(session.nativeSessionId)
    if (!request) throw new Error('Missing accepted provider request')
    // A repeat occurrence/new Run/technical attempt legitimately reuses a node.
    // Replaying the SAME accepted execution remains forbidden.
    if (this.startedExecutions.includes(request.executionId)) throw new Error('A predecessor/native turn was replayed')
    this.startedExecutions.push(request.executionId)
    this.startedNodes.push(request.workflowNodeId)
    this.counts.starts++
    const turnId = `turn-${request.executionId}`
    if (this.acknowledgeStarts) await input.onSubmitted?.(turnId)
    yield NativeHarnessEventSchema.parse({ sequence: 0, type: 'turn.started', occurredAt: new Date().toISOString(),
      payload: { turnId, ...(this.acknowledgeStarts ? { threadId: session.nativeSessionId,
        clientCorrelationId: input.clientCorrelationId, turn: { id: turnId, status: 'inProgress' } } : {}) } })
    if (this.approvalNodes.has(request.workflowNodeId)) {
      this.waits.set(session.nativeSessionId, Array.from({ length: this.pendingPerExecution }, (_, index) => ({
        session, turn: { nativeTurnId: turnId, nativeRequestId: `request-${request.executionId}-${index}` },
        nativeRequestType: 'item/commandExecution/requestApproval', request: { command: ['checkpoint-test-no-tool'] },
        responseOptions: CODEX_APPROVAL_OPTIONS_FIXTURE,
      })))
      if (this.disconnectAfterStart) yield NativeHarnessEventSchema.parse({ sequence: 1,
        type: 'transport.disconnected', occurredAt: new Date().toISOString(),
        payload: { threadId: session.nativeSessionId } })
      yield NativeHarnessEventSchema.parse({ sequence: this.disconnectAfterStart ? 2 : 1,
        type: 'interaction.pending', occurredAt: new Date().toISOString(), payload: {} })
      return
    }
    this.terminals.set(session.nativeSessionId, { outcome: 'succeeded', output: this.modelOutput(request, { node: request.workflowNodeId }) })
    const terminal = NativeHarnessEventSchema.parse({ sequence: 1, type: 'turn.completed', occurredAt: new Date().toISOString(),
      payload: { turnId, threadId: session.nativeSessionId, clientCorrelationId: input.clientCorrelationId,
        turn: { id: turnId, status: 'completed' } } })
    this.continuationEvents.set(session.nativeSessionId, terminal)
    yield terminal
  }
  private modelOutput(request: HarnessExecutionRequest, data: Record<string, string | boolean>) {
    if (this.outputFor) return this.outputFor(request.workflowNodeId, request)
    if (!request.resultProtocol) return data
    return { data, summary: 'Completed the assigned work.', board: { kind: 'none',
      reason: request.configuration.graphqlTools?.some(tool => tool.startsWith('memory_')) ? 'no_changes' : 'no_access' } }
  }
  async pending(session: NativeSessionReference) { return this.waits.get(session.nativeSessionId)?.[0] }
  /** Synthetic callback state only; no SQL, permission, attachment or native qualification. */
  async inspectResponseAvailability(session: NativeSessionReference, query: NativeResponseAvailabilityQuery): Promise<NativeResponseAvailability> {
    const request = this.requests.get(session.nativeSessionId)
    if (!request || session.harness !== this.harness || session.providerVersion !== '0.154.0') {
      return unavailableNativeResponse(session, query, 'identity_mismatch')
    }
    if (this.closedSessions.has(session.nativeSessionId)) return unavailableNativeResponse(session, query, 'session_closed')
    const pending = this.waits.get(session.nativeSessionId)?.find(item => item.turn.nativeRequestId === query.nativeRequestId)
    if (!pending) return unavailableNativeResponse(session, query, 'request_consumed')
    const generation = `checkpoint-callback:${session.nativeSessionId}:${pending.turn.nativeTurnId}`
    if (pending.nativeRequestType !== query.nativeRequestType
      || query.expectedNativeTurnId !== undefined && query.expectedNativeTurnId !== pending.turn.nativeTurnId
      || query.expectedNativeMessageId !== undefined && query.expectedNativeMessageId !== pending.turn.nativeMessageId
      || query.expectedGeneration !== undefined && query.expectedGeneration !== generation) {
      return unavailableNativeResponse(session, query, 'identity_mismatch')
    }
    return { nativeSessionId: session.nativeSessionId, nativeRequestId: query.nativeRequestId,
      nativeRequestType: query.nativeRequestType, ...(pending.turn.nativeTurnId ? { nativeTurnId: pending.turn.nativeTurnId } : {}), generation,
      qualified: true, state: 'available', path: 'live_callback', reason: 'live_callback' }
  }
  async respond(session: NativeSessionReference, requestId: string,
    option: Parameters<NativeHarnessSessionManager['respond']>[2]): Promise<void> {
    const pendingSet = this.waits.get(session.nativeSessionId) ?? []
    const pending = pendingSet.find((item) => item.turn.nativeRequestId === requestId)
    if (!pending) throw new Error('Repeated or mismatched native response')
    await this.beforeRespond?.()
    this.counts.responses++
    const remaining = pendingSet.filter((item) => item !== pending)
    this.waits.set(session.nativeSessionId, remaining)
    const receipts = this.receipts.get(session.nativeSessionId) ?? []
    receipts.push({ source: 'provider_acknowledgement', ...session,
      nativeRequestId: requestId, nativeRequestType: pending.nativeRequestType,
      optionId: option.optionId, semantic: option.semantic })
    this.receipts.set(session.nativeSessionId, receipts)
    if (!remaining.length) {
      const request = this.requests.get(session.nativeSessionId)!
      this.terminals.set(session.nativeSessionId, { outcome: 'succeeded',
        output: this.modelOutput(request, { approved: true }) })
      this.continuationEvents.set(session.nativeSessionId, NativeHarnessEventSchema.parse({ sequence: this.disconnectAfterStart ? 3 : 2,
        type: 'turn.completed', occurredAt: new Date().toISOString(), payload: {
          threadId: session.nativeSessionId, turnId: `turn-${request.executionId}`,
          clientCorrelationId: `execution:${request.executionId}`,
          turn: { id: `turn-${request.executionId}`, status: 'completed' },
        } }))
    }
  }
  async history(session: NativeSessionReference): Promise<NativeHistory> {
    const pendingInteractions = this.waits.get(session.nativeSessionId) ?? []
    const pendingInteraction = pendingInteractions[0]
    const terminalResult = this.terminals.get(session.nativeSessionId)
    const receipt = this.receipts.get(session.nativeSessionId)
    return { events: this.continuationEvents.has(session.nativeSessionId)
      ? [this.continuationEvents.get(session.nativeSessionId)!] : [], pendingInteractions,
      responseDeliveries: receipt ?? [], ...(pendingInteraction ? { pendingInteraction } : {}),
      ...(terminalResult ? { terminalResult } : {}) }
  }
  async reconcile(session: NativeSessionReference, correlationId: string): Promise<NativeHistory> {
    const retained = this.histories.get(correlationId)
    if (retained) return structuredClone(retained)
    const history = await this.history(session)
    const request = this.requests.get(session.nativeSessionId)
    if (!request || correlationId !== `execution:${request.executionId}`) return history
    if (!this.startedExecutions.includes(request.executionId)) return { ...history, correlationId }
    return { ...history, correlationId, nativeTurnId: `turn-${request.executionId}`,
      ...(history.terminalResult ? { terminalTurn: { correlationId, providerId: `turn-${request.executionId}`, result: history.terminalResult } } : {}),
    }
  }
  async cancel() { return true }
  async close(session: NativeSessionReference) {
    await this.beforeClose?.()
    // The deterministic provider confirms physical closure; its retained history survives API restart.
    this.closedSessions.add(session.nativeSessionId)
  }
}
