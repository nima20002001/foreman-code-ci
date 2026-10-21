import { memo, useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, type EdgeProps, type NodeProps } from '@xyflow/react'
import { AgentNodeView } from '../../shared/ui/nocturne/Canvas'
import type { ActivitySnapshotV1, WorkflowHierarchyReadResult } from '@foreman-code/contracts'
import { CiServerNode, type CiServerFlowNode } from '../workflow-board/inspect/CiServer'
import { ciJobRefreshing, runCiApi } from '../workflow-board/inspect/ciServer'
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
import { projectRunBoard, READ_ONLY_FLOW_PROPS, type AvailableRunBoardSnapshot, type SavedBoardEdge, type SavedBoardNode } from './model'
import '@xyflow/react/dist/style.css'
import './runBoard.css'
import { HierarchyCanvasControls } from '../workflow-hierarchy/HierarchyCanvasControls'
import { useCollapsedWorkers } from '../workflow-hierarchy/useCollapsedWorkers'
import { useWorkflowBoard } from '../workflow-board/context'

const sides = [Position.Top, Position.Right, Position.Bottom, Position.Left] as const
const SavedAgent = memo(function SavedAgent({ data }: NodeProps<SavedBoardNode>) {
  const ci = data.ci
  const presentation = ci ? ciNodePresentation(ci) : { label: 'Saved', state: 'idle' as const }
  return <>
    {/* Keep the authoring button inert; inspection has its own accessible action. */}
    <div className="run-board-node-visual" aria-hidden="true" inert>
      <AgentNodeView className="run-board-agent" name={data.snapshot.name} harnessLabel=""
        statusLabel={presentation.label} state={presentation.state} />
    </div>
    {data.inspect ? <button type="button" className="run-board-inspect nodrag nopan"
      aria-label={`Inspect ${data.snapshot.name}`} onClick={data.inspect}>Inspect</button> : null}
    {ci ? <span role="status">{presentation.label}</span> : null}
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
const nodeTypes = { savedBoardNode: SavedAgent, ciServer: CiServerNode }, edgeTypes = { savedBoardEdge: SavedConnection }
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
  const { containerRef, onInit, onMove, onManualMove } = useResponsiveGraphViewport<SavedBoardNode | CiServerFlowNode, SavedBoardEdge>({
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
  const visibleNodes = nodes.filter(node => !collapsed.has(node.id)).map(node => ({ ...node,
    selected: board?.teamNodeId === node.id }))
  const visibleEdges = edges.filter(edge => !collapsed.has(edge.source) && !collapsed.has(edge.target))
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
  const names = useMemo(() => new Map(snapshot.nodes.map((node) => [node.id, node.name])), [snapshot.nodes])
  const towerNodes = useMemo(() => nodes.map((node) => ({ position: node.position, width: node.initialWidth, height: node.initialHeight })), [nodes])
  const ci = useBoardCiServer({ nodes: towerNodes, names, scope, workflow: { workspaceId: scope.workspaceId, workflowId: scope.workflowId },
    jobs: ciList.data?.runId === scope.runId ? ciList.data.jobs : undefined,
    truncated: ciList.data?.truncated ?? false, error: ciList.isError, loading: ciList.isPending })
  const flowNodes = [...visibleNodes, ci.node]
  return <div ref={containerRef} className="run-board-canvas" data-testid="run-board-canvas" onKeyDown={(event) => {
    // History keystrokes must not bubble into an ancestor's authoring shortcuts.
    event.stopPropagation()
    const editing = event.target instanceof HTMLElement && event.target.closest('input,textarea,[contenteditable="true"]')
    if ((!editing && (event.key === 'Delete' || event.key === 'Backspace'))
      || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's')) event.preventDefault()
  }}>
    <ReactFlowProvider>
      <ReactFlow<SavedBoardNode | CiServerFlowNode, SavedBoardEdge> nodes={flowNodes} edges={visibleEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        {...READ_ONLY_FLOW_PROPS} fitView fitViewOptions={fitViewOptions} minZoom={0.02} maxZoom={2}
        onInit={onInit} onMove={onMove}
        proOptions={proOptions} preventScrolling={false} aria-label="Saved Run graph"
        ariaLabelConfig={{ 'node.a11yDescription.default': 'Saved agent, read only.', 'edge.a11yDescription.default': 'Saved connection, read only.' }}>
        <RunSubagentsOverlay scope={snapshot} nodes={snapshot.nodes.filter(node => !collapsed.has(node.id))} visible={visible} />
        <Background color="var(--border)" gap={24} size={1} />
        <Controls showInteractive={false} fitViewOptions={fitViewOptions} aria-label="Run view controls"
          onZoomIn={onManualMove} onZoomOut={onManualMove} />
      </ReactFlow>
    </ReactFlowProvider>
    <HierarchyCanvasControls scope={displayScope} hierarchy={hierarchy?.hierarchy}
      name={nodeId => names.get(nodeId) ?? nodeId} onTeam={board?.selectTeam} />
    {visible ? ci.dialog : null}
  </div>
}
