import { executionQueueReasonLabel, type ExecutionQueueReason, type ActivitySnapshotV1,
  type CiActivity, type DurableInteraction } from '@foreman-code/contracts'
import type { RepeatGraphCurrentV3 } from '@foreman-code/contracts/wave25'
import type { RunIntervalCheck } from '@foreman-code/contracts/run-snapshots'
import type { AgentNodeState } from '../../../shared/ui/nocturne'
import { ciNodePresentation } from '../../run-board/ciPresentation'
import { checkingView } from './pinnedTopology'

/** Why an Agent is paused on a human or Agent answer. Only `pending` (unanswered) requests are waits here. */
export type InteractionWait = { interactionId: string; label: string }
export type RunCiJob = { ci: CiActivity; nodeId: string; agentId: string }
type View = { state: AgentNodeState; label: string }

const ACTIVE_CI: readonly CiActivity['state'][] = ['queued', 'starting', 'running']
export const isActiveCi = (ci: CiActivity) => ACTIVE_CI.includes(ci.state)

/** Pending interactions of this exact Run, keyed by the requesting node. The
 * requester is resolved from its exact execution; an Agent that appears once
 * in the Run's topology is the fallback for an execution outside the bounded cut. */
export function interactionWaits(record: RepeatGraphCurrentV3 | undefined, interactions: readonly DurableInteraction[],
  names: ReadonlyMap<string, string>): Map<string, InteractionWait> {
  const waits = new Map<string, InteractionWait>()
  if (!record || record.state.run.executionState === 'completed') return waits
  const executionNodes = new Map(record.state.executions.map((execution) => [execution.identity.executionId, execution.identity.workflowNodeId]))
  for (const interaction of [...interactions].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    if (interaction.status !== 'pending' || interaction.runId !== record.scope.runId) continue
    const agentNodes = record.topology.nodes.filter((node) => node.kind !== 'job' && node.agentId === interaction.requestingAgentId)
    const nodeId = executionNodes.get(interaction.executionId) ?? (agentNodes.length === 1 ? agentNodes[0]!.workflowNodeId : undefined)
    if (!nodeId || waits.has(nodeId)) continue
    const reviewer = record.state.interactions.find((item) => item.interactionId === interaction.id)?.reviewer?.workflowNodeId
    const reviewerName = reviewer ? names.get(reviewer) : undefined
    const label = interaction.kind === 'work_direction' ? 'Waiting for your decision'
      : interaction.approval.handler === 'user' ? 'Waiting for your approval'
        : reviewerName ? `Waiting for approval from ${reviewerName}` : 'Waiting for approval'
    waits.set(nodeId, { interactionId: interaction.id, label })
  }
  return waits
}

/** A pending answer or an unfinished CI job is what the Agent is waiting on; then a running interval check
 * (from the current cut, or the Run read's live check state); otherwise the lifecycle view stands, with the
 * next check time while one is due. */
export function liveNodeView(base: View, wait: InteractionWait | undefined, ci: CiActivity | undefined,
  check?: RunIntervalCheck, checking?: { check: number; queued: boolean }, queueReason?: ExecutionQueueReason): View {
  if (wait) return { state: 'waiting', label: wait.label }
  if (ci && isActiveCi(ci)) return { state: 'waiting', label: `Waiting for ${ciNodePresentation(ci).label}` }
  if (queueReason) {
    const reason = executionQueueReasonLabel(queueReason)
    const label = checking ? `Loop ${checking.check} queued · ${reason}` : reason
    return { state: 'queued', label }
  }
  if (checking) return checkingView(checking.check, checking.queued)
  if (check?.running) return checkingView(check.checks)
  const view = ci ? { ...base, label: `${base.label} · ${ciNodePresentation(ci).label}` } : base
  return check?.nextCheckAt ? { ...view, label: `${view.label} · Next loop ${new Date(check.nextCheckAt)
    .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` } : view
}

/** Every unfinished CI ticket an Agent of this Run requested, oldest first. */
export function activeCiJobs(activity: ActivitySnapshotV1 | undefined, runId: string): RunCiJob[] {
  if (activity?.scope.kind !== 'workflow_run' || activity.scope.runId !== runId) return []
  const jobs = new Map<string, RunCiJob>()
  for (const work of activity.active) {
    if (work.ref.kind !== 'ci' || work.ref.runId !== runId || !work.ci || !isActiveCi(work.ci)) continue
    jobs.set(work.ci.id, { ci: work.ci, nodeId: work.ref.nodeId, agentId: work.ref.agentId })
  }
  return [...jobs.values()].sort((a, b) => a.ci.queuedAt.localeCompare(b.ci.queuedAt) || a.ci.id.localeCompare(b.ci.id))
}

export function ciComputerLabel(ci: CiActivity): string {
  if (!ci.computer) return 'Waiting for a computer'
  return ci.computer.hostRef.kind === 'cloud' ? ci.computer.label : `${ci.computer.label} · build computer`
}

export function ciJobLabel(ci: CiActivity): string {
  const partition = ci.partition ? ` · partition ${ci.partition.index + 1} of ${ci.partition.count}` : ''
  return `${ci.suite}${ci.part ? ` · ${ci.part}` : ''}${partition}`
}
