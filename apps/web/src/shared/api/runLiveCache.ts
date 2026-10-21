import { replaceEqualDeep } from '@tanstack/react-query'
import { RunLiveSequenceSchema } from '@foreman-code/contracts'
import type { CurrentRunDetails } from '@foreman-code/contracts/wave25'

function hasActivityOrder(activity: CurrentRunDetails['liveActivity']): boolean {
  return Boolean(activity && RunLiveSequenceSchema.safeParse(activity.sequence).success
    && RunLiveSequenceSchema.safeParse(activity.eventCount).success)
}

/** Query-cache ownership only; never copy server state into a graph/Zustand store. */
export function keepLatestRunResponse(current: CurrentRunDetails | undefined, incoming: CurrentRunDetails): CurrentRunDetails {
  if (!isRunResponse(incoming)) return current ?? incoming
  if (!current || !isRunResponse(current) || current.run.id !== incoming.run.id || current.run.workspaceId !== incoming.run.workspaceId
    || current.run.workflowId !== incoming.run.workflowId) return incoming
  if (current.run.workflowVersionId !== incoming.run.workflowVersionId
    || current.run.executionSemanticsVersion !== incoming.run.executionSemanticsVersion) return current

  const before = current.liveActivity
  const after = incoming.liveActivity
  // Check ordering BEFORE promoting a terminal response. Otherwise an older
  // completion can overwrite a newer persisted Stop/current/cleanup fact.
  if (before) {
    if (!after || !hasActivityOrder(after)) return current
    if (hasActivityOrder(before) && (BigInt(after.eventCount) < BigInt(before.eventCount)
      || BigInt(after.sequence) < BigInt(before.sequence))) return current
  }
  // These are persisted S0 facts, not optimistic Stop or connection-health flags.
  if (current.run.stopCause && !incoming.run.stopCause) return current
  if (current.run.executionState === 'completed') {
    if (incoming.run.executionState !== 'completed') return current
    if (current.run.outcome !== undefined && incoming.run.outcome !== current.run.outcome) return current
  }
  if (current.run.executionState === 'interrupted'
    && ['queued', 'running', 'waiting'].includes(incoming.run.executionState)) return current
  return incoming
}

function isRunResponse(value: unknown): value is CurrentRunDetails {
  if (!value || typeof value !== 'object' || !('run' in value) || !('executions' in value) || !('activity' in value)) return false
  const run = value.run
  return Boolean(run && typeof run === 'object' && 'id' in run && typeof run.id === 'string'
    && 'workspaceId' in run && typeof run.workspaceId === 'string'
    && 'workflowId' in run && typeof run.workflowId === 'string' && 'executionSemanticsVersion' in run && run.executionSemanticsVersion === 3 && Array.isArray(value.executions) && Array.isArray(value.activity))
}

/**
 * Query uses structuralSharing for both cached responses and select results.
 * Only complete responses may enter the lifecycle/order guard; a scalar or a
 * selected node has no .run. Keep the existing guard separately testable.
 */
export function shareRunResponseOrSelection<T>(current: unknown, incoming: T): T {
  if (!isRunResponse(incoming)) return replaceEqualDeep(current, incoming)
  const previous = isRunResponse(current) ? current : undefined
  const accepted = keepLatestRunResponse(previous, incoming)
  if (accepted === previous) return accepted as T
  if (!previous || previous.run.id !== incoming.run.id || previous.run.workspaceId !== incoming.run.workspaceId
    || previous.run.workflowId !== incoming.run.workflowId) return incoming
  const shared = replaceEqualDeep(previous, incoming)
  if (!previous.liveActivity || !incoming.liveActivity || !shared.liveActivity
    || !Array.isArray(previous.liveActivity.nodes) || !Array.isArray(incoming.liveActivity.nodes)) return shared
  // ID-based sharing also retains records when a coherent response reorders nodes.
  const byId = new Map(previous.liveActivity.nodes
    .filter((node) => node && typeof node.workflowNodeId === 'string')
    .map((node) => [node.workflowNodeId, node]))
  const nodes = incoming.liveActivity.nodes.map((node) => node && typeof node.workflowNodeId === 'string'
    ? replaceEqualDeep(byId.get(node.workflowNodeId), node) : node)
  const previousNodes = previous.liveActivity.nodes
  const sharedNodes = nodes.length === previousNodes.length && nodes.every((node, index) => node === previousNodes[index])
    ? previousNodes : nodes
  if (shared.liveActivity.nodes === sharedNodes) return shared
  return { ...shared, liveActivity: { ...shared.liveActivity, nodes: sharedNodes } } as T
}
