import { CiListOutputSchema, CiLogsOutputSchema, CiTestsOutputSchema,
  type CiActivity, type OperatorCiListInput, type CiPlacement, type CiRunJob, type CiTestStatus } from '@foreman-code/contracts'
import { apiClient, type RequestOptions } from '../../../shared/api/client'
import type { AgentNodeState } from '../../../shared/ui/nocturne'
import type { CiServerFlowNode } from './CiServer'

const ciPath = (workspaceId: string) => `/api/management/workspaces/${encodeURIComponent(workspaceId)}/ci`

/** The Board's reads of a Run's CI: the same service as the Operator's ci_list, ci_get testStatus and ci_logs_read. */
export const runCiApi = {
  list: (input: OperatorCiListInput, options?: RequestOptions) => {
    const query = new URLSearchParams({ runId: input.runId })
    if (input.executionId) query.set('executionId', input.executionId)
    return apiClient.request(`${ciPath(input.workspaceId)}?${query}`, CiListOutputSchema, options)
  },
  tests: (input: { workspaceId: string; ticketId: string; status?: readonly CiTestStatus[] }, options?: RequestOptions) =>
    apiClient.request(`${ciPath(input.workspaceId)}/${encodeURIComponent(input.ticketId)}/tests${input.status
      ? `?${new URLSearchParams({ status: input.status.join(',') })}` : ''}`, CiTestsOutputSchema, options),
  logTail: (input: { workspaceId: string; ticketId: string }, options?: RequestOptions) =>
    apiClient.request(`${ciPath(input.workspaceId)}/${encodeURIComponent(input.ticketId)}/logs?maxBytes=32768`,
      CiLogsOutputSchema, options),
}

const ACTIVE: readonly CiRunJob['ci']['state'][] = ['queued', 'starting', 'running']
export const isActiveCiJob = (job: CiRunJob) => ACTIVE.includes(job.ci.state)
/** A finished ticket still collecting results keeps the Board's CI reads refreshing after its Run completes. */
export const ciJobRefreshing = (job: CiRunJob) => isActiveCiJob(job) || job.collection === 'pending'

/** Prefer unfinished work, then the newest ticket, so a completed part cannot hide running CI. */
export function ciNodeActivities(jobs: readonly CiRunJob[]): Map<string, CiActivity> {
  const priority = { running: 3, starting: 2, queued: 1, passed: 0, failed: 0, canceled: 0, lost: 0 }
  const nodes = new Map<string, CiActivity>()
  for (const job of jobs) {
    const previous = nodes.get(job.requester.nodeId)
    if (!previous || priority[job.ci.state] > priority[previous.state]) {
      nodes.set(job.requester.nodeId, job.ci)
    }
  }
  return nodes
}

/** The CI server tower on the Board; edges meet its box-shaped border. */
export const CI_SERVER_SIZE = { width: 184, height: 212 } as const
// Slashes and @ are outside the shared persisted-ID alphabet. Saved node and Run IDs stay unchanged.
export const CI_SERVER_NODE_ID = '@presentation/ci-server'

/** The CI server stands below the Board's nodes, centered under them, so it adds no width; it is not part of the saved graph.
 * Every Board shows it automatically, an empty one at the origin; it can be opened, never selected, dragged or added by hand. */
export function ciServerFlowNode(nodes: readonly { position: { x: number; y: number }; width?: number | undefined; height?: number | undefined }[],
  summary: CiServerSummary, open: () => void): CiServerFlowNode {
  const left = nodes.length ? Math.min(...nodes.map((node) => node.position.x)) : 0
  const right = nodes.length ? Math.max(...nodes.map((node) => node.position.x + (node.width ?? 212))) : 0
  const bottom = nodes.length ? Math.max(...nodes.map((node) => node.position.y + (node.height ?? 212))) + 160 : 0
  return { id: CI_SERVER_NODE_ID, type: 'ciServer', position: { x: (left + right) / 2 - CI_SERVER_SIZE.width / 2, y: bottom },
    // Not selectable or draggable, yet its button must still take clicks.
    ...CI_SERVER_SIZE, style: { ...CI_SERVER_SIZE, pointerEvents: 'all' }, draggable: false, selectable: false, connectable: false,
    deletable: false, data: { summary, rim: 'box', open } }
}

export const CI_PLACEMENT_LABELS: Record<CiPlacement, string> = { host: 'Host CI', github: 'GitHub Actions', circleci: 'CircleCI' }

/** One ci_run request: its parts and partitions share a group and one requesting Agent. */
type GroupOutcome = 'active' | 'passed' | 'failed' | 'canceled'
export type CiGroupStates = ReadonlyMap<string, { nodeId: string; outcome: GroupOutcome }>

function outcomeOf(jobs: readonly CiRunJob[]): GroupOutcome {
  if (jobs.some(isActiveCiJob)) return 'active'
  if (jobs.some((job) => job.ci.state === 'failed' || job.ci.state === 'lost')) return 'failed'
  return jobs.some((job) => job.ci.state === 'canceled') ? 'canceled' : 'passed'
}

export function ciGroupStates(jobs: readonly CiRunJob[]): CiGroupStates {
  const groups = new Map<string, CiRunJob[]>()
  for (const job of jobs) groups.set(job.ci.groupId, [...groups.get(job.ci.groupId) ?? [], job])
  return new Map([...groups].map(([groupId, members]) => [groupId, { nodeId: members[0]!.requester.nodeId, outcome: outcomeOf(members) }]))
}

/** A light between an Agent and the CI server: its request going out, or the group's result coming back. */
export type CiTransfer = { key: string; nodeId: string; direction: 'request' | 'result'; outcome?: Exclude<GroupOutcome, 'active'> }

/** What changed between two reads. The first read replays nothing; a request that is already finished when first
 * seen still travels out and back. */
export function ciTransfers(previous: CiGroupStates | undefined, next: CiGroupStates): CiTransfer[] {
  if (!previous) return []
  const transfers: CiTransfer[] = []
  for (const [groupId, group] of next) {
    const before = previous.get(groupId)
    if (!before) transfers.push({ key: `${groupId}:request`, nodeId: group.nodeId, direction: 'request' })
    if (group.outcome !== 'active' && (!before || before.outcome === 'active')) {
      transfers.push({ key: `${groupId}:result`, nodeId: group.nodeId, direction: 'result', outcome: group.outcome })
    }
  }
  return transfers
}

export type CiServerSummary = { state: AgentNodeState; label: string; running: number; queued: number; failed: number
  total: number; placements: CiPlacement[] }

/** The server's own activity: running while any ticket runs, otherwise how the latest request ended. */
export function ciServerSummary(jobs: readonly CiRunJob[]): CiServerSummary {
  const running = jobs.filter((job) => job.ci.state === 'starting' || job.ci.state === 'running').length
  const queued = jobs.filter((job) => job.ci.state === 'queued').length
  const failed = jobs.filter((job) => job.ci.state === 'failed' || job.ci.state === 'lost').length
  const placements = [...new Set(jobs.flatMap((job) => job.placement ? [job.placement] : []))]
  const base = { running, queued, failed, total: jobs.length, placements }
  if (running || queued) {
    return { ...base, state: running ? 'running' : 'queued',
      label: [running ? `${running} running` : '', queued ? `${queued} queued` : ''].filter(Boolean).join(' · ') }
  }
  // Jobs are newest first, so the first group is the latest request.
  const latest = jobs[0] ? ciGroupStates(jobs.filter((job) => job.ci.groupId === jobs[0]!.ci.groupId)).values().next().value : undefined
  if (!latest) return { ...base, state: 'idle', label: 'Idle' }
  if (latest.outcome === 'failed') return { ...base, state: 'failed', label: 'Last CI failed' }
  if (latest.outcome === 'canceled') return { ...base, state: 'idle', label: 'Last CI canceled' }
  return { ...base, state: 'completed', label: 'Last CI passed' }
}

export function ciJobDuration(job: CiRunJob, now = Date.now()): number | null {
  if (!job.ci.startedAt) return null
  return (job.ci.finishedAt ? Date.parse(job.ci.finishedAt) : now) - Date.parse(job.ci.startedAt)
}
