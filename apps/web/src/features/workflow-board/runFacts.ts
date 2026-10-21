import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { WorkflowRunSummary } from '@foreman-code/contracts'
import type { RepeatGraphCurrentV3 } from '@foreman-code/contracts/wave25'
import type { AgentNodeState, Tone } from '../../shared/ui/nocturne'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { currentRunKey } from './currentRunQuery'
import { useWorkflowBoard } from './context'
import { checkingView, pinnedNodeStates, runningIntervalChecks, type PinnedNodeDisplayCut } from './inspect/pinnedTopology'

/** Cache-only subscriber: no Query observer with a competing queryFn. Only
 * CurrentRunObserver owns current-state fetching and invalidation/refetch work. */
export function useSelectedRunQueryState() {
  const scope = useWorkflowBoard()?.run, cache = useQueryClient(), generation = sessionGeneration()
  const { workspaceId, workflowId, runId, workflowVersionId, executionSemanticsVersion } = scope ?? {}
  const key = useMemo(() => workspaceId && workflowId && runId && workflowVersionId && executionSemanticsVersion === 3
    ? currentRunKey({ workspaceId, workflowId, runId, workflowVersionId, executionSemanticsVersion }, generation) : undefined,
    [workspaceId, workflowId, runId, workflowVersionId, executionSemanticsVersion, generation])
  const subscribe = useCallback((notify: () => void) => cache.getQueryCache().subscribe(notify), [cache])
  const snapshot = useCallback(() => key ? cache.getQueryState<RepeatGraphCurrentV3>(key) : undefined, [cache, key])
  return useSyncExternalStore(subscribe, snapshot, () => undefined)
}
export function useSelectedRunRecord(): RepeatGraphCurrentV3 | undefined {
  const state = useSelectedRunQueryState()
  return state?.status === 'error' || state?.fetchStatus === 'paused' ? undefined : state?.data
}
export type RunNodeView = { state: AgentNodeState; label: string; activity?: string; inRun: boolean }
const words: Record<string, [AgentNodeState, string]> = {
  not_activated: ['idle', 'Not started'], queued: ['queued', 'Queued'], starting: ['queued', 'Starting'], running: ['running', 'Running'],
  waiting: ['waiting', 'Waiting'], succeeded: ['completed', 'Completed'], failed: ['failed', 'Failed'], canceled: ['idle', 'Cancelled'],
  skipped: ['idle', 'Skipped'], excluded: ['idle', 'Not selected'], interrupted: ['unavailable', 'Interrupted'],
  uncertain: ['unavailable', 'Unconfirmed'], unknown: ['unavailable', 'Unavailable'],
}
export const lifecycleView = (lifecycle?: string): [AgentNodeState, string] => words[lifecycle ?? 'unknown'] ?? words.unknown!
export function runNodeView(record: (PinnedNodeDisplayCut & Pick<RepeatGraphCurrentV3, 'topology'>) | undefined,
  selected: boolean, nodeId: string, agentId: string): RunNodeView {
  if (!selected) return { state: 'idle', label: 'Idle', inRun: false }
  if (!record) return { state: 'unavailable', label: 'Unavailable', inRun: false }
  if (!record.topology.nodes.some((node) => node.workflowNodeId === nodeId && node.kind!=='job' && node.agentId === agentId)) return { state: 'idle', label: 'Not in this Run', inRun: false }
  const latest = pinnedNodeStates(record).get(nodeId)
  // A running interval check wakes the Agent; its graph state returns when the check finishes.
  const check = runningIntervalChecks(record).get(nodeId)
  const awake = check ? checkingView(check.check, check.queued) : undefined
  const [state, label] = awake ? [awake.state, awake.label] : lifecycleView(latest?.label ?? 'not_activated')
  if (!latest?.occurrenceIndex) return { state, label, inRun: true }
  const attempt = latest.attempt ? `technical attempt ${latest.attempt}` : 'no execution'
  return { state, label, inRun: true, activity: `Business occurrence ${latest.occurrenceIndex} · ${attempt}` }
}
const ACTIVE = ['queued', 'running', 'waiting', 'interrupted']
export const isActiveRun = (run: Pick<WorkflowRunSummary, 'executionState' | 'cleanupPending'>) => ACTIVE.includes(run.executionState) || Boolean(run.cleanupPending)
export function runLabel(state: string, outcome: string) {
  if (state === 'running') return 'Running'
  if (state === 'waiting') return 'Waiting'
  if (state === 'queued') return 'Queued'
  if (state === 'interrupted') return 'Interrupted'
  return outcome === 'succeeded' ? 'Completed' : outcome === 'failed' ? 'Failed' : outcome === 'canceled' ? 'Cancelled' : 'Finished'
}
export function runTone(state: string, outcome: string): Tone {
  if (state === 'running' || state === 'queued') return 'info'
  if (state === 'waiting' || state === 'interrupted') return 'warning'
  return outcome === 'succeeded' ? 'success' : outcome === 'failed' ? 'danger' : 'neutral'
}
export const when = (value?: string) => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not started'

/** The same short Run name the Runs table shows (server rule: the id's first 8 characters after "run-"). */
export const shortRunId = (runId: string) => runId.replace(/^run-/, '').slice(0, 8) || runId.slice(0, 8)
