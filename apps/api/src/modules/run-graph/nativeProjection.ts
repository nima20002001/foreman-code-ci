import { createHash } from 'node:crypto'
import type { GraphActivity, NativeGraphCorrelationRecord, NativeGraphProjectionKey } from '@foreman-code/contracts/wave25'
import { graphJsonBytes } from '@foreman-code/contracts/wave25'
import { nativeAction, nativeObject, nativeString } from '../runs/nativeAction.js'

/** Internal, bounded checkpoint. It contains protocol identities, never arguments/output/prose. */
export const NATIVE_PROJECTION_LIMITS = Object.freeze({ operations: 128, messages: 128, identityLength: 1000, evidenceBytes: 32768, checkpointBytes: 120000 })
export interface ProjectionBinding {
  key: NativeGraphProjectionKey
  provider: NativeGraphCorrelationRecord['provider']
  nativeSessionId: string
  /** Exact submitted turn or input message, supplied by the locked correlation record. */
  nativeTurnId: string | null
  connectionGeneration: string
  interactionId: string | null
  /** The work item, NOT the host execution: a finished host can perform a later independent review. */
  closed: boolean
}
export interface ProjectionEvent {
  nativeSequence: string
  sourcePosition: string
  sourceStreamId: string
  connectionGeneration: string
  sourceId: string
  type: string
  payload: Record<string, unknown>
}
interface Operation {
  id: string
  messageId: string | null
  turnId: string | null
  action: NonNullable<GraphActivity['action']>
  position: string
  nativeSequence: string
  sourceId: string
  stream: string
  generation: string
  pending: boolean
  ended: boolean
}
interface MessageLink { id: string; parent: string | null; conflicted: boolean }
export interface NativeProjectionState {
  version: 1
  bindingDigest: string
  generation: string
  boundTurnId: string | null
  evidenceFloor: { stream: string; position: string; generation: string } | null
  transportFence: { stream: string; position: string; generation: string } | null
  lastNativeSequence: string | null
  terminalNativeSequence: string | null
  acknowledgement: { id: string; position: string; stream: string; generation: string } | null
  disconnected: boolean
  uncertain: boolean
  overflow: boolean
  messages: MessageLink[]
  operations: Operation[]
}
export interface NativeProjectionResult {
  state: NativeProjectionState
  activity: GraphActivity
  disposition: 'changed' | 'ignored' | 'rejected'
  reason: 'irrelevant' | 'identity' | 'generation' | 'terminal' | 'invalid' | 'capacity' | 'evidence'
}

const sequence = (value: string): boolean => /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n
const identity = (value: unknown): string | undefined => {
  const text = nativeString(value)
  return text && text.length <= NATIVE_PROJECTION_LIMITS.identityLength ? text : undefined
}
const maximum = (left: string | null, right: string): string => left === null || BigInt(right) > BigInt(left) ? right : left
export const nativeProjectionId = (kind: string, ...parts: unknown[]): string =>
  `${kind}-${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`
const bindingDigest = (binding: ProjectionBinding): string => nativeProjectionId('binding', binding.key.execution.executionId,
  binding.key.execution.workflowNodeId, binding.key.execution.agentId, binding.key.execution.agentConfigurationVersionId,
  binding.key.execution.attempt, binding.key.workKind, binding.key.workId, binding.provider, binding.nativeSessionId)

export function emptyNativeProjection(binding: ProjectionBinding): NativeProjectionState {
  return { version: 1, bindingDigest: bindingDigest(binding), generation: binding.connectionGeneration,
    boundTurnId: binding.nativeTurnId, evidenceFloor: null, transportFence: null,
    lastNativeSequence: null, terminalNativeSequence: null, acknowledgement: null,
    disconnected: false, uncertain: false, overflow: false, messages: [], operations: [] }
}

export function truncateNativeCheckpoint(state: NativeProjectionState): NativeProjectionState {
  if (graphJsonBytes(state) <= NATIVE_PROJECTION_LIMITS.checkpointBytes) return state
  const bounded = { ...state, overflow: true, messages: [...state.messages],
    operations: [...state.operations].sort((left, right) => {
      const first = BigInt(left.nativeSequence)
      const second = BigInt(right.nativeSequence)
      if (first === second) return right.id.localeCompare(left.id)
      return first > second ? -1 : 1
    }) }
  // Retain sequence fences and mark incomplete evidence so dropped tombstones cannot imply active work.
  while (graphJsonBytes(bounded) > NATIVE_PROJECTION_LIMITS.checkpointBytes) {
    if (bounded.operations.length) bounded.operations.pop()
    else bounded.messages.shift()
  }
  return bounded
}

const mappedAction = (action: string): NonNullable<GraphActivity['action']> => {
  switch (action) {
    case 'reading_file': case 'writing_file': case 'creating_folder': case 'using_app_mcp': case 'spawning_subagent': return action
    default: return 'using_tool'
  }
}
const turnFor = (operation: Operation, state: NativeProjectionState): string | null => {
  if (!operation.messageId) return operation.turnId
  const message = state.messages.find((link) => link.id === operation.messageId)
  return !message || message.conflicted ? null : message.parent
}
const eligible = (operation: Operation, state: NativeProjectionState, binding: ProjectionBinding): boolean =>
  !operation.ended && !operation.pending && operation.generation === binding.connectionGeneration
  && binding.nativeTurnId !== null && turnFor(operation, state) === binding.nativeTurnId

/** No lease, transport-open, ping, prose or completed item can create acknowledgement. */
export function nativeProjectionActivity(state: NativeProjectionState, binding: ProjectionBinding): GraphActivity {
  const base = { workflowNodeId: binding.key.execution.workflowNodeId, execution: binding.key.execution }
  if (state.bindingDigest !== bindingDigest(binding) || state.generation !== binding.connectionGeneration
    || (state.boundTurnId !== null && state.boundTurnId !== binding.nativeTurnId)) return { ...base, status: 'unknown' }
  if (state.terminalNativeSequence !== null || binding.closed) return { ...base, status: 'none' }
  if (state.overflow || state.uncertain || !binding.nativeTurnId) return { ...base, status: 'unknown' }
  const candidates = state.operations.filter((operation) => eligible(operation, state, binding))
  candidates.sort((a, b) => {
    const left = a.stream === b.stream ? a.position : a.nativeSequence
    const right = a.stream === b.stream ? b.position : b.nativeSequence
    return BigInt(left) === BigInt(right) ? a.id.localeCompare(b.id) : BigInt(left) > BigInt(right) ? -1 : 1
  })
  const operation = candidates[0]
  const acknowledgement = operation?.sourceId ?? state.acknowledgement?.id
  if (!acknowledgement) return { ...base, status: 'unknown' }
  if (binding.key.workKind === 'review' && !binding.interactionId) return { ...base, status: 'unknown' }
  return { ...base, status: state.disconnected ? 'stale' : 'active',
    action: binding.key.workKind === 'review' ? 'reviewing' : operation?.action ?? 'working',
    correlationId: nativeProjectionId('correlation', state.bindingDigest, binding.nativeTurnId),
    acknowledgementId: acknowledgement,
    ...(binding.key.workKind === 'review' ? { reviewJobId: binding.key.workId, interactionId: binding.interactionId! } : {}),
  }
}

/** Explicitly allowlisted structured evidence only. The caller persists the original native event separately. */
export function projectNativeEvidence(previous: NativeProjectionState | undefined, binding: ProjectionBinding, event: ProjectionEvent): NativeProjectionResult {
  const initial = previous ?? emptyNativeProjection(binding)
  const answer = (state: NativeProjectionState, disposition: NativeProjectionResult['disposition'], reason: NativeProjectionResult['reason']): NativeProjectionResult =>
    ({ state, activity: nativeProjectionActivity(state, binding), disposition, reason })
  if (binding.provider === 'opencode') return answer(initial, 'ignored', 'identity')
  if (initial.version !== 1 || initial.bindingDigest !== bindingDigest(binding)
    || (initial.boundTurnId !== null && initial.boundTurnId !== binding.nativeTurnId)) return { state: initial, activity: { workflowNodeId: binding.key.execution.workflowNodeId, status: 'unknown' }, disposition: 'rejected', reason: 'identity' }
  if (![event.nativeSequence, event.sourcePosition, event.connectionGeneration, binding.connectionGeneration].every(sequence)) return answer(initial, 'rejected', 'invalid')
  if (event.connectionGeneration !== binding.connectionGeneration || BigInt(event.connectionGeneration) < BigInt(initial.generation)) return answer(initial, 'ignored', 'generation')
  if (initial.terminalNativeSequence !== null || binding.closed) return answer(initial, 'ignored', 'terminal')
  const relevant = ['item.started', 'item.completed', 'item.snapshot',
    'turn.started', 'turn.completed', 'graph.native.acknowledged', 'graph.native.disconnected', 'graph.native.uncertain', 'graph.native.terminal'].includes(event.type)
  if (!relevant) return answer(initial, 'ignored', 'irrelevant')
  if (!identity(event.sourceId) || !identity(event.sourceStreamId)) return answer(initial, 'rejected', 'invalid')
  // A newer generation makes old active evidence stale, not working; only NEW native evidence recovers it.
  const state: NativeProjectionState = structuredClone(initial)
  state.boundTurnId ??= binding.nativeTurnId
  const floor = state.evidenceFloor
  if (floor && floor.generation === event.connectionGeneration && floor.stream === event.sourceStreamId
    && BigInt(event.sourcePosition) <= BigInt(floor.position)) return answer(initial, 'ignored', 'evidence')
  if (state.generation !== event.connectionGeneration) {
    state.generation = event.connectionGeneration
    state.disconnected = true
    state.acknowledgement = null
    state.transportFence = null
  }
  const before = JSON.stringify(state)
  const payload = event.payload
  const info = nativeObject(payload.info), part = nativeObject(payload.part), turn = nativeObject(payload.turn)
  const sessions = [payload.threadId, payload.sessionID, payload.nativeSessionId, info.sessionID, part.sessionID].filter((value) => value !== undefined)
  if (!sessions.length || sessions.some((value) => identity(value) !== binding.nativeSessionId)) return answer(initial, 'ignored', 'identity')
  const nativeTurnId = binding.provider === 'claude' ? identity(payload.nativeMessageId) : identity(payload.turnId) ?? identity(turn.id)
  if (payload.turnId !== undefined && turn.id !== undefined && identity(payload.turnId) !== identity(turn.id)) return answer(initial, 'rejected', 'identity')
  const stamp = () => { state.lastNativeSequence = maximum(state.lastNativeSequence, event.nativeSequence) }
  const acknowledge = (sourceId: string) => {
    const prior = state.acknowledgement
    if (!prior || prior.generation !== event.connectionGeneration || prior.stream !== event.sourceStreamId
      || BigInt(event.sourcePosition) >= BigInt(prior.position)) {
      state.acknowledgement = { id: sourceId, position: event.sourcePosition, stream: event.sourceStreamId, generation: event.connectionGeneration }
      const fence = state.transportFence
      if (!fence || fence.generation !== event.connectionGeneration || (fence.stream === event.sourceStreamId
        && BigInt(event.sourcePosition) > BigInt(fence.position))) {
        state.disconnected = false
        state.uncertain = false
      }
    }
  }
  const finish = () => {
    stamp()
    state.terminalNativeSequence = event.nativeSequence
    state.acknowledgement = null
    state.operations = []
    state.messages = []
    state.disconnected = false
  }
  if (event.type === 'graph.native.disconnected' || event.type === 'graph.native.uncertain') {
    const ack = state.acknowledgement
    if (ack && ack.stream === event.sourceStreamId && ack.generation === event.connectionGeneration
      && BigInt(event.sourcePosition) < BigInt(ack.position)) return answer(initial, 'ignored', 'evidence')
    const fence = state.transportFence
    if (fence && fence.stream === event.sourceStreamId && fence.generation === event.connectionGeneration
      && BigInt(event.sourcePosition) <= BigInt(fence.position)) return answer(initial, 'ignored', 'evidence')
    state.transportFence = { stream: event.sourceStreamId, position: event.sourcePosition, generation: event.connectionGeneration }
    state.disconnected = true
    if (event.type === 'graph.native.uncertain') state.uncertain = true
    stamp()
  } else if (event.type === 'graph.native.acknowledged') {
    if (!binding.nativeTurnId || nativeTurnId !== binding.nativeTurnId) return answer(initial, 'rejected', 'identity')
    stamp(); acknowledge(event.sourceId)
  } else if (event.type === 'graph.native.terminal') {
    // This envelope comes only from parseNativeGraphObservation; never from a provider frame name.
    const terminal = nativeObject(payload.terminal)
    if (nativeTurnId !== binding.nativeTurnId || !['provider_terminal', 'persisted_terminal'].includes(String(terminal.evidenceKind))
      || !['succeeded', 'failed', 'canceled', 'interrupted'].includes(String(terminal.outcome))
      || !identity(terminal.evidenceId) || typeof terminal.nativeSettled !== 'boolean'
      || (terminal.outcome === 'succeeded' && terminal.nativeSettled !== true)) return answer(initial, 'rejected', 'invalid')
    finish()
  } else if (event.type === 'turn.completed') {
    if (binding.provider !== 'codex' || !binding.nativeTurnId || nativeTurnId !== binding.nativeTurnId) return answer(initial, 'ignored', 'identity')
    if (!['completed', 'failed', 'interrupted'].includes(String(turn.status))) return answer(initial, 'rejected', 'invalid')
    // A terminal protocol fact clears action; it NEVER writes workflow success/result/lifecycle.
    finish()
  } else if (event.type === 'turn.started') {
    if (binding.provider !== 'codex' || !binding.nativeTurnId || nativeTurnId !== binding.nativeTurnId || turn.status !== 'inProgress') return answer(initial, 'ignored', 'identity')
    stamp(); acknowledge(event.sourceId)
  } else {
    if (!event.type.startsWith('item.') || binding.provider !== 'codex') return answer(initial, 'ignored', 'identity')
    // nativeAction is the S1 parity classifier. Its output contains no user/native text.
    const change = nativeAction(event.type, payload)
    if (!change || !identity(change.id)) return answer(initial, 'ignored', 'irrelevant')
    if (!nativeTurnId) return answer(initial, 'rejected', 'invalid')
    if (binding.provider === 'codex' && binding.nativeTurnId !== null && nativeTurnId !== binding.nativeTurnId) return answer(initial, 'ignored', 'identity')
    const id = nativeProjectionId('operation', binding.nativeSessionId, nativeTurnId, change.id)
    const existing = state.operations.find((operation) => operation.id === id)
    // Finished is a monotonic tombstone: duplicate or late starts cannot resurrect a completed tool.
    if (existing?.ended) return answer(initial, 'ignored', 'terminal')
    if (existing && !existing.pending && change.pending) return answer(initial, 'ignored', 'evidence')
    if (existing && existing.generation === event.connectionGeneration && existing.stream === event.sourceStreamId
      && BigInt(event.sourcePosition) <= BigInt(existing.position) && !change.ended) return answer(initial, 'ignored', 'evidence')
    if (!existing && state.operations.length >= NATIVE_PROJECTION_LIMITS.operations) {
      state.overflow = true; stamp(); return answer(state, 'rejected', 'capacity')
    }
    const operation: Operation = { id, messageId: null, turnId: nativeTurnId ?? null,
      action: mappedAction(change.kind), position: event.sourcePosition, nativeSequence: event.nativeSequence,
      sourceId: event.sourceId, stream: event.sourceStreamId, generation: event.connectionGeneration,
      pending: change.pending, ended: change.ended }
    if (existing) state.operations[state.operations.indexOf(existing)] = operation
    else state.operations.push(operation)
    stamp()
    if (eligible(operation, state, binding)) acknowledge(event.sourceId)
  }
  const bounded = truncateNativeCheckpoint(state)
  return answer(bounded, JSON.stringify(bounded) === before ? 'ignored' : 'changed', 'evidence')
}

/**
 * Bounded reconnect repair from an adapter-qualified COMPLETE current-work view.
 * The caller must hold the same projection guard and persist this checkpoint in
 * its G1 publication. This does not fetch history or submit native work.
 * A complete view advances an internal source floor (NOT the graph cursor). Old
 * starts below that cut cannot resurrect omitted/completed tools after compaction.
 * Empty/incomplete/over-limit views never imply successful completion.
 */
export function reconcileNativeEvidence(previous: NativeProjectionState | undefined, binding: ProjectionBinding,
  cut: Omit<ProjectionEvent, 'type' | 'payload'>, evidence: readonly ProjectionEvent[]): NativeProjectionResult {
  const initial = previous ?? emptyNativeProjection(binding)
  const rejected = (): NativeProjectionResult => ({ state: initial, activity: nativeProjectionActivity(initial, binding), disposition: 'rejected', reason: 'invalid' })
  if (initial.terminalNativeSequence !== null || binding.closed) return { state: initial, activity: nativeProjectionActivity(initial, binding), disposition: 'ignored', reason: 'terminal' }
  if (initial.bindingDigest !== bindingDigest(binding) || (initial.boundTurnId !== null && initial.boundTurnId !== binding.nativeTurnId)
    || cut.connectionGeneration !== binding.connectionGeneration || !binding.nativeTurnId
    || ![cut.nativeSequence, cut.sourcePosition, cut.connectionGeneration].every(sequence)
    || BigInt(cut.connectionGeneration) < BigInt(initial.generation)
    || evidence.length > NATIVE_PROJECTION_LIMITS.operations + NATIVE_PROJECTION_LIMITS.messages) return rejected()
  const priorFloor = initial.evidenceFloor
  if (priorFloor && priorFloor.generation === cut.connectionGeneration
    && (priorFloor.stream !== cut.sourceStreamId || BigInt(priorFloor.position) >= BigInt(cut.sourcePosition))) return rejected()
  const ack = initial.acknowledgement
  if (ack && ack.generation === cut.connectionGeneration && (ack.stream !== cut.sourceStreamId
    || BigInt(ack.position) > BigInt(cut.sourcePosition))) return rejected()
  let state = emptyNativeProjection(binding)
  for (const event of evidence) {
    if (!['item.snapshot', 'graph.native.acknowledged', 'graph.native.terminal'].includes(event.type)
      || event.sourceStreamId !== cut.sourceStreamId || event.connectionGeneration !== cut.connectionGeneration
      || ![event.nativeSequence, event.sourcePosition].every(sequence)
      || BigInt(event.sourcePosition) > BigInt(cut.sourcePosition) || BigInt(event.nativeSequence) > BigInt(cut.nativeSequence)) return rejected()
    const result = projectNativeEvidence(state, binding, event)
    if (result.disposition === 'rejected') return rejected()
    state = result.state
  }
  state.evidenceFloor = { stream: cut.sourceStreamId, position: cut.sourcePosition, generation: cut.connectionGeneration }
  state.lastNativeSequence = maximum(initial.lastNativeSequence, cut.nativeSequence)
  return { state, activity: nativeProjectionActivity(state, binding), disposition: 'changed', reason: 'evidence' }
}
