import { isWorkflowStart } from '../../src/modules/harnesses/sessionStart.js'
import { EventEmitter } from 'node:events'
import {
  ExecutionResultSchema, NativeHarnessEventSchema,
  type ExecutionResult, type HarnessExecutionRequest, type NativeHarnessEvent, type NativeSessionReference,
} from '@foreman-code/contracts'
import { RunAcceptedInputValueSchema, type WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import type { NativeHarnessSessionManager, NativeHistory } from '../../src/modules/harnesses/port.js'
import { HarnessExecutionError } from '../../src/modules/harnesses/errors.js'

/** transport_failure: the stream drops after the turn started, without a terminal.
 * gated_success: the turn succeeds only after releaseGate(). */
export type Fault = 'success' | 'retryable_failure' | 'permanent_failure' | 'park'
  | 'durable_reply_gap' | 'durable_failure_gap' | 'transport_failure' | 'gated_success'
export interface Submission {
  request: HarnessExecutionRequest
  /** Provider-observed submissions within one Run/node/occurrence, NOT a database counter. */
  attempt: number
  occurrenceId: string | null
  occurrenceIndex: number | null
}
interface Session {
  reference: NativeSessionReference
  submission: Submission
  fault: Fault
  alive: boolean
  started: boolean
  parked: boolean
  events: NativeHarnessEvent[]
  terminal?: ExecutionResult
  wake?: () => void
}

/** Deterministic external provider ONLY. It has no SQL, owner, credential, receipt,
 * graph or coordinator capability. Original raw terminal frames and history are
 * generated here; production capture/verification must accept them independently.
 * A restart closes the transport/process, not the business Run. A dead session
 * without a durable result refuses attachment/history and never invents an ACK.
 */
export class RecoveryProvider {
  readonly events = new EventEmitter()
  readonly submissions: Submission[] = []
  readonly counts = { sessions: 0, starts: 0, attaches: 0, cancels: 0, closes: 0 }
  private readonly sessions = new Map<string, Session>()
  private readonly closed = new Set<string>()
  readonly recoveryCalls: string[] = []
  /** Withhold external closure evidence for a fault test, never SQL receipts. */
  recoveryProofAvailable = true

  atBarrier(executionId: string): boolean {
    return [...this.sessions.values()].some((session) => session.submission.request.executionId === executionId && session.parked)
  }
  originalResult(executionId: string): ExecutionResult | undefined {
    const session = [...this.sessions.values()].find((item) => item.submission.request.executionId === executionId)
    return session?.terminal && structuredClone(session.terminal)
  }
  /** Simulated process-registry boundary. Only a known, exactly scoped lifetime
   * can be disposed. A missing session is NOT positive closure evidence. The
   * real coordinator/SQL writer still creates and validates the recovery row. */
  async recoverProcesses(executionId: string, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    this.recoveryCalls.push(executionId)
    const sessions = [...this.sessions.values()].filter((session) => session.submission.request.executionId === executionId)
    if (!sessions.length || !this.recoveryProofAvailable) return false
    for (const session of sessions) this.close(session.reference)
    signal.throwIfAborted()
    return sessions.every((session) => this.closed.has(session.reference.nativeSessionId))
  }
  constructor(private readonly version: WorkflowVersionV3, private readonly plan: (input: Submission) => Fault) {}

  private openGate!: () => void
  private readonly gate = new Promise<void>((resolve) => { this.openGate = resolve })
  releaseGate() { this.openGate() }
  /** The provider later reports a failed terminal for every dropped stream. */
  deliverLateFailures() {
    for (const session of this.sessions.values()) {
      if (session.fault === 'transport_failure' && !session.terminal) this.finish(session, {
        outcome: 'failed', error: { code: 'ENG06_LATE_FAILURE', message: 'A late provider failure', retryable: false } })
    }
  }

  private lookup(reference: NativeSessionReference): Session {
    const session = this.sessions.get(reference.nativeSessionId)
    if (!session || session.reference.harness !== reference.harness
      || session.reference.providerVersion !== reference.providerVersion) throw new Error('Unknown exact native session')
    return session
  }
  private finish(session: Session, result: ExecutionResult) {
    if (session.terminal) throw new Error('The provider cannot rewrite an original terminal')
    const id = session.submission.request.executionId
    session.terminal = ExecutionResultSchema.parse(structuredClone(result))
    session.events.push(NativeHarnessEventSchema.parse({ sequence: 1, type: 'turn.completed', occurredAt: new Date().toISOString(),
      payload: { threadId: session.reference.nativeSessionId, turnId: `turn-${id}`, clientCorrelationId: `execution:${id}`,
        turn: { id: `turn-${id}`, status: result.outcome === 'succeeded' ? 'completed' : result.outcome === 'failed' ? 'failed' : 'interrupted' } } }))
  }
  private result(session: Session): ExecutionResult {
    if (session.fault === 'retryable_failure' || session.fault === 'permanent_failure' || session.fault === 'durable_failure_gap') return {
      outcome: 'failed', error: { code: 'ENG06_NATIVE_FAILURE', message: 'Exact original provider failure',
        retryable: session.fault !== 'permanent_failure' },
    }
    const { request, occurrenceIndex } = session.submission
    const exit = this.version.definition.repeat?.blocks.some((block) => block.exitNodeId === request.workflowNodeId)
    return { outcome: 'succeeded', output: exit ? { text: JSON.stringify({ routing: { outcome: 'issues' },
      data: { latestDeliverable: { occurrenceIndex, executionId: request.executionId }, remainingFindings: [{ id: 'still-open' }] } }) }
      : { nodeId: request.workflowNodeId, executionId: request.executionId, exact: 'durable original result' } }
  }
  private async history(reference: NativeSessionReference): Promise<NativeHistory> {
    const session = this.lookup(reference)
    if (!session.alive && !session.terminal) throw new Error('Native process is gone; no durable result exists and its outcome is uncertain')
    // The old transport never receives the durable completion reply. A new
    // connection can read that exact history after closure, without a submission.
    const visible = session.terminal && !(['durable_reply_gap', 'durable_failure_gap'].includes(session.fault) && session.alive)
    const id = session.submission.request.executionId, correlationId = `execution:${id}`
    return structuredClone({ ...(session.started ? { correlationId, nativeTurnId: `turn-${id}` } : {}),
      events: visible ? session.events : session.events.filter((event) => event.type === 'turn.started'), pendingInteractions: [],
      ...(visible ? { terminalResult: session.terminal!, terminalTurn: {
        correlationId, providerId: `turn-${id}`, result: session.terminal!,
      } } : {}) })
  }
  private close(reference: NativeSessionReference) {
    const session = this.lookup(reference)
    if (session.alive) this.counts.closes++
    session.alive = false
    this.closed.add(session.reference.nativeSessionId)
    session.wake?.()
  }
  killAll() { for (const session of this.sessions.values()) this.close(session.reference) }

  connection(): NativeHarnessSessionManager {
    let owned: NativeSessionReference | undefined
    // The returned manager methods need this provider instance after connection returns.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const provider = this
    return {
      harness: 'codex',
      async capabilities() { return { provider: 'codex', providerVersion: '0.154.0', persistentSessions: true,
        reconnect: true, sameRequestResponses: true, cancellation: true, history: true,
        configurationInspection: true, mcpDetection: true, supportedInteractionKinds: ['approval'] } },
      async inspectMcp() { return { harness: 'codex', serverName: 'graphql', state: 'connected',
        endpointMatches: true, credentialEnvironmentVariable: null, checkedAt: new Date().toISOString() } },
      async createSession(input) {
        if (!isWorkflowStart(input)) throw new Error('Only workflow requests belong to this provider fixture')
        if (input.sessionContinuation) throw new Error('This provider requires ephemeral workflow sessions')
        const request = structuredClone(input.request), accepted = RunAcceptedInputValueSchema.parse(request.input)
        const occurrenceId = accepted.occurrence?.identity.occurrenceId ?? null
        const attempt = 1 + provider.submissions.filter((item) => item.request.runId === request.runId
          && item.request.workflowNodeId === request.workflowNodeId && item.occurrenceId === occurrenceId).length
        const submission = { request, attempt, occurrenceId, occurrenceIndex: accepted.occurrence?.identity.occurrenceIndex ?? null }
        const reference: NativeSessionReference = { harness: 'codex', providerVersion: '0.154.0', nativeSessionId: `eng06-${request.executionId}` }
        if (provider.sessions.has(reference.nativeSessionId)) throw new Error('Duplicate session creation for an admitted execution')
        provider.sessions.set(reference.nativeSessionId, { reference, submission, fault: provider.plan(submission), alive: true, started: false, parked: false, events: [] })
        provider.counts.sessions++; owned = reference
        return reference
      },
      async attachSession(reference, input) {
        const session = provider.lookup(reference)
        if (!isWorkflowStart(input) || input.request.executionId !== session.submission.request.executionId) throw new Error('Attachment changed execution identity')
        if (!session.alive && !session.terminal) throw new Error('Native process is gone; replacement attachment is forbidden')
        owned = reference; provider.counts.attaches++
        return reference
      },
      async *startTurn(reference, input, signal) {
        const session = provider.lookup(reference), id = session.submission.request.executionId
        if (!session.alive || session.started) throw new Error('An exact native submission cannot be replayed')
        session.started = true; provider.counts.starts++; provider.submissions.push(session.submission)
        await input.onSubmitted?.(`turn-${id}`)
        session.events.push(NativeHarnessEventSchema.parse({ sequence: 0, type: 'turn.started', occurredAt: new Date().toISOString(),
          payload: { threadId: reference.nativeSessionId, turnId: `turn-${id}`, clientCorrelationId: input.clientCorrelationId,
            turn: { id: `turn-${id}`, status: 'inProgress' } } }))
        yield session.events[0]!
        if (session.fault === 'transport_failure') {
          throw new HarnessExecutionError('CODEX_APP_SERVER_DISCONNECTED', 'The provider connection closed during the turn.')
        }
        if (session.fault === 'gated_success') await provider.gate
        if (session.fault !== 'park') provider.finish(session, provider.result(session))
        if (['park', 'durable_reply_gap', 'durable_failure_gap'].includes(session.fault)) {
          // The DB becomes running BEFORE the stream reaches this point. Tests
          // must await this provider-side barrier before restarting the API.
          session.parked = true
          provider.events.emit('parked', session.submission)
          await new Promise<void>((resolve) => {
            const done = () => { signal?.removeEventListener('abort', done); delete session.wake; resolve() }
            if (!session.alive || signal?.aborted) return done()
            session.wake = done; signal?.addEventListener('abort', done, { once: true })
          })
          signal?.throwIfAborted()
          return
        }
        yield session.events[1]!
      },
      async pending() { return undefined },
      async respond() { throw new Error('This lane does not synthesize approval delivery') },
      history: (reference) => provider.history(reference),
      async reconcile(reference, correlationId) {
        const session = provider.lookup(reference)
        if (correlationId !== `execution:${session.submission.request.executionId}`) throw new Error('Wrong exact correlation')
        return provider.history(reference)
      },
      async cancel(reference) {
        const session = provider.lookup(reference); provider.counts.cancels++
        if (session.terminal) return true
        if (!session.alive) return false // Absence is not cancellation or result proof.
        provider.finish(session, { outcome: 'canceled' }); session.wake?.(); return true
      },
      async close(reference) { provider.close(reference) },
      canDetachForRestart(reference) {
        const session = provider.lookup(reference)
        const configuration = session.submission.request.configuration.harness
        return owned?.nativeSessionId === reference.nativeSessionId && session.alive
          && configuration.harness === 'codex' && configuration.advanced?.sessionPersistence !== 'ephemeral'
      },
      async closeForRestart(reference) { provider.close(reference) },
      async dispose() { if (owned) provider.close(owned) },
    }
  }
}
