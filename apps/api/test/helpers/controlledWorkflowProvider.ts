import type { ExecutionResult, HarnessExecutionRequest, NativeHarnessEvent, NativeSessionReference } from '@foreman-code/contracts'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart } from '../../src/modules/harnesses/port.js'
import type { NativeManagerResolutionContext } from '../../src/modules/interactions/runtimePorts.js'
import { hasWorkflowRequest } from '../../src/modules/harnesses/sessionStart.js'
import { CheckpointTestProvider } from './wave25Br1003Provider.js'
import { deferred } from './deferred.js'

type Output = NonNullable<ExecutionResult['output']>

/** Only the external native provider is controlled; engine, writer, ownership and persistence remain real. */
export class ControlledWorkflowProvider {
  private readonly provider: CheckpointTestProvider
  private readonly gates = new Map<string, {
    entered: ReturnType<typeof deferred>; released: ReturnType<typeof deferred>; outcome: 'succeeded' | 'canceled'; executionId?: string
  }>()
  readonly steers: string[] = []
  readonly cancellations: string[] = []
  readonly consultations: string[] = []
  readonly credentials = new Map<string, string>()
  active = 0
  maximumActive = 0

  constructor(nodes: string[], private readonly output: (nodeId: string, request: HarnessExecutionRequest) => Output,
    private readonly cancelOutcome: 'succeeded' | 'canceled' = 'canceled') {
    this.provider = new CheckpointTestProvider(new Set(), 1, true, false, output)
    for (const node of nodes) this.gates.set(node, { entered: deferred(), released: deferred(), outcome: 'succeeded' })
  }

  entered(nodeId: string) { return this.gates.get(nodeId)!.entered.promise }
  release(nodeId: string, outcome: 'succeeded' | 'canceled' = 'succeeded') {
    const gate = this.gates.get(nodeId)!
    gate.outcome = outcome
    gate.released.resolve(undefined)
  }
  releaseAll() { for (const node of this.gates.keys()) this.release(node) }

  connection(context: NativeManagerResolutionContext): NativeHarnessSessionManager {
    const manager = this.provider.connection()
    const create = manager.createSession.bind(manager)
    const attach = manager.attachSession.bind(manager)
    const startTurn = manager.startTurn.bind(manager)
    const history = manager.history.bind(manager)
    const reconcile = manager.reconcile.bind(manager)
    const cancel = manager.cancel.bind(manager)
    const ownHistory = new Map<string, NativeHistory>()
    let request: HarnessExecutionRequest | undefined
    let currentCorrelation: string | undefined
    let native: NativeSessionReference | undefined
    const remember = (start: NativeSessionStart) => {
      if (!hasWorkflowRequest(start)) throw new Error('Expected workflow or consultation input')
      request = start.request
      const subjectId = start.kind === 'workflow-consultation' ? start.consultation.consultationId : request.executionId
      const token = start.environment?.variables.GRAPHQL_MCP_TOKEN
      if (token) this.credentials.set(subjectId, token)
      if (start.kind !== 'workflow-consultation') {
        const gate = this.gates.get(request.workflowNodeId)
        if (gate?.executionId && gate.executionId !== request.executionId) this.gates.set(request.workflowNodeId,
          { entered: deferred(), released: deferred(), outcome: 'succeeded', executionId: request.executionId })
        else if (gate) gate.executionId = request.executionId
      }
    }
    manager.createSession = async (start, signal) => {
      remember(start)
      native = await create(start, signal)
      return native
    }
    manager.attachSession = async (session, start, signal) => {
      remember(start)
      native = await attach(session, start.kind === 'workflow-consultation' ? {
        kind: 'workflow', request: start.request, correlationId: start.correlationId,
        ...(start.environment ? { environment: start.environment } : {}), instructionsDelivered: true,
      } : start, signal)
      return native
    }
    const { gates, consultations } = this
    const produce = (current: HarnessExecutionRequest) => this.output(current.workflowNodeId, current)
    const enter = () => { this.active++; this.maximumActive = Math.max(this.maximumActive, this.active) }
    const leave = () => { this.active-- }
    manager.startTurn = async function* (session, input, signal) {
      if (!request) throw new Error('Missing accepted native request')
      const consultation = context.purpose === 'consultation'
      const gate = consultation ? undefined : gates.get(request.workflowNodeId)
      if (!consultation && !gate) { yield* startTurn(session, input, signal); return }
      const correlationId = input.clientCorrelationId
      const providerId = `turn-${correlationId}`
      currentCorrelation = correlationId
      const events: NativeHarnessEvent[] = [{ sequence: 0, occurredAt: new Date().toISOString(), type: 'turn.started',
        payload: { threadId: session.nativeSessionId, turnId: providerId, clientCorrelationId: correlationId,
          turn: { id: providerId, status: 'inProgress' } } }]
      ownHistory.set(correlationId, { events, pendingInteractions: [], correlationId, nativeTurnId: providerId })
      enter()
      try {
        if (consultation) consultations.push(correlationId)
        await input.onSubmitted?.(providerId)
        yield events[0]!
        gate?.entered.resolve(undefined)
        if (gate) await gate.released.promise
        signal?.throwIfAborted()
        const outcome = gate?.outcome ?? 'succeeded'
        const result: ExecutionResult = outcome === 'canceled' ? { outcome } : {
          outcome, output: consultation ? { text: 'The delegated work is still in progress.' } : produce(request),
        }
        if (consultation) {
          const message: NativeHarnessEvent = { sequence: events.length, occurredAt: new Date().toISOString(),
            type: 'item.completed', payload: { threadId: session.nativeSessionId, turnId: providerId,
              clientCorrelationId: correlationId, item: { id: `reply-${providerId}`, type: 'agentMessage',
                text: 'The delegated work is still in progress.' } } }
          events.push(message)
          yield message
        }
        const terminal: NativeHarnessEvent = { sequence: events.length, occurredAt: new Date().toISOString(), type: 'turn.completed',
          payload: { threadId: session.nativeSessionId, turnId: providerId, clientCorrelationId: correlationId,
            turn: { id: providerId, status: outcome === 'canceled' ? 'interrupted' : 'completed' } } }
        ownHistory.set(correlationId, { events: [...events, terminal], pendingInteractions: [], correlationId,
          nativeTurnId: providerId, terminalResult: result, terminalTurn: { correlationId, providerId, result } })
        yield terminal
      } finally { leave() }
    }
    manager.history = async (session, signal) => currentCorrelation && ownHistory.has(currentCorrelation)
      ? structuredClone(ownHistory.get(currentCorrelation)!) : history(session, signal)
    manager.reconcile = async (session, correlation, signal) => ownHistory.has(correlation)
      ? structuredClone(ownHistory.get(correlation)!) : reconcile(session, correlation, signal)
    manager.cancel = async (session, signal, providerId) => {
      if (request && this.gates.has(request.workflowNodeId)) {
        this.cancellations.push(request.workflowNodeId)
        this.release(request.workflowNodeId, this.cancelOutcome)
        return true
      }
      return cancel(session, signal, providerId)
    }
    manager.steerTurn = async (session, input) => {
      if (session.nativeSessionId !== native?.nativeSessionId
        || input.expectedTurnId !== ownHistory.get(currentCorrelation!)?.nativeTurnId) throw new Error('Changed native input')
      this.steers.push(input.clientCorrelationId)
      return { nativeTurnId: input.expectedTurnId }
    }
    manager.reconcileSteers = async (session, inputs) => inputs.filter(input => this.steers.includes(input.clientCorrelationId))
      .map(input => ({ nativeSessionId: session.nativeSessionId, nativeTurnId: input.expectedTurnId, correlationId: input.clientCorrelationId }))
    return manager
  }
}
