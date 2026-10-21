import type { GraphActivity, NativeGraphProjectionKey } from '@foreman-code/contracts/wave25'

export interface CurrentNativeActivity {
  key: NativeGraphProjectionKey
  activity: GraphActivity
  lastNativeSequence: string | null
}
export interface CurrentActivityContext {
  closed: boolean
  workflowClosed?: boolean
  /** Only undecided durable requests mean waiting for approval. Delivery is a separate fact. */
  pendingInteractionId?: string
  deliveryBlocked?: boolean
}

/** Shared by native publication, compact snapshots, and the interaction producer's refresh hook. */
export function selectCurrentNodeActivity(workflowNodeId: string, candidates: readonly CurrentNativeActivity[],
  context: CurrentActivityContext): GraphActivity {
  const rank = { active: 0, stale: 1, unknown: 2, none: 3 }
  const matching = candidates.filter((candidate) => candidate.key.execution.workflowNodeId === workflowNodeId)
  if (context.closed) return { workflowNodeId, status: 'none' }
  matching.sort((a, b) => {
    const order = rank[a.activity.status] - rank[b.activity.status]
    if (order) return order
    if (a.key.workKind !== b.key.workKind) return a.key.workKind === 'review' ? -1 : 1
    const left = BigInt(a.lastNativeSequence ?? '0'), right = BigInt(b.lastNativeSequence ?? '0')
    return left === right ? a.key.workId.localeCompare(b.key.workId) : left > right ? -1 : 1
  })
  const review = matching.find((candidate) => candidate.key.workKind === 'review'
    && ['active', 'stale'].includes(candidate.activity.status))
  if (review) return review.activity
  if (context.workflowClosed) return matching.find((candidate) => candidate.key.workKind === 'review'
    && candidate.activity.status === 'unknown')?.activity ?? { workflowNodeId, status: 'none' }
  const workflow = matching.find((candidate) => candidate.key.workKind === 'workflow')
  if (context.pendingInteractionId && workflow) return {
    workflowNodeId, execution: workflow.key.execution, status: 'active', action: 'waiting_approval',
    interactionId: context.pendingInteractionId,
  }
  if (context.pendingInteractionId || context.deliveryBlocked) return { workflowNodeId, status: 'unknown' }
  return matching[0]?.activity ?? { workflowNodeId, status: 'unknown' }
}
