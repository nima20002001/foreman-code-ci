import { RunBoardSnapshotSchema, type RunBoardSnapshotGetResult } from '@foreman-code/contracts/run-snapshots'
import { http, HttpResponse } from 'msw'
import { AgentConfigurationVersionSchema } from '@foreman-code/contracts'
import { CurrentRunDetailsSchema, RepeatGraphCurrentV3Schema, repeatGraphTopologyV3,
  makeCurrentWorkflowFixture, RunVersionDetailSchema } from '@foreman-code/contracts/wave25'
import type { RunsSelectorScope } from '../runs-selector/types'
import type { AvailableRunBoardSnapshot } from './model'

export const scope = { workspaceId: 'workspace-snap', workflowId: 'workflow-snap' }
export const runA = RunBoardSnapshotSchema.parse({
  ...scope, runId: 'run-a', kind: 'available', workflowVersionId: 'version-a', capturedAt: '2026-09-20T08:00:00.000Z',
  nodes: [
    { id: 'node-x', agentId: 'agent-x', name: 'X before rename', agentConfigurationVersionId: 'config-x-old',
      position: { x: -80, y: 40 }, size: { width: 180, height: 120 } },
    { id: 'node-y', agentId: 'agent-y', name: 'Y', agentConfigurationVersionId: 'config-y-old',
      position: { x: 500, y: 230 }, size: { width: 260, height: 160 } },
    { id: 'node-z', agentId: 'agent-z', name: 'Z', agentConfigurationVersionId: 'config-z-old',
      position: { x: 900, y: 40 }, size: { width: 180, height: 200 } },
  ],
  edges: [
    { id: 'edge-xy', source: 'node-x', target: 'node-y', kind: 'execution', label: 'Old handoff',
      sourceHandle: 'bottom', targetHandle: 'top', maxWorkHandoffsPerRun: 3, workRequestDirection: 'source_to_target' },
    { id: 'approval-xy', source: 'node-x', target: 'node-y', kind: 'approval', label: 'Old approval',
      sourceHandle: 'bottom', targetHandle: 'top' },
    { id: 'edge-yz', source: 'node-y', target: 'node-z', kind: 'execution' },
  ],
}) as AvailableRunBoardSnapshot
export const runB = RunBoardSnapshotSchema.parse({
  ...scope, runId: 'run-b', kind: 'available', workflowVersionId: 'version-b', capturedAt: '2026-09-21T08:00:00.000Z',
  nodes: [
    { ...runA.nodes[0]!, name: 'X in B', agentConfigurationVersionId: 'config-x-b', position: { x: 100, y: 300 } },
    { ...runA.nodes[2]!, position: { x: 400, y: -120 } },
  ],
  edges: [{ id: 'edge-xz', source: 'node-x', target: 'node-z', kind: 'execution' }],
}) as AvailableRunBoardSnapshot

export function reply(runId: string, target: RunsSelectorScope = scope): RunBoardSnapshotGetResult {
  return { snapshot: RunBoardSnapshotSchema.parse(runId === 'legacy'
    ? { ...target, runId, kind: 'unavailable', reason: 'legacy_run' }
    : { ...(runId === 'run-b' ? runB : runA), ...target, runId }) }
}
export function versionReply(snapshot: RunBoardSnapshotGetResult['snapshot']) {
  if (snapshot.kind !== 'available') throw new Error('The saved version fixture requires an available snapshot.')
  const { workspaceId, workflowId, runId } = snapshot
  const { version } = makeCurrentWorkflowFixture('saved-run-board', 'single')
  const nodes = snapshot.nodes.map(node => {
    if (node.kind === 'job') throw new Error('The saved version fixture supports agent snapshots.')
    return node
  })
  const entryNodeId = snapshot.nodes[0]!.id
  return RunVersionDetailSchema.parse({
    scope: { workspaceId, workflowId, runId, workflowVersionId: snapshot.workflowVersionId, executionSemanticsVersion: 3 },
    version: {
      ...version,
      id: snapshot.workflowVersionId,
      workspaceId,
      workflowId,
      entryNodeId,
      createdAt: snapshot.capturedAt,
      agentConfigurationVersionIds: Object.fromEntries(nodes.map(node =>
        [node.agentId, node.agentConfigurationVersionId])),
      definition: {
        ...version.definition,
        id: workflowId,
        workspaceId,
        entryNodeId,
        nodes: nodes.map(node => ({
          id: node.id, agentId: node.agentId, name: node.name, position: node.position,
          width: node.size.width, height: node.size.height,
        })),
        edges: snapshot.edges,
        ...(snapshot.edges.some(edge => edge.maxWorkHandoffsPerRun !== undefined
          || edge.workRequestDirection !== undefined) ? { handoffs: { contractVersion: 1 } } : {}),
        executionPolicy: { maxParallelism: 1, maxNodeExecutions: snapshot.nodes.length },
      },
    },
  })
}
export function runsUrl(runId: string | null, target: RunsSelectorScope = scope) {
  const search = new URLSearchParams({ workflowId: target.workflowId })
  if (runId !== null) search.set('selectedRunId', runId)
  return `/workspaces/${encodeURIComponent(target.workspaceId)}?${search}`
}

export function pinnedRunHandlers(target: RunsSelectorScope) {
  const source = makeCurrentWorkflowFixture('saved-run-board', 'single')
  const saved = (runId: string) => versionReply(reply(runId, target).snapshot)
  const details = (runId: string) => {
    const { version } = saved(runId)
    return CurrentRunDetailsSchema.parse({
      run: { ...source.run, id: runId, ...target, workflowVersionId: version.id,
        agentConfigurationVersionIds: version.agentConfigurationVersionIds,
        executionState: 'completed', outcome: 'succeeded', startedAt: version.createdAt,
        finishedAt: version.createdAt, result: { outcome: 'succeeded', output: {} } },
      executions: [], activity: [], cleanupPending: false,
    })
  }
  return [
    http.get('*/api/workspaces/:workspaceId/workflows/:workflowId/runs/:runId/graph/v1/current', ({ params }) => {
      const runId = String(params.runId)
      const { scope, version } = saved(runId)
      return HttpResponse.json(RepeatGraphCurrentV3Schema.parse({
        kind: 'current', protocolVersion: 1, scope, topology: repeatGraphTopologyV3(version),
        asOfSequence: '0', retentionFloor: '0', historyCoverage: 'from_admission',
        state: { run: { executionState: 'completed', outcome: 'succeeded', stopRequested: false,
          cleanupPending: false, unsettledReviewCount: 0, pendingInteractionCount: 0 },
          nodes: [], inputBindings: [], interactions: [], reviews: [], occurrences: [], executions: [],
          resolutions: [], results: [], bindings: [], decisions: [] },
      }))
    }),
    http.get('*/api/management/workspaces/:workspaceId/runs', () =>
      HttpResponse.json({ items: ['run-a', 'run-b'].map(id => details(id).run), pageInfo: { nextCursor: null } })),
    http.get('*/api/management/workspaces/:workspaceId/runs/:runId', ({ params }) =>
      HttpResponse.json(details(String(params.runId)))),
    http.get('*/api/management/workspaces/:workspaceId/runs/:runId/executions', ({ params }) => {
      const runId = String(params.runId)
      return HttpResponse.json({ run: { ...saved(runId).scope, executionState: 'completed', outcome: 'succeeded',
        createdAt: saved(runId).version.createdAt, cleanupPending: false },
        items: [], pageInfo: { nextCursor: null } })
    }),
    http.get('*/api/management/workspaces/:workspaceId/runs/:runId/handoffs', ({ params }) => {
      const { scope, version } = saved(String(params.runId))
      return HttpResponse.json({ scope, policy: version.definition.handoffs ? 'work' : 'not_configured',
        runState: 'completed', connections: [], routes: [], notices: [], unresolved: [], directionWait: false })
    }),
    http.get('*/api/management/workspaces/:workspaceId/agents/:agentId/versions/:versionId', ({ params }) =>
      HttpResponse.json({ version: AgentConfigurationVersionSchema.parse({ ...source.configurations[0],
        workspaceId: target.workspaceId, agentId: String(params.agentId), id: String(params.versionId) }) })),
  ]
}
