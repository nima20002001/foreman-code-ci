import type { GraphActivity, GraphExecutionIdentity, GraphFact, NodeResolution } from '@foreman-code/contracts/wave25'
import type { DurableInteraction, ReviewJob } from '@foreman-code/contracts'
import type { CurrentNativeActivity } from './nativeActivitySelection.js'

type NodeState = Extract<GraphFact, { type: 'node.state' }>['state']
export interface PublicExecution {
  execution: GraphExecutionIdentity
  state: string
  outcome?: string | null
}

/** Shared public truth, not coordinator bookkeeping. A session, owner lease,
 * transport-open event or checkpoint receipt is never native acknowledgement.
 * Terminal execution outcome precedes accepted result/routing, without creating
 * an accepted digest, resolution or successor. Closed but unsettled work is
 * unknown, not fabricated cancellation, failure or successful completion. */
export function publicNodeLifecycle(state: string | undefined, outcome?: string | null,
  resolution?: NodeResolution['resolution'], context: { closed?: boolean; native?: GraphActivity; continuationBlocked?: boolean } = {}): NodeState['lifecycle'] {
  if (resolution) return resolution === 'excluded' ? 'not_activated' : resolution
  if (state === undefined) return 'not_activated'
  if (state === 'completed') {
    return outcome === 'succeeded' || outcome === 'failed' || outcome === 'canceled' ? outcome : 'unknown'
  }
  if (context.closed) return 'unknown'
  if (state === 'queued' || state === 'waiting') return state
  if (context.continuationBlocked) return 'unknown'
  if (state === 'starting' || state === 'running') {
    if (!context.native) return 'starting'
    return context.native.status === 'active' && !!context.native.acknowledgementId
      && !!context.native.correlationId && !!context.native.action
      && context.native.action !== 'reviewing' && context.native.action !== 'waiting_approval'
      ? 'running' : 'unknown'
  }
  return 'unknown'
}

function sameNativeExecution(left: GraphExecutionIdentity, right: GraphExecutionIdentity): boolean {
  return left.kind !== 'job' && right.kind !== 'job'
    && left.executionId === right.executionId && left.workflowNodeId === right.workflowNodeId
    && left.agentId === right.agentId && left.agentConfigurationVersionId === right.agentConfigurationVersionId
    && left.attempt === right.attempt
}

/** BR1-002 supplies only persisted/guard-qualified candidates, including its
 * proposed after-candidates INSIDE the existing native publication. A review
 * hosted by a completed execution cannot promote that host's workflow lifecycle. */
export function publicNodeState(workflowNodeId: string, current: PublicExecution | undefined,
  resolution: NodeResolution | undefined, native: readonly CurrentNativeActivity[] = [], closed = false, continuationBlocked = false): NodeState {
  const execution = resolution?.execution ?? current?.execution
  const matching = current ? native.filter((item) => item.key.workKind === 'workflow'
    && item.key.workId === current.execution.executionId && sameNativeExecution(item.key.execution, current.execution)
    && item.activity.workflowNodeId === workflowNodeId
    && item.activity.execution && sameNativeExecution(item.activity.execution, current.execution)) : []
  const activity = matching.length === 1 ? matching[0]!.activity : matching.length > 1
    ? { workflowNodeId, status: 'unknown' as const } : undefined
  return { workflowNodeId, lifecycle: publicNodeLifecycle(current?.state, current?.outcome, resolution?.resolution,
    { closed, continuationBlocked, ...(activity ? { native: activity } : {}) }), ...(execution ? { execution } : {}) }
}

/** Pending means an unretired approval obligation, including delivery failure
 * and delivered-but-not-native-acknowledged continuation. Internal resume lease
 * states (pending/resuming/blocked/resumed) do not change this public fact. */
export function publicInteractionPending(status: DurableInteraction['status'], nativeAcknowledged = false): boolean {
  return status !== 'canceled' && (status !== 'delivered' || !nativeAcknowledged)
}
export function publicReviewUnsettled(job: Pick<ReviewJob, 'state' | 'cleanup'>): boolean {
  return job.state !== 'completed' && !(job.state === 'failed' && job.cleanup?.completedAt)
}
export function publicReviewCleanupPending(job: Pick<ReviewJob, 'state' | 'cleanup'>): boolean {
  return publicReviewUnsettled(job) && !job.cleanup?.completedAt
    && (job.cleanup?.nativeState === 'pending' || job.cleanup?.credentialState === 'pending')
}

/** Call only after the existing review settlement/cleanup guards have qualified
 * the proposed job. The final review and retirement belong to the same source;
 * otherwise a full replay retains a row that the current snapshot has dropped. */
export function publicReviewRetirementFacts(job: Pick<ReviewJob, 'id' | 'state' | 'cleanup'>, revision: string): GraphFact[] {
  const retired = job.state === 'completed' || (job.state === 'failed' && !!job.cleanup?.completedAt
    && job.cleanup.nativeState !== 'pending' && job.cleanup.credentialState !== 'pending')
  return retired ? [{ type: 'exchange.retired', exchangeKind: 'review', exchangeId: job.id, finalRevision: revision }] : []
}
