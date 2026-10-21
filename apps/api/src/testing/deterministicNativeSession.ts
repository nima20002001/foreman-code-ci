import { isDeepStrictEqual } from 'node:util'

import {
  IdSchema,
  NATIVE_INTERACTION_FIXTURES,
  NativeHarnessCapabilitiesSchema,
  NativeHarnessEventSchema,
  NativeSessionReferenceSchema,
  PendingNativeInteractionSchema,
  type AgentHarness,
  type ApprovalResponseOption,
  type McpDetection,
  type NativeHarnessCapabilities,
  type NativeHarnessEvent,
  type NativeSessionReference,
  type PendingNativeInteraction,
} from '@foreman-code/contracts'

import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeTurnInput } from '../modules/harnesses/port.js'
import { harnessProfile } from '../modules/harnesses/qualification/profiles.js'

interface FixtureTurn {
  events: NativeHarnessEvent[]
  waiting: PendingNativeInteraction | undefined
}
interface FixtureSession {
  reference: NativeSessionReference
  events: NativeHarnessEvent[]
  turns: Map<string, FixtureTurn>
  activeCorrelation: string | undefined
  nextTurn: number
}
/** Deterministic rich-transport fixture shared by HAP-02–07 integration tests. */
export class DeterministicNativeSessionManager implements NativeHarnessSessionManager {
  readonly counters = { sessions: 0, attaches: 0, turns: 0, sideEffects: 0, deliveries: 0, cancellations: 0 }
  lastStart: NativeSessionStart | undefined
  private readonly sessions = new Map<string, FixtureSession>()
  private nextSession = 0

  readonly providerVersion: string
  readonly harness: 'codex'

  constructor(harness: AgentHarness, providerVersion = '0.154.0') {
    if (harness !== 'codex') throw new Error('FIXTURE_PROVIDER_UNSUPPORTED')
    if (harnessProfile(harness, providerVersion) === null) throw new Error('FIXTURE_PROVIDER_UNQUALIFIED')
    this.harness = harness
    this.providerVersion = providerVersion
  }

  async capabilities(): Promise<NativeHarnessCapabilities> {
    return NativeHarnessCapabilitiesSchema.parse({
      provider: this.harness, providerVersion: this.providerVersion,
      persistentSessions: true, reconnect: true, sameRequestResponses: true, cancellation: true,
      history: true, configurationInspection: true, mcpDetection: true, supportedInteractionKinds: ['approval'],
    })
  }

  async inspectMcp(): Promise<McpDetection> {
    return { harness: this.harness, serverName: 'graphql', state: 'connected', endpointMatches: true,
      credentialEnvironmentVariable: 'GRAPHQL_MCP_TOKEN', checkedAt: '2026-09-16T00:00:00.000Z' }
  }

  private register(reference: NativeSessionReference): FixtureSession {
    const state: FixtureSession = { reference: structuredClone(reference), events: [], turns: new Map(), activeCorrelation: undefined, nextTurn: 0 }
    this.sessions.set(reference.nativeSessionId, state)
    return state
  }

  private session(reference: NativeSessionReference): FixtureSession {
    const parsed = NativeSessionReferenceSchema.parse(reference)
    const state = this.sessions.get(parsed.nativeSessionId)
    if (!state || !isDeepStrictEqual(state.reference, parsed)) throw new Error('FIXTURE_SESSION_NOT_FOUND')
    return state
  }

  private waiting(state: FixtureSession): PendingNativeInteraction | undefined {
    return state.activeCorrelation === undefined ? undefined : state.turns.get(state.activeCorrelation)?.waiting
  }

  private event(state: FixtureSession, correlationId: string, type: string, payload: Record<string, unknown>): NativeHarnessEvent {
    const event = NativeHarnessEventSchema.parse({
      sequence: state.events.length, type, occurredAt: '2026-09-16T00:00:00.000Z',
      payload: { ...payload, clientCorrelationId: correlationId },
    })
    state.events.push(event)
    state.turns.get(correlationId)!.events.push(event)
    return structuredClone(event)
  }

  async createSession(input: NativeSessionStart): Promise<NativeSessionReference> {
    this.lastStart = structuredClone(input)
    let id: string
    do { id = `${this.harness}-fixture-session-${++this.nextSession}` } while (this.sessions.has(id))
    const reference = NativeSessionReferenceSchema.parse({
      harness: this.harness, providerVersion: this.providerVersion, nativeSessionId: id,
    })
    this.register(reference)
    this.counters.sessions += 1
    return reference
  }

  async attachSession(session: NativeSessionReference, input: NativeSessionStart): Promise<NativeSessionReference> {
    const parsed = NativeSessionReferenceSchema.parse(session)
    if (parsed.harness !== this.harness || parsed.providerVersion !== (await this.capabilities()).providerVersion) {
      throw new Error('FIXTURE_SESSION_PROVIDER_MISMATCH')
    }
    // An externally seeded persisted identity begins with empty fixture history.
    // Reattachment of a known identity preserves all turns and pending requests.
    if (this.sessions.has(parsed.nativeSessionId)) this.session(parsed)
    else this.register(parsed)
    this.lastStart = structuredClone(input)
    this.counters.attaches += 1
    return parsed
  }

  async *startTurn(session: NativeSessionReference, input: NativeTurnInput): AsyncIterable<NativeHarnessEvent> {
    const state = this.session(session)
    const correlation = IdSchema.parse(input.clientCorrelationId)
    const previous = state.turns.get(correlation)
    if (previous) {
      for (const event of previous.events) yield structuredClone(event)
      return
    }
    if (this.waiting(state)) throw new Error('FIXTURE_SESSION_BUSY')
    this.counters.turns += 1
    this.counters.sideEffects += 1
    const source = NATIVE_INTERACTION_FIXTURES[this.harness]
    const nativeTurnId = `${session.nativeSessionId}-turn-${++state.nextTurn}`
    const nativeRequestId = `${nativeTurnId}-request-1`
    const waiting = PendingNativeInteractionSchema.parse({
      session, turn: { nativeTurnId, nativeRequestId },
      nativeRequestType: source.nativeRequestType, request: source.request, responseOptions: source.responseOptions,
    })
    state.turns.set(correlation, { events: [], waiting })
    state.activeCorrelation = correlation
    yield this.event(state, correlation, 'interaction.pending', { nativeTurnId, nativeRequestId })
  }

  async pending(session: NativeSessionReference): Promise<PendingNativeInteraction | undefined> {
    return structuredClone(this.waiting(this.session(session)))
  }

  async respond(session: NativeSessionReference, nativeRequestId: string, option: ApprovalResponseOption): Promise<void> {
    const state = this.session(session)
    const waiting = this.waiting(state)
    if (!waiting || waiting.turn.nativeRequestId !== nativeRequestId
      || !waiting.responseOptions.some((item) => isDeepStrictEqual(item, option))) throw new Error('INVALID_FIXTURE_RESPONSE')
    const correlation = state.activeCorrelation!
    this.counters.deliveries += 1
    state.turns.get(correlation)!.waiting = undefined
    state.activeCorrelation = undefined
    this.event(state, correlation, 'interaction.responded', { nativeRequestId, optionId: option.optionId })
  }

  async cancel(session: NativeSessionReference): Promise<boolean> {
    const state = this.session(session)
    this.counters.cancellations += 1
    const waiting = this.waiting(state)
    if (!waiting) return false
    const correlation = state.activeCorrelation!
    state.turns.get(correlation)!.waiting = undefined
    state.activeCorrelation = undefined
    this.event(state, correlation, 'turn.canceled', { nativeTurnId: waiting.turn.nativeTurnId })
    return true
  }

  async history(session: NativeSessionReference): Promise<NativeHistory> {
    const state = this.session(session)
    const waiting = this.waiting(state)
    return structuredClone({ events: state.events, pendingInteractions: waiting ? [waiting] : [], ...(waiting ? { pendingInteraction: waiting } : {}) })
  }

  async reconcile(session: NativeSessionReference, correlationId: string): Promise<NativeHistory> {
    const turn = this.session(session).turns.get(IdSchema.parse(correlationId))
    return structuredClone({ events: turn?.events ?? [], pendingInteractions: turn?.waiting ? [turn.waiting] : [],
      ...(turn?.waiting ? { pendingInteraction: turn.waiting } : {}) })
  }

  async close(session: NativeSessionReference): Promise<void> { this.session(session) }
}
