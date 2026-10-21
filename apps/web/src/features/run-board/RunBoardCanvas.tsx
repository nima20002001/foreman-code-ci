import { memo, useContext, useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, type EdgeProps, type NodeProps } from '@xyflow/react'
import { AgentNodeView } from '../../shared/ui/nocturne/Canvas'
import { useReducedMotion } from '../../shared/ui/nocturne'
import type { ActivitySnapshotV1, WorkflowHierarchyReadResult } from '@foreman-code/contracts'
import { CiServerNode, CiTransferEdge, type CiServerFlowNode, type CiTransferFlowEdge } from '../workflow-board/inspect/CiServer'
import { CI_SERVER_NODE_ID, ciJobRefreshing, ciNodeActivities, runCiApi } from '../workflow-board/inspect/ciServer'
import { useCiTransfers } from '../workflow-board/inspect/useCiTransfers'
import { runInspectionQueryKey } from '../workflow-board/inspect/queries'
import { useBoardCiServer } from '../workflow-board/inspect/useBoardCiServer'
import '../workflow-board/inspect/inspection.css'
import { ciNodePresentation } from './ciPresentation'
import { SignalEdgeShape } from '../graph/SignalEdgeShape'
import { useFloatingCurve } from '../graph/signalEdge'
import { useResponsiveGraphViewport } from '../graph/useResponsiveGraphViewport'
import { isRunAccessError } from '../runs-selector/query'
import { RunSubagentsOverlay } from '../run-subagents/RunSubagentsOverlay'
import { savedEdgeCurve } from './curve'
import { RunLiveNodes, useRunLiveNodes } from './useRunLiveNodes'
import { projectRunBoard, runBoardCi, READ_ONLY_FLOW_PROPS, type AvailableRunBoardSnapshot, type SavedBoardEdge, type SavedBoardNode } from './model'
import '@xyflow/react/dist/style.css'
import './runBoard.css'
import { HierarchyCanvasControls } from '../workflow-hierarchy/HierarchyCanvasControls'
import { useCollapsedWorkers } from '../workflow-hierarchy/useCollapsedWorkers'
import { useWorkflowBoard } from '../workflow-board/context'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'

const sides = [Position.Top, Position.Right, Position.Bottom, Position.Left] as const
const SavedAgent = memo(function SavedAgent({ id, data }: NodeProps<SavedBoardNode>) {
  const ci = data.ci
  // A live Run shows each node's turn, queue, CI wait or pending decision; otherwise the saved presentation.
  const live = useContext(RunLiveNodes)?.get(id)
  const presentation = live ?? (ci ? ciNodePresentation(ci) : { label: 'Saved', state: 'idle' as const })
  return <>
    {/* Keep the authoring button inert; inspection has its own accessible action. */}
    <div className="run-board-node-visual" aria-hidden="true" inert>
      <AgentNodeView className="run-board-agent" name={data.snapshot.name} harnessLabel=""
        statusLabel={presentation.label} state={presentation.state} transition={live?.transition} transitionKey={live?.transitionKey} />
    </div>
    {data.inspect ? <button type="button" className="run-board-inspect nodrag nopan"
      aria-label={`Inspect ${data.snapshot.name}`} onClick={data.inspect}>Inspect</button> : null}
    {ci ? <span role="status">{ciNodePresentation(ci).label}</span> : null}
    {data.snapshot.kind !== 'job' ? <p>{data.role ?? 'Role unavailable'}{data.reportingParent ? ` · Reports to ${data.reportingParent}` : ''}</p> : null}
    {/* Unlike the authoring AgentHandles, every saved target side must resolve. */}
    {sides.flatMap((side) => (['source', 'target'] as const).map((type) =>
      <Handle key={`${type}:${side}`} id={side} type={type} position={side} isConnectable={false}
        className="run-board-handle" aria-hidden="true" />))}
  </>
})
const SavedConnection = memo(function SavedConnection(props: EdgeProps<SavedBoardEdge>) {
  const edge = props.data?.snapshot
  const lane = props.data?.lane ?? 0, loop = props.source === props.target
  const floating = useFloatingCurve(props.source, props.target, lane * 44)
  if (!edge) return null
  // Same lines as the Board: straight when aligned, leaning toward the target otherwise; only a self-loop keeps its own loop.
  const curve = !loop && floating ? floating : savedEdgeCurve({ ...props, lane, loop })
  return <g>
    <title>{edge.label || (edge.kind === 'approval' ? 'Approval' : 'Handoff')}</title>
    <SignalEdgeShape id={props.id} curve={curve} kind={edge.kind} reportingParent={props.data?.reportingParent} />
  </g>
})
const nodeTypes = { savedBoardNode: SavedAgent, ciServer: CiServerNode }
const edgeTypes = { savedBoardEdge: SavedConnection, ciTransfer: CiTransferEdge }
const fitViewOptions = { padding: 0.2, minZoom: 0.02, maxZoom: 1 }
const proOptions = { hideAttribution: true }

/** A private React Flow store, even when mounted beneath an editor's provider. */
export function RunBoardCanvas({ snapshot, activitySnapshot, onInspectNode, hierarchy, visible = true }: {
  snapshot: AvailableRunBoardSnapshot; activitySnapshot?: ActivitySnapshotV1 | undefined
  onInspectNode?: (nodeId: string) => void
  hierarchy?: WorkflowHierarchyReadResult; visible?: boolean
}) {
  const board = useWorkflowBoard()
  const displayScope = JSON.stringify(['run', snapshot.workspaceId, snapshot.workflowId, snapshot.runId])
  const collapsed = useCollapsedWorkers(displayScope, hierarchy?.hierarchy)
  const { containerRef, onInit, onMove, onManualMove } = useResponsiveGraphViewport<SavedBoardNode | CiServerFlowNode, SavedBoardEdge | CiTransferFlowEdge>({
    fitViewOptions,
  })
  // Callers recreate their handler every render; reading it through a ref keeps unchanged nodes referentially stable.
  const inspectNode = useRef(onInspectNode)
  inspectNode.current = onInspectNode
  const inspectable = Boolean(onInspectNode)
  const { nodes, edges } = useMemo(() => {
    const projected = projectRunBoard(snapshot, activitySnapshot, hierarchy)
    if (inspectable) for (const node of projected.nodes) {
      node.data = { ...node.data, inspect: () => inspectNode.current?.(node.id) }
    }
    return projected
  }, [snapshot, activitySnapshot, inspectable, hierarchy])
  // React Flow reconciles every node it is given; keep these arrays referentially stable between unrelated renders.
  const teamNodeId = board?.teamNodeId
  const visibleNodes = useMemo(() => nodes.filter(node => !collapsed.has(node.id)).map(node => ({ ...node,
    selected: teamNodeId === node.id })), [nodes, collapsed, teamNodeId])
  const visibleEdges = useMemo(() => edges.filter(edge => !collapsed.has(edge.source) && !collapsed.has(edge.target)), [edges, collapsed])
  const visibleSnapshotNodes = useMemo(() => snapshot.nodes.filter(node => !collapsed.has(node.id)), [snapshot.nodes, collapsed])
  const scope = useMemo(() => ({ workspaceId: snapshot.workspaceId, workflowId: snapshot.workflowId,
    runId: snapshot.runId, workflowVersionId: snapshot.workflowVersionId, executionSemanticsVersion: 3 as const }), [snapshot])
  const active = !activitySnapshot || activitySnapshot.active.length > 0
    || activitySnapshot.queued.length > 0 || activitySnapshot.hasMoreActiveWork === true
  const ciList = useQuery({
    queryKey: [...runInspectionQueryKey(scope), 'ci-jobs'],
    enabled: visible,
    queryFn: ({ signal }) => runCiApi.list({ workspaceId: scope.workspaceId, runId: scope.runId }, { signal }),
    retry: false, refetchInterval: (query) => {
      if (!visible || isRunAccessError(query.state.error)) return false
      return active || query.state.data?.jobs.some(ciJobRefreshing) ? 1500 : false
    },
  })
  // A denied read must not leave authorized-looking jobs behind; any other failure keeps the last jobs read.
  const ciDenied = useProtectedAccessError(ciList)
  const names = useMemo(() => new Map(snapshot.nodes.map((node) => [node.id, node.name])), [snapshot.nodes])
  const towerNodes = useMemo(() => nodes.map((node) => ({ position: node.position, width: node.initialWidth, height: node.initialHeight })), [nodes])
  const ci = useBoardCiServer({ nodes: towerNodes, names, scope, workflow: { workspaceId: scope.workspaceId, workflowId: scope.workflowId },
    jobs: !ciDenied && ciList.data?.runId === scope.runId ? ciList.data.jobs : undefined,
    truncated: !ciDenied && (ciList.data?.truncated ?? false), error: Boolean(ciDenied) || ciList.isError, loading: ciList.isPending })
  const flowNodes = useMemo(() => [...visibleNodes, ci.node], [visibleNodes, ci.node])
  const ciJobs = !ciDenied && !ciList.isError && ciList.data?.runId === scope.runId ? ciList.data.jobs : undefined
  // A node waits on its newest unfinished CI from either the Run's Activity or the CI server's own list.
  const cis = useMemo(() => new Map([...runBoardCi(snapshot, activitySnapshot), ...ciNodeActivities(ciJobs ?? [])]),
    [snapshot, activitySnapshot, ciJobs])
  // Live node words belong to the mounted Board; a standalone saved Run Board reads only its saved Run.
  const liveNodes = useRunLiveNodes(scope, names, cis, visible && !!board)
  // A light per Agent while its CI request or result travels; no lasting line to the server.
  const transfers = useCiTransfers(ciJobs, useReducedMotion())
  const flowEdges = useMemo<(SavedBoardEdge | CiTransferFlowEdge)[]>(() => transfers.size ? [...visibleEdges,
    ...[...transfers].filter(([nodeId]) => visibleNodes.some(node => node.id === nodeId)).map(([nodeId, pulses]) => ({
      id: `ci-transfer:${nodeId}`, type: 'ciTransfer' as const, source: nodeId, target: CI_SERVER_NODE_ID,
      sourceHandle: 'right', targetHandle: 'left', selectable: false, focusable: false, deletable: false, data: { pulses } }))]
    : visibleEdges, [visibleEdges, visibleNodes, transfers])
  return <div ref={containerRef} className="run-board-canvas" data-testid="run-board-canvas" onKeyDown={(event) => {
    // History keystrokes must not bubble into an ancestor's authoring shortcuts.
    event.stopPropagation()
    const editing = event.target instanceof HTMLElement && event.target.closest('input,textarea,[contenteditable="true"]')
    if ((!editing && (event.key === 'Delete' || event.key === 'Backspace'))
      || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's')) event.preventDefault()
  }}>
    <ReactFlowProvider><RunLiveNodes.Provider value={liveNodes}>
      <ReactFlow<SavedBoardNode | CiServerFlowNode, SavedBoardEdge | CiTransferFlowEdge> nodes={flowNodes} edges={flowEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        {...READ_ONLY_FLOW_PROPS} fitView fitViewOptions={fitViewOptions} minZoom={0.02} maxZoom={2}
        onInit={onInit} onMove={onMove}
        proOptions={proOptions} preventScrolling={false} aria-label="Saved Run graph"
        ariaLabelConfig={{ 'node.a11yDescription.default': 'Saved agent, read only.', 'edge.a11yDescription.default': 'Saved connection, read only.' }}>
        <RunSubagentsOverlay scope={snapshot} nodes={visibleSnapshotNodes} visible={visible} />
        <Background color="var(--border)" gap={24} size={1} />
        <Controls showInteractive={false} fitViewOptions={fitViewOptions} aria-label="Run view controls"
          onZoomIn={onManualMove} onZoomOut={onManualMove} />
      </ReactFlow>
    </RunLiveNodes.Provider></ReactFlowProvider>
    <HierarchyCanvasControls scope={displayScope} hierarchy={hierarchy?.hierarchy}
      name={nodeId => names.get(nodeId) ?? nodeId} onTeam={board?.selectTeam} />
    {visible ? ci.dialog : null}
  </div>
}
