import type {
  HarnessExecution, ReviewJob, RunLiveActivity, RunNodeLiveActivity, WorkflowDefinition, WorkflowRun,
} from '@foreman-code/contracts'
import { nativeAction, nativeObject, nativeString, nodeAction } from './nativeAction.js'

/** Internal DB read model. Raw tool arguments never enter this projection. */
export interface LiveActivityEvent {
  runId: string
  sequence: string
  source: string
  kind: string
  harnessExecutionId: string | null
  occurredAt: string
  payload: Record<string, unknown>
  native?: {
    type: string
    payload: Record<string, unknown>
    connectionId: string | null
    sourceSequence: string
  } | null
}
export interface LiveReviewIdentity {
  executionId: string
  job: Pick<ReviewJob, 'id' | 'reviewerAgentId' | 'interactionId' | 'providerTurnOrMessageId'>
}
type View = Pick<RunNodeLiveActivity, 'state' | 'action'> & { cause: string }
interface Operation {
  id: string; turn: string; kind: NonNullable<RunNodeLiveActivity['action']>['kind']
  connection: string | null; source: bigint; sequence: bigint; pending: boolean
}
interface Lane {
  state: string
  ended: boolean
  operations: Map<string, Operation>
  finished: Set<string>
  pending: Map<string, { handler: string; reviewer?: string; decided: boolean }>
  sequence: bigint
  peer?: string | undefined
  cleanupPending?: boolean
}
interface ExecutionState { execution: HarnessExecution; lane: Lane }
interface ReviewState { executionId: string; lane: Lane }
interface NodeState {
  id: string; agentId: string; executionId?: string
  reviews: Map<string, ReviewState>; view: View; event: RunNodeLiveActivity['event']
}
const idle = (): View => ({ state: 'idle', action: null, cause: 'idle' })
const newLane = (): Lane => ({ state: 'idle', ended: false, operations: new Map(), finished: new Set(), pending: new Map(), sequence: 0n })
const integer = (value: string): bigint => /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : -1n
const key = (left: string, right: string) => JSON.stringify([left, right])
const activeReview = (state: string) => ['pending', 'leased', 'submitted', 'acknowledged'].includes(state)

function lastOperation(lane: Lane): Operation | undefined {
  let last: Operation | undefined
  for (const operation of lane.operations.values()) {
    if (operation.pending) continue
    if (!last || (last.connection === operation.connection
      ? operation.source > last.source : operation.sequence > last.sequence)) last = operation
  }
  return last
}

function laneView(lane: Lane, review: boolean, nameForReviewer: (agentId: string) => string | undefined): View {
  if (lane.ended || lane.state === 'completed' || lane.state === 'idle') return idle()
  const pending = lane.pending.entries().next().value as [string, { handler: string; reviewer?: string; decided: boolean }] | undefined
  if (pending) return { state: 'waiting',
    action: nodeAction(pending[1].decided ? 'waiting_delivery' : 'waiting_approval',
      pending[1].reviewer ? nameForReviewer(pending[1].reviewer) : undefined),
    cause: `interaction:${pending[0]}:${pending[1].decided}` }
  if (review) {
    if (lane.state === 'failed') return lane.cleanupPending
      ? { state: 'waiting', action: nodeAction('checking_review'), cause: 'review-cleanup' } : idle()
    if (lane.state === 'uncertain') return { state: 'waiting', action: nodeAction('checking_review'), cause: 'review-uncertain' }
    if (!activeReview(lane.state)) return { state: 'waiting', action: nodeAction('waiting_review'), cause: `review:${lane.state}` }
  } else if (lane.state === 'waiting' || lane.state === 'queued') return { state: 'waiting', action: null, cause: lane.state }
  const operation = lastOperation(lane)
  return { state: 'working', action: operation ? nodeAction(operation.kind) : review ? nodeAction('reviewing_request', lane.peer) : null,
    cause: operation ? key(operation.turn, operation.id) : review ? 'review' : 'execution' }
}

/** Replay is deterministic by durable identity, not wall time or model prose. */
export function projectRunLiveActivity(input: {
  run: WorkflowRun
  definition: WorkflowDefinition
  executions: readonly HarnessExecution[]
  events: readonly LiveActivityEvent[]
  reviews: readonly LiveReviewIdentity[]
}): RunLiveActivity {
  const { run, definition } = input
  const events = input.events.filter((event) => event.runId === run.id && integer(event.sequence) >= 0n)
    .sort((a, b) => integer(a.sequence) < integer(b.sequence) ? -1 : integer(a.sequence) > integer(b.sequence) ? 1 : 0)
  const nodes = new Map<string, NodeState>(definition.nodes.filter((node) => node.kind !== 'job').map((node) => [node.id, {
    id: node.id, agentId: node.agentId, reviews: new Map(), view: idle(), event: null,
  }]))
  const executions = new Map<string, ExecutionState>()
  for (const execution of input.executions) {
    const node = nodes.get(execution.workflowNodeId)
    if (execution.runId !== run.id || node?.agentId !== execution.agentId
      || run.agentConfigurationVersionIds[execution.agentId] !== execution.agentConfigurationVersionId) continue
    executions.set(execution.id, { execution, lane: newLane() })
    const prior = node.executionId ? executions.get(node.executionId)?.execution : undefined
    if (!prior || prior.attempt < execution.attempt) node.executionId = execution.id
  }
  const nameForNode = (id: string) => {
    const node = definition.nodes.find((candidate) => candidate.id === id)
    return node?.name ?? node?.label
  }
  const nameForReviewer = (id: string) => {
    const matches = definition.nodes.filter((candidate) => candidate.kind !== 'job' && candidate.agentId === id)
    return matches.length === 1 && matches[0] ? nameForNode(matches[0].id) : undefined
  }
  const reviews = new Map<string, LiveReviewIdentity>()
  const reviewTurns = new Map<string, string | null>()
  for (const identity of input.reviews) {
    const execution = executions.get(identity.executionId)?.execution
    if (!execution || execution.agentId !== identity.job.reviewerAgentId) continue
    reviews.set(identity.job.id, identity)
    if (identity.job.providerTurnOrMessageId) {
      const turnKey = key(identity.executionId, identity.job.providerTurnOrMessageId)
      reviewTurns.set(turnKey, reviewTurns.has(turnKey) && reviewTurns.get(turnKey) !== identity.job.id ? null : identity.job.id)
    }
  }

  // Native message metadata is identity evidence, even when its persistence was reordered with a part.
  const messages = new Map<string, string | null>()
  for (const event of events) {
    const execution = executions.get(event.harnessExecutionId ?? '')?.execution
    if (!execution || event.native?.type !== 'message.updated') continue
    const info = nativeObject(event.native.payload.info)
    const id = nativeString(info.id)
    const parent = nativeString(info.parentID)
    if (!id || !parent || info.role !== 'assistant' || info.summary === true || info.sessionID !== execution.nativeSessionId) continue
    const messageKey = key(execution.id, id)
    messages.set(messageKey, messages.has(messageKey) && messages.get(messageKey) !== parent ? null : parent)
  }
  const nativeTurn = (event: LiveActivityEvent): string | undefined => {
    if (!event.native || !event.harnessExecutionId) return undefined
    const payload = event.native.payload
    if (event.native.type.startsWith('message.')) {
      const id = nativeString(nativeObject(payload.part).messageID) ?? nativeString(nativeObject(payload.info).id)
      return id ? messages.get(key(event.harnessExecutionId, id)) ?? undefined : undefined
    }
    return nativeString(payload.turnId) ?? nativeString(nativeObject(payload.turn).id)
  }
  const workflowTurns = new Map<string, Set<string>>()
  for (const event of events) {
    const id = event.harnessExecutionId
    const turn = nativeTurn(event)
    if (!id || !turn || !executions.has(id) || reviewTurns.has(key(id, turn))) continue
    const turns = workflowTurns.get(id) ?? new Set<string>()
    turns.add(turn)
    workflowTurns.set(id, turns)
  }

  const updateView = (node: NodeState, event: LiveActivityEvent) => {
    const base = node.executionId ? executions.get(node.executionId)?.lane : undefined
    const candidates = [
      ...(base ? [{ lane: base, view: laneView(base, false, nameForReviewer), id: node.executionId! }] : []),
      ...[...node.reviews].map(([id, review]) => ({ lane: review.lane, view: laneView(review.lane, true, nameForReviewer), id })),
    ].filter((candidate) => candidate.view.state !== 'idle')
    candidates.sort((a, b) => a.view.state !== b.view.state ? a.view.state === 'working' ? -1 : 1
      : a.lane.sequence > b.lane.sequence ? -1 : a.lane.sequence < b.lane.sequence ? 1 : a.id.localeCompare(b.id))
    const selected = candidates[0]
    const next = selected ? { ...selected.view, cause: key(selected.id, selected.view.cause) } : idle()
    if (next.state !== node.view.state || next.action?.kind !== node.view.action?.kind
      || next.action?.label !== node.view.action?.label || next.cause !== node.view.cause) {
      node.view = next
      node.event = { id: `activity-${run.id}-${event.sequence}`, sequence: event.sequence }
    }
  }
  const seen = new Set<string>()
  let runEvent: RunNodeLiveActivity['event'] = null
  for (const event of events) {
    if (seen.has(event.sequence)) continue
    seen.add(event.sequence)
    const payload = event.payload
    if (payload.liveNodeEvent === 1 && payload.topic === 'run') {
      runEvent = { id: `activity-${run.id}-${event.sequence}`, sequence: event.sequence }
      continue
    }
    const owner = executions.get(event.harnessExecutionId ?? '')
    if (!owner) continue
    const node = nodes.get(owner.execution.workflowNodeId)!
    const sequence = integer(event.sequence)
    if (payload.liveNodeEvent === 1) {
      if (payload.workflowNodeId !== node.id || payload.agentId !== node.agentId) continue
      if (payload.topic === 'execution' && ['queued', 'starting', 'running', 'waiting', 'completed'].includes(String(payload.state))) {
        owner.lane.state = String(payload.state)
        owner.lane.sequence = sequence
        if (payload.state === 'completed') {
          owner.lane.ended = true
          owner.lane.operations.clear()
          owner.lane.pending.clear()
        }
      } else if (payload.topic === 'interaction' && typeof payload.interactionId === 'string') {
        if (owner.lane.ended) continue
        if (payload.status === 'delivered' || payload.deliveryState === 'delivered' || payload.status === 'canceled') {
          owner.lane.pending.delete(payload.interactionId)
          // Native delivery answers the tool request but does not prove the
          // graph resumed this execution. Only its next execution-state event
          // may make the Worker live again.
        } else {
          owner.lane.pending.set(payload.interactionId, { handler: String(payload.handler),
            ...(typeof payload.reviewerAgentId === 'string' ? { reviewer: payload.reviewerAgentId } : {}),
            decided: payload.status !== 'pending' })
          owner.lane.state = 'waiting'
        }
        owner.lane.sequence = sequence
      } else if (payload.topic === 'review' && typeof payload.reviewJobId === 'string') {
        const identity = reviews.get(payload.reviewJobId)
        if (!identity || identity.executionId !== owner.execution.id || identity.job.interactionId !== payload.interactionId
          || !['pending', 'leased', 'submitted', 'acknowledged', 'completed', 'blocked_busy', 'blocked_disconnected', 'uncertain', 'failed'].includes(String(payload.state))) continue
        const review = node.reviews.get(identity.job.id) ?? { executionId: owner.execution.id, lane: newLane() }
        // Only an explicit persisted repair of the old false-completion branch
        // may reopen its job. Late native starts cannot clear the ended fence.
        if (payload.state === 'uncertain' && payload.settlementReopened === true) {
          review.lane.ended = false
          review.lane.operations.clear()
        }
        review.lane.state = String(payload.state)
        review.lane.sequence = sequence
        review.lane.peer = typeof payload.requestingNodeId === 'string' ? nameForNode(payload.requestingNodeId) : undefined
        review.lane.cleanupPending = payload.cleanupPending === true
        if (payload.state === 'completed' || (payload.state === 'failed' && !review.lane.cleanupPending)) {
          review.lane.ended = true
          review.lane.operations.clear()
        }
        node.reviews.set(identity.job.id, review)
      } else continue
      updateView(node, event)
      continue
    }
    if (!event.native || event.source !== 'harness' || event.kind !== 'harness_output') continue
    const turn = nativeTurn(event)
    if (!turn) continue
    const reviewId = reviewTurns.get(key(owner.execution.id, turn))
    let lane: Lane | undefined
    if (reviewTurns.has(key(owner.execution.id, turn))) {
      if (reviewId) lane = node.reviews.get(reviewId)?.lane
      if (!lane || !['submitted', 'acknowledged', 'uncertain'].includes(lane.state)) continue
    } else if (workflowTurns.get(owner.execution.id)?.size === 1) lane = owner.lane
    if (!lane || lane.ended || lane.state === 'idle' || lane.state === 'completed') continue
    const terminal = ['turn.completed', 'turn.failed', 'turn.interrupted'].includes(event.native.type)
      || event.native.payload.nativeTurnStatus === 'completed'
    if (terminal) {
      lane.ended = true
      lane.operations.clear()
      lane.pending.clear()
    } else {
      const change = nativeAction(event.native.type, event.native.payload)
      if (!change) continue
      const operationKey = key(turn, change.id)
      const source = integer(event.native.sourceSequence)
      if (source < 0n) continue
      if (change.ended) {
        lane.operations.delete(operationKey)
        lane.finished.add(operationKey)
      } else if (!lane.finished.has(operationKey)) {
        const prior = lane.operations.get(operationKey)
        if (prior && ((!prior.pending && change.pending)
          || (prior.connection === event.native.connectionId && prior.source >= source))) continue
        lane.operations.set(operationKey, { id: change.id, turn, kind: change.kind,
          connection: event.native.connectionId, source, sequence, pending: change.pending })
      } else continue
    }
    lane.sequence = sequence
    updateView(node, event)
  }
  const active = ['queued', 'running', 'waiting'].includes(run.executionState)
  return {
    runId: run.id, workspaceId: run.workspaceId, workflowId: run.workflowId, workflowVersionId: run.workflowVersionId,
    active, sequence: events.at(-1)?.sequence ?? '0', eventCount: String(seen.size),
    nodes: [...nodes.values()].map((node) => ({ workflowNodeId: node.id, agentId: node.agentId,
      state: active ? node.view.state : 'idle', action: active ? node.view.action : null,
      event: active ? node.event : runEvent })),
  }
}
