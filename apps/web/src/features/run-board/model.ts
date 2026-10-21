import type { Edge, Node, ReactFlowProps } from '@xyflow/react'
import type { RunBoardSnapshot, RunBoardNodeSnapshot, RunBoardEdgeSnapshot } from '@foreman-code/contracts/run-snapshots'
import { GRAPH_NODE_DEFAULT_SIZE } from '../graph/mapper'
import { layoutHierarchy } from '../graph/hierarchyLayout'
import { agentProductRoleLabel, isHierarchyReportingRoute, type ActivitySnapshotV1, type CiActivity, type WorkRef,
  type WorkflowHierarchyReadResult } from '@foreman-code/contracts'

export type AvailableRunBoardSnapshot = Extract<RunBoardSnapshot, { kind: 'available' }>
export type SavedBoardNode = Node<{ snapshot: RunBoardNodeSnapshot; role?: string; reportingParent?: string; ci?: CiActivity; inspect?: () => void }, 'savedBoardNode'>
export type SavedBoardEdge = Edge<{ snapshot: RunBoardEdgeSnapshot; lane: number; reportingParent?: string }, 'savedBoardEdge'>

/** No caller-provided canvas props may override these locks. Viewport movement is harmless. */
export const READ_ONLY_FLOW_PROPS = {
  nodesDraggable: false, nodesConnectable: false, edgesReconnectable: false,
  elementsSelectable: false, selectNodesOnDrag: false, selectionOnDrag: false,
  connectOnClick: false, deleteKeyCode: null, selectionKeyCode: null, multiSelectionKeyCode: null,
  disableKeyboardA11y: true, nodesFocusable: true, edgesFocusable: true,
} as const satisfies Partial<ReactFlowProps<SavedBoardNode, SavedBoardEdge>>

/** A presentation projection, never a draft installation or current-Agent lookup.
 * Copy mutable geometry for React Flow; retain the contract's readonly facts in data.
 * Keep every edge (including an approval parallel to a handoff), in snapshot order.
 */
export function projectRunBoard(snapshot: AvailableRunBoardSnapshot, activity?: ActivitySnapshotV1,
  hierarchy?: WorkflowHierarchyReadResult): { nodes: SavedBoardNode[]; edges: SavedBoardEdge[] } {
  const names = new Map(snapshot.nodes.map((node) => [node.id, node.name]))
  const cis = runBoardCi(snapshot, activity)
  const saved = hierarchy?.workspaceId === snapshot.workspaceId && hierarchy.workflowId === snapshot.workflowId
    && hierarchy.workflowVersionId === snapshot.workflowVersionId && hierarchy.run?.runId === snapshot.runId ? hierarchy : undefined
  const identities = new Map(saved?.agents.filter(agent => snapshot.nodes.some(node => node.kind !== 'job'
    && node.id === agent.workflowNodeId && node.agentId === agent.agentId && node.agentConfigurationVersionId === agent.configurationVersionId))
    .map(agent => [agent.workflowNodeId, agent]))
  // Saved positions and sizes are not drawn: a Run lays itself out as the same hierarchy the Board does.
  const size = { width: GRAPH_NODE_DEFAULT_SIZE, height: GRAPH_NODE_DEFAULT_SIZE }
  const placed = layoutHierarchy(snapshot.nodes.map((node) => ({ id: node.id, ...size })), snapshot.edges)
  const nodes: SavedBoardNode[] = snapshot.nodes.map((node) => ({
    id: node.id, type: 'savedBoardNode', position: { ...placed.get(node.id)! }, origin: [0, 0],
    initialWidth: size.width, initialHeight: size.height,
    style: { ...size }, data: { snapshot: node,
      ...(identities.has(node.id) ? { role: agentProductRoleLabel(identities.get(node.id)!.productRole) } : {}),
      ...(saved?.hierarchy ? { reportingParent: node.id === saved.hierarchy.masterNodeId ? 'None (Master)'
        : names.get(saved.hierarchy.parents.find(member => member.workflowNodeId === node.id)?.parentNodeId ?? '') ?? 'Unavailable' } : {}),
      ...(cis.has(node.id) ? { ci: cis.get(node.id)! } : {}) },
    draggable: false, connectable: false, selectable: false, deletable: false, focusable: true,
    ariaRole: 'group', ariaLabel: `${node.name}, saved ${node.kind==='job'?'job':'agent'}, read only`,
    domAttributes: { title: node.kind==='job'?`${node.name}\nJob: ${node.jobDefinitionId}\nRevision: ${node.jobDefinitionRevision}`:`${node.name}\nAgent: ${node.agentId}\nConfiguration: ${node.agentConfigurationVersionId}` },
  }))
  const lanes = new Map<string, number>()
  const edges: SavedBoardEdge[] = snapshot.edges.map((edge) => {
    const pair = JSON.stringify([edge.source, edge.target].sort())
    const index = lanes.get(pair) ?? 0
    lanes.set(pair, index + 1)
    // Canonical orientation keeps reverse-direction edges on different curves too.
    const lane = (index % 2 ? Math.ceil(index / 2) : -index / 2) * (edge.source < edge.target ? 1 : -1)
    return {
      id: edge.id, type: 'savedBoardEdge', source: edge.source, target: edge.target,
      sourceHandle: edge.sourceHandle ?? 'right', targetHandle: edge.targetHandle ?? 'left',
      data: { snapshot: edge, lane, ...(isHierarchyReportingRoute(saved?.hierarchy ?? undefined, edge)
        ? { reportingParent: names.get(edge.source) ?? edge.source } : {}) },
      selectable: false, deletable: false, reconnectable: false, focusable: true,
      ariaRole: 'img',
      ariaLabel: `${isHierarchyReportingRoute(saved?.hierarchy ?? undefined, edge) ? 'Orchestrates' : edge.kind === 'approval' ? 'Approval' : 'Handoff'} from ${names.get(edge.source)} to ${names.get(edge.target)}${edge.label ? `: ${edge.label}` : ''}, read only`,
    }
  })
  return { nodes, edges }
}

export function runBoardCi(snapshot: AvailableRunBoardSnapshot, activity?: ActivitySnapshotV1) {
  const cis = new Map<string, CiActivity>()
  if (activity?.scope.kind !== 'workflow_run' || activity.scope.runId !== snapshot.runId
    || activity.scope.workspaceId !== snapshot.workspaceId || activity.scope.workflowId !== snapshot.workflowId
    || activity.scope.workflowVersionId !== snapshot.workflowVersionId) return cis
  const accept = (owner: WorkRef, ci: CiActivity) => {
    if (owner.kind !== 'ci' || owner.runId !== snapshot.runId || owner.ticketId !== ci.id
      || owner.workspaceId !== snapshot.workspaceId || owner.workflowId !== snapshot.workflowId
      || owner.workflowVersionId !== snapshot.workflowVersionId) return
    const node = snapshot.nodes.find(node => node.id === owner.nodeId)
    if (!node || node.kind === 'job' || node.agentId !== owner.agentId) return
    cis.set(node.id, ci)
  }
  for (const item of activity.activities) {
    if (item.kind === 'diagnostic' && item.ci) accept(item.owner, item.ci)
  }
  const priority = { queued: 0, starting: 1, running: 2, passed: -1, failed: -1, canceled: -1, lost: -1 }
  for (const work of [...activity.active].sort((a, b) => (a.ci ? priority[a.ci.state] : -1)
    - (b.ci ? priority[b.ci.state] : -1))) {
    if (work.ci) accept(work.ref, work.ci)
  }
  return cis
}
