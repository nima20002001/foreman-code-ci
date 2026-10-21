import type { RunBoardSnapshotGetResult, RunDropdownPage, RunDropdownSummary } from '@foreman-code/contracts/run-snapshots'

export const scope = { workspaceId: 'workspace-1', workflowId: 'workflow-runs' }
export const runA: RunDropdownSummary = { runId: 'run-a', shortId: 'short-A',
  startedAt: new Date(2026, 8, 27, 10, 0).toISOString(), status: 'succeeded', trigger: 'manual' }
export const runB: RunDropdownSummary = { runId: 'run-b', shortId: 'short-B',
  startedAt: new Date(2026, 8, 27, 9, 0).toISOString(), status: 'failed', trigger: 'schedule' }
export const runC: RunDropdownSummary = { runId: 'run-c', shortId: 'short-C',
  startedAt: new Date(2026, 8, 26, 10, 0).toISOString(), status: 'interrupted', trigger: 'manual' }
export const page = (items: RunDropdownSummary[], nextCursor: string | null = null): RunDropdownPage => ({
  items, pageInfo: { nextCursor },
})
export const snapshot = (runId: string, version = `version-${runId}`, target = scope): RunBoardSnapshotGetResult => ({
  snapshot: { kind: 'available', ...target, runId, workflowVersionId: version,
    capturedAt: '2026-09-27T00:00:00.000Z', nodes: [], edges: [] },
})
export const runsUrl = (runId: string | null, target = scope) =>
  `/workspaces/${encodeURIComponent(target.workspaceId)}?${new URLSearchParams({ workflowId: target.workflowId,
    ...(runId === null ? {} : { selectedRunId: runId }) })}`
