import { assertGraphRunTransition, assertGraphNodeTransition } from './reliability.js'
import {
  RunGraphEventsResponseSchema, RunGraphSnapshotSchema, type RunGraphSnapshot,
} from './protocol.js'
import { sameGraphScope, type PublicGraphProjection, type GraphFact } from './graphPrimitives.js'

type GraphFixtureApplyResult = {
  kind: 'applied' | 'duplicate' | 'discarded' | 'reset'
  snapshot: RunGraphSnapshot
  appliedEventIds: string[]
}
/** A compileable reference consumer, NOT a second browser fact store or animation engine. */
export function applyRunGraphPageFixture(
  snapshot: RunGraphSnapshot, response: unknown, responseEpoch: number, currentEpoch: number,
): GraphFixtureApplyResult {
  const unchanged = (kind: GraphFixtureApplyResult['kind']): GraphFixtureApplyResult => ({ kind, snapshot, appliedEventIds: [] })
  if (responseEpoch !== currentEpoch) return unchanged('discarded')
  const parsed = RunGraphEventsResponseSchema.safeParse(response)
  if (!parsed.success || parsed.data.kind === 'reset' || !sameGraphScope(snapshot.scope, parsed.data.scope)) return unchanged('reset')
  const page = parsed.data
  if (BigInt(page.throughSequence) <= BigInt(snapshot.asOfSequence)) return unchanged('duplicate')
  if (page.baseSequence !== snapshot.asOfSequence) return unchanged('reset')
  let state = snapshot.state
  const appliedEventIds: string[] = []
  try {
    for (const batch of page.batches) for (const event of batch.events) {
      state = applyFact(state, event.fact)
      appliedEventIds.push(event.eventId)
    }
    const candidate: RunGraphSnapshot = { ...snapshot, state, asOfSequence: page.throughSequence, retentionFloor: page.retentionFloor }
    // Validate the whole candidate before committing ANY fact or cursor. Keep
    // original references for unchanged entities; parse's cloned result is not used.
    if (!RunGraphSnapshotSchema.safeParse(candidate).success) return unchanged('reset')
    return { kind: 'applied', snapshot: candidate, appliedEventIds }
  } catch { return unchanged('reset') }
}
function upsert<T>(values: T[], value: T, identity: (item: T) => string): T[] {
  const index = values.findIndex((item) => identity(item) === identity(value))
  if (index < 0) return [...values, value]
  return values.map((item, position) => position === index ? value : item)
}
function applyFact(state: PublicGraphProjection, fact: GraphFact): PublicGraphProjection {
  switch (fact.type) {
    case 'run.state':
      assertGraphRunTransition(state.run, fact.state)
      return { ...state, run: fact.state }
    case 'input.bound': return { ...state, inputBindings: upsert(state.inputBindings, fact.binding, (item) => item.bindingId) }
    case 'interaction.state': return { ...state, interactions: upsert(state.interactions, fact.interaction, (item) => item.interactionId) }
    case 'review.state': return { ...state, reviews: upsert(state.reviews, fact.review, (item) => item.reviewJobId) }
    case 'exchange.retired': {
      if (fact.exchangeKind === 'review') {
        const review = state.reviews.find((item) => item.reviewJobId === fact.exchangeId)
        if (review && (BigInt(review.revision) > BigInt(fact.finalRevision) || !['completed', 'failed'].includes(review.state)
          || review.nativeCleanup === 'pending' || review.credentialCleanup === 'pending')) throw new Error('GRAPH_FIXTURE_UNSETTLED')
        return { ...state, reviews: state.reviews.filter((item) => item.reviewJobId !== fact.exchangeId) }
      }
      const interaction = state.interactions.find((item) => item.interactionId === fact.exchangeId)
      if (interaction && (BigInt(interaction.revision) > BigInt(fact.finalRevision) || !['delivered', 'canceled'].includes(interaction.status))) throw new Error('GRAPH_FIXTURE_UNSETTLED')
      // The retirement producer additionally proves exact native/review/cleanup
      // settlement. Retirement does not assert that the Worker resumed.
      return { ...state, interactions: state.interactions.filter((item) => item.interactionId !== fact.exchangeId) }
    }
    case 'worker.resumed': {
      const current = state.interactions.find((item) => item.interactionId === fact.interactionId)
      if (!current || current.requester.executionId !== fact.requester.executionId || current.deliveryState !== 'delivered') throw new Error('GRAPH_FIXTURE_GAP')
      return { ...state, interactions: upsert(state.interactions, {
        ...current, resumeState: 'acknowledged', resumeAcknowledgementId: fact.acknowledgementId,
      }, (item) => item.interactionId) }
    }
    default: {
      const id = fact.type === 'node.state' ? fact.state.workflowNodeId
        : fact.type === 'node.activity' ? fact.activity.workflowNodeId
          : fact.type === 'node.attention' ? fact.attention.workflowNodeId
            : fact.type === 'node.resolved' ? fact.resolution.workflowNodeId : fact.execution.workflowNodeId
      if (!state.nodes.some((node) => node.state.workflowNodeId === id)) throw new Error('GRAPH_FIXTURE_SCOPE')
      return { ...state, nodes: state.nodes.map((node) => {
        if (node.state.workflowNodeId !== id) return node
        if (fact.type === 'node.state') {
          assertGraphNodeTransition(node.state, fact.state)
          if (state.run.stopRequested && fact.state.lifecycle !== node.state.lifecycle
            && ['queued', 'starting', 'running', 'waiting'].includes(fact.state.lifecycle)) throw new Error('GRAPH_STOP_CONFLICT')
          return { ...node, state: fact.state }
        }
        if (fact.type === 'node.activity') return { ...node, activity: fact.activity }
        if (fact.type === 'node.attention') return { ...node, attention: fact.attention }
        if (fact.type === 'node.resolved') return { ...node, resolution: fact.resolution }
        return { ...node, acceptedResultDigest: fact.resultDigest }
      }) }
    }
  }
}
