import { createContext, useMemo } from 'react'
import type { CiActivity } from '@foreman-code/contracts'
import type { RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import type { AgentNodeState, AgentNodeTransition } from '../../shared/ui/nocturne'
import { useInteractionsQuery } from '../../shared/api/query'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { useCurrentRunQuery } from '../workflow-board/currentRunQuery'
import { useRunChoreography } from '../workflow-board/inspect/runChoreography'
import { runningIntervalChecks } from '../workflow-board/inspect/pinnedTopology'
import { interactionWaits, isActiveCi, liveNodeView } from '../workflow-board/inspect/runLiveStatus'
import { ciNodePresentation } from './ciPresentation'

export type RunLiveNodeView = { state: AgentNodeState; label: string; transition?: AgentNodeTransition; transitionKey?: number }
/** Live node words beside the saved Board's immutable node data, so a poll never rebuilds React Flow's nodes. */
export const RunLiveNodes = createContext<ReadonlyMap<string, RunLiveNodeView> | undefined>(undefined)

/** Each node's turn, queue, CI and pending-decision state from the Run's canonical current cut.
 * Reads only while the Board is shown; a denied or failed read leaves the saved presentation. */
export function useRunLiveNodes(scope: RepeatGraphScopeV3, names: ReadonlyMap<string, string>,
  cis: ReadonlyMap<string, CiActivity>, visible: boolean): ReadonlyMap<string, RunLiveNodeView> | undefined {
  const current = useCurrentRunQuery(visible ? scope : undefined, visible)
  const denied = useProtectedAccessError(current)
  const record = denied || current.isError ? undefined : current.data
  const live = Boolean(visible && record && record.state.run.executionState !== 'completed')
  // The same pending-request read as the approval inbox; this Run's requests name why its Agents wait.
  const pending = useInteractionsQuery({ workspaceId: scope.workspaceId, workflowId: scope.workflowId, status: 'pending', limit: 100 }, live)
  const waits = useMemo(() => interactionWaits(record, pending.isError ? [] : pending.data?.items ?? [], names),
    [record, pending.data, pending.isError, names])
  const checking = useMemo(() => live ? runningIntervalChecks(record) : new Map<string, { check: number; queued: boolean }>(), [record, live])
  const choreography = useRunChoreography(record, undefined)
  const views: [string, RunLiveNodeView][] = []
  for (const nodeId of names.keys()) {
    const ci = cis.get(nodeId)
    const base = record ? choreography.nodes.get(nodeId) ?? { state: 'idle' as const, label: 'Not started' } : undefined
    // Without the current cut a node still says it waits on its CI, or shows that CI's result.
    if (!base) { if (ci) views.push([nodeId, isActiveCi(ci) ? liveNodeView(ciNodePresentation(ci), undefined, ci) : ciNodePresentation(ci)]); continue }
    const view = liveNodeView(base, waits.get(nodeId), ci, undefined, checking.get(nodeId))
    views.push([nodeId, { state: view.state, label: view.label,
      ...(base.transition && view.state === base.state ? { transition: base.transition, transitionKey: base.transitionKey } : {}) }])
  }
  const key = views.length ? JSON.stringify(views) : undefined
  return useMemo(() => key ? new Map(JSON.parse(key) as [string, RunLiveNodeView][]) : undefined, [key])
}
