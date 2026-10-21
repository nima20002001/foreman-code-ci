import { RunLiveActivitySchema, RunNodeLiveActivitySchema } from '@foreman-code/contracts'
import { type RunNodeLiveActivity } from '@foreman-code/contracts'
import { type CurrentRunDetails as GetRunResponse } from '@foreman-code/contracts/wave25'

type LiveActivity = NonNullable<GetRunResponse['liveActivity']>
const indexes = new WeakMap<LiveActivity, ReadonlyMap<string, RunNodeLiveActivity>>()
const EMPTY_INDEX: ReadonlyMap<string, RunNodeLiveActivity> = new Map()

/**
 * Validate the S0 envelope once and each leaf once per accepted activity object.
 * Keep original Query references: schema parsing is a guard, not another fact store.
 * A malformed/ambiguous leaf is unavailable; it does not poison unrelated nodes.
 */
export function graphRuntimeIndex(activity: LiveActivity): ReadonlyMap<string, RunNodeLiveActivity> {
  if (!activity || typeof activity !== 'object') return EMPTY_INDEX
  let index = indexes.get(activity)
  if (!index) {
    const nodes = new Map<string, RunNodeLiveActivity>()
    // Reuse the current shared schema, without cloning/validating every node per subscriber.
    if (Array.isArray(activity.nodes) && RunLiveActivitySchema.safeParse({ ...activity, nodes: [] }).success) {
      const seen = new Set<string>()
      for (const node of activity.nodes) {
        if (!node || typeof node !== 'object' || typeof node.workflowNodeId !== 'string') continue
        const id = node.workflowNodeId
        if (seen.has(id)) { nodes.delete(id); continue }
        seen.add(id)
        if (!RunNodeLiveActivitySchema.safeParse(node).success
          || (!activity.active && node.state !== 'idle')
          || (node.event && BigInt(node.event.sequence) > BigInt(activity.sequence))) continue
        nodes.set(id, node)
      }
    }
    index = nodes
    indexes.set(activity, index)
  }
  return index
}

export type GraphRuntimeScope = {
  workspaceId: string
  workflowId: string
  runId?: string
  /** The source definition must have this immutable version. Unpinned legacy sources show unavailable. */
  workflowVersionId?: string
  /** A locally edited or incompatible board must not receive a live overlay. */
  overlayAllowed: boolean
  /** Can hide observations, never establish activity or clear semantic uncertainty. */
  unavailable?: boolean
}

export function selectGraphNodeActivity(
  response: GetRunResponse,
  scope: GraphRuntimeScope,
  workflowNodeId: string,
  agentId: string,
): RunNodeLiveActivity | undefined {
  // Query normally receives schema-validated HTTP responses. Also fail safely for
  // partial cache restoration and unsupported future values at this read-only seam.
  if (!response || typeof response !== 'object') return undefined
  const { run, liveActivity } = response
  if (!run || typeof run !== 'object' || !scope.overlayAllowed || scope.unavailable || !scope.runId || run.id !== scope.runId
    || run.workspaceId !== scope.workspaceId || run.workflowId !== scope.workflowId
    || !scope.workflowVersionId || run.workflowVersionId !== scope.workflowVersionId
    || run.stopCause || !liveActivity?.active || !['queued', 'running', 'waiting'].includes(run.executionState)
    || liveActivity.runId !== run.id || liveActivity.workspaceId !== run.workspaceId
    || liveActivity.workflowId !== run.workflowId || liveActivity.workflowVersionId !== run.workflowVersionId) return undefined
  const node = graphRuntimeIndex(liveActivity).get(workflowNodeId)
  return node?.agentId === agentId ? node : undefined
}
