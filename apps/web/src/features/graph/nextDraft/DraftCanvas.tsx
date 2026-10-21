import { useHoverControls } from '../../../shared/ui/useHoverControls'
import type { JobWorkflowAdmissionReference } from '@foreman-code/contracts/job-workflow'
import { createContext, forwardRef, memo, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Background, ConnectionMode, ReactFlow, type Edge, type EdgeProps, type NodeChange, type NodeProps } from '@xyflow/react'
import { WorkflowRelationshipSchema, type WorkflowDefinitionV3, type WorkflowRelationship } from '@foreman-code/contracts/wave25'
import type { Agent } from '@foreman-code/contracts'
import { AgentNodeView, AgentPopover, Dialog, IconButton, Icon, type AgentPanel } from '../../../shared/ui/nocturne'
import { AgentChatWindowLayer } from '../../conversations/agentChat/AgentChatWindows'
import { useChatWindowsStore } from '../../conversations/agentChat/agentChatWindows'
import { createGraphTopologyProjector } from '../topology'
import { GRAPH_NODE_DEFAULT_SIZE } from '../mapper'
import { createGraphGeometryAdapter, type GraphGeometryChange } from '../geometry'
import { CircularNodeResizer } from '../CircularNodeResizer'
import { useGraphDraftStore } from '../store'
import { useGraphPresentation, useGraphPresentationStore } from '../useGraphPresentation'
import { AgentHandles } from '../AgentHandles'
import { intervalLabel } from './intervalLabel'
import { agentNodeFacts, edgeBend, relationshipLines, useFloatingCurve } from '../signalEdge'
import { SignalEdgeShape } from '../SignalEdgeShape'
import { RESPONSIVE_FIT_OPTIONS, RESPONSIVE_MIN_ZOOM, useResponsiveGraphViewport } from '../useResponsiveGraphViewport'
import type { GraphNode, AgentGraphNode, JobGraphNode } from '../types'
import { nodeTitle, putRelationship, removeRelationship, setWorkConnectionLimit } from './model'
import { WorkConnectionLimitEditor } from './WorkConnectionLimitEditor'
import type { EditGraph } from './AuthoringFields'
import { useWorkflowBoard } from '../../workflow-board/context'
import { WorkflowAgentPanel } from '../../workflow-board/WorkflowAgentPanel'
import { SelectedRunCanvas } from '../../workflow-board/inspect/SelectedRunCanvas'
import { CiServerNode, type CiServerFlowNode } from '../../workflow-board/inspect/CiServer'
import { CI_SERVER_NODE_ID } from '../../workflow-board/inspect/ciServer'
import { useBoardCiServer } from '../../workflow-board/inspect/useBoardCiServer'
import '@xyflow/react/dist/style.css'

export type OpenAgentPanel = { nodeId: string; panel: AgentPanel }
export type AgentPanels = { chatHasHeader?: boolean; chat: ReactNode; settings: ReactNode; info: ReactNode }
/** A selected Run supplies its pinned identity, including nodes no longer present in the draft. */
export type PinnedPanelNode = {kind?:'agent';agentId:string;name:string;role?:string;runLabel?:string}|{kind:'job';jobDefinitionId:string;jobDefinitionRevision:number;jobDefinitionVersionId:string;name:string;workflowExecution?:JobWorkflowAdmissionReference}
export type AgentPanelRenderer = (nodeId: string, pinned?: PinnedPanelNode) => AgentPanels
type Canvas = {
  draftKey: string
  inspect: (action: () => void) => void
  open?: OpenAgentPanel
  setOpen: (next?: OpenAgentPanel) => void
  panels: AgentPanelRenderer
  openChat?: (nodeId: string) => void
  chatScope?: string
  selectNode?: (nodeId: string) => void
  beginResize?: () => void
  resize?: (change: GraphGeometryChange) => void
  finishResize?: (id: string, width: number, height: number, position?: { x: number; y: number }) => void
}
const CanvasContext = createContext<Canvas>({ draftKey: '', inspect: (action) => action(), setOpen: () => undefined,
  panels: () => ({ chat: null, settings: null, info: null }) })

const DraftAgent = memo(function DraftAgent({ id, data, selected, width, height }: NodeProps<AgentGraphNode>) {
  const { draftKey, inspect, open, setOpen, panels, openChat, chatScope, selectNode, beginResize, resize, finishResize } = useContext(CanvasContext)
  const entry = useGraphDraftStore((state) => state.nextDrafts[draftKey]?.graph.entryNodeId === id)
  const presentation = useGraphPresentationStore()
  const board = useWorkflowBoard()
  const runSelected = Boolean(board?.run)
  const run = { label: 'Draft', state: 'idle' as const }
  const facts = agentNodeFacts(data.agent)
  const meta = data.intervalSeconds ? [{ label: 'Loop', value: intervalLabel(data.intervalSeconds) }, ...facts.meta].slice(0, 2) : facts.meta
  const core = useRef<HTMLButtonElement>(null)
  const chatOpen = useChatWindowsStore((state) => Boolean(chatScope && state.open[chatScope]?.includes(id)))
  const panel = open?.nodeId === id ? open.panel : undefined
  const select = () => inspect(() => { presentation.getState().setFocusedNodeId(id); presentation.getState().setFocusedEdgeId(undefined) })
  return <>
    <AgentNodeView ref={core} name={data.label} harness={facts.harness} harnessLabel={facts.harnessLabel} model={facts.model}
      icon={facts.icon} statusLabel={run.label} state={run.state} meta={meta} entry={entry} selected={selected} openPanel={panel ?? (chatOpen ? 'chat' : undefined)}
      ariaLabel={`${data.label}, ${facts.roleLabel}${entry ? ', starts the workflow' : ''}, ${facts.harnessLabel}, ${run.label}`}
      onSelect={(event) => { event.stopPropagation(); if (selectNode) selectNode(id); else select() }}
      onAction={(next) => inspect(() => {
        presentation.getState().setFocusedNodeId(id); presentation.getState().setFocusedEdgeId(undefined)
        if (next === 'chat') openChat?.(id)
        else setOpen(panel === next ? undefined : { nodeId: id, panel: next })
      })}>
      <AgentHandles name={data.label} />
      <CircularNodeResizer id={id} name={data.label} width={width ?? GRAPH_NODE_DEFAULT_SIZE} height={height ?? GRAPH_NODE_DEFAULT_SIZE}
        onStart={beginResize} onResize={resize}
        onFinish={(change) => finishResize?.(id, change.width!, change.height!, change.position)} />
    </AgentNodeView>
    {panel && panel !== 'chat' && !runSelected && !board?.selectSidePanel ? <AgentPopover open anchor={core} title={data.label} subtitle={`${facts.roleLabel} · ${facts.harnessLabel}${facts.model ? ` · ${facts.model}` : ''}`}
      icon={facts.icon} harness={facts.harness} panel={panel}
      onClose={() => inspect(() => setOpen(undefined))} {...panels(id)} /> : null}
  </>
})

type DraftEdge = Edge<{ kind: WorkflowRelationship['kind']; bend: number;
  remove: () => void; removeLabel: string; removalDisabled: boolean;
  workPolicy: boolean; maxWorkHandoffsPerRun?: number; draftChanged: boolean; disabled: boolean;
  onApplyLimit?: (value?: number) => void }>
const TypedEdge = memo(function TypedEdge({ id, source, target, data, selected }: EdgeProps<DraftEdge>) {
  const curve = useFloatingCurve(source, target, data?.bend ?? 0)
  const { hovered, onPointerEnter, onPointerLeave } = useHoverControls()
  const [editing, setEditing] = useState(false)
  const [focused, setFocused] = useState(false)
  const visible = hovered || focused || selected
  if (!curve) return null
  const limit = data?.maxWorkHandoffsPerRun
  return <g onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}
    onFocus={() => setFocused(true)} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) setFocused(false)
    }}>
    <SignalEdgeShape id={id} curve={curve} kind={data?.kind} />
    {visible ? <rect className="board-edge-hover-bridge" x={curve.mid.x - 18} y={curve.mid.y - 36}
      width={36} height={48} /> : null}
    <foreignObject data-visible={visible} className="board-edge-remove nodrag nopan" x={curve.mid.x - 18} y={curve.mid.y - 36} width={36} height={36}>
      <IconButton size="sm" variant="ghost" label={data?.removeLabel ?? `Remove connection from ${source} to ${target}`}
        tabIndex={0} disabled={data?.removalDisabled} onClick={(event) => { event.stopPropagation(); data?.remove() }}><Icon name="close" size={14} /></IconButton>
    </foreignObject>
    {data?.workPolicy ? <foreignObject className="work-connection-limit-object" data-visible={hovered || editing}
      x={curve.mid.x - (editing ? 132 : 54)} y={curve.mid.y + 12}
      width={editing ? 264 : 108} height={editing ? 208 : 42}>
      <div className="work-connection-limit-control nodrag nopan nowheel"
        onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
        {editing ? <WorkConnectionLimitEditor compact value={limit} disabled={data.disabled}
          onCancel={() => setEditing(false)} onApply={(value) => { data.onApplyLimit?.(value); setEditing(false) }} />
          : <button type="button" className="work-connection-limit-pill" data-testid={`work-limit-${id}`}
            disabled={data.disabled} title="Edit the work handoff limit on this connection"
            aria-label={`Maximum work handoffs per Run: ${limit ?? 'unlimited'}${data.draftChanged ? ', draft change' : ''}. Edit connection limit.`}
            onClick={(event) => { event.stopPropagation(); setEditing(true) }}>
            <span>{limit ?? '∞'}</span>{data.draftChanged ? <small>Draft</small> : null}
          </button>}
      </div>
    </foreignObject> : null}
  </g>
})
const DraftJob=memo(function DraftJob({id,data,selected}:NodeProps<JobGraphNode>) {
  const {draftKey,inspect,open,setOpen,panels,selectNode}=useContext(CanvasContext)
  const entry=useGraphDraftStore(state=>state.nextDrafts[draftKey]?.graph.entryNodeId===id)
  const core=useRef<HTMLButtonElement>(null),panel=open?.nodeId===id?open.panel:undefined
  const board=useWorkflowBoard()
  return <><AgentNodeView ref={core} name={data.label} harnessLabel="Job" statusLabel="Saved job" selected={selected} entry={entry} openPanel={panel}
    ariaLabel={`${data.label}, job, saved revision ${data.jobDefinitionRevision}`}
    onSelect={(event)=>{event.stopPropagation();inspect(()=>{selectNode?.(id);setOpen({nodeId:id,panel:'info'})})}}
><AgentHandles name={data.label}/></AgentNodeView>
    {panel&&!board?.selectSidePanel?<Dialog open className="job-dialog" title={data.label} description="Noninteractive job" onOpenChange={value=>{if(!value)inspect(()=>setOpen(undefined))}}>{panels(id).info}{panels(id).settings}</Dialog>:null}</>
})
const nodeTypes = { agent: DraftAgent, job: DraftJob, ciServer: CiServerNode }, edgeTypes = { typed: TypedEdge }
const noNames: ReadonlyMap<string, string> = new Map()
const fitViewOptions = RESPONSIVE_FIT_OPTIONS
const proOptions = { hideAttribution: true }
export type DraftCanvasHandle = { flush(): void; cancel(): void }

/** The draft remains mounted with its geometry buffer while the selected Run
 * renders its immutable topology. Hidden draft nodes do not subscribe to live
 * Run state or repeatedly scan execution history. */
export const DraftCanvas = forwardRef<DraftCanvasHandle, {
  draftKey: string; graph: WorkflowDefinitionV3; agents: readonly Agent[]; kind: WorkflowRelationship['kind']
  baseGraph?: WorkflowDefinitionV3; semanticLocked?: boolean
  change: EditGraph; geometry: (changes: GraphGeometryChange[]) => void; pending: (pending: boolean) => void
  report: (error: unknown) => void; inspect?: (action: () => void) => void; removalDisabled?: boolean
  open?: OpenAgentPanel; setOpen?: (next?: OpenAgentPanel) => void; panels?: AgentPanelRenderer
  children?: ReactNode
}>(function DraftCanvas({ draftKey, graph, agents, kind, baseGraph, semanticLocked = false,
  change, geometry, pending, report, inspect = (action) => action(), removalDisabled = false,
  open, setOpen = () => undefined, panels = () => ({ chat: null, settings: null, info: null }), children }, ref) {
  const board = useWorkflowBoard()
  const selectedRun = board?.run
  const responsive = useResponsiveGraphViewport<GraphNode | CiServerFlowNode, DraftEdge>({ enabled: !selectedRun })
  const [project] = useState(() => createGraphTopologyProjector())
  const topology = useMemo(() => project(graph, agents), [project, graph, agents])
  const [adapter] = useState(() => createGraphGeometryAdapter(topology.nodes))
  const [nodes, setNodes] = useState(topology.nodes)
  const [connecting, setConnecting] = useState(false)
  // Every Board shows the CI server automatically; it is never a workflow node and cannot be added by hand.
  const ci = useBoardCiServer({ nodes, names: noNames, workflow: { workspaceId: graph.workspaceId, workflowId: graph.id } })
  const flowNodes = useMemo<(GraphNode | CiServerFlowNode)[]>(() => [...nodes, ci.node], [nodes, ci.node])
  const selectedIds = useGraphPresentation((state) => state.selectedNodeIds)
  const presentation = useGraphPresentationStore()
  useLayoutEffect(() => { setNodes(adapter.reconcile(topology.nodes, selectedIds)) }, [adapter, topology.nodes, selectedIds])
  const flush = () => {
    const changes = adapter.flush()
    if (changes.length) geometry(changes)
    pending(false)
  }
  const prepareResize = () => {
    setConnecting(false)
  }
  const beginResize = () => {
    prepareResize()
    adapter.beginResize()
  }
  const finishResize = (id: string, width: number, height: number, position?: { x: number; y: number }) => {
    setNodes(adapter.finishResize(id, width, height, position))
    flush()
  }
  useImperativeHandle(ref, () => ({ flush, cancel: () => { setNodes(adapter.cancel()); pending(false) } }))
  const edges = useMemo<DraftEdge[]>(() => {
    const counts = new Map<string, number>()
    // One line per agent pair: an approval beside a handoff is drawn on the handoff's line.
    return relationshipLines(graph.edges).lines.map(({ members, ...edge }) => {
      const pair = JSON.stringify([edge.source, edge.target].sort()), count = counts.get(pair) ?? 0
      counts.set(pair, count + 1)
      const kindLabel = members.length > 1 ? 'Handoff · approval' : edge.kind === 'approval' ? 'Approval' : 'Handoff'
      return { ...edge, type: 'typed', sourceHandle: 'right', targetHandle: 'left',
        ariaLabel: `${kindLabel} from ${nodeTitle(graph, edge.source)} to ${nodeTitle(graph, edge.target)}${edge.label ? `: ${edge.label}` : ''}`,
        data: { kind: edge.kind, bend: edgeBend(count, edge.source < edge.target),
          remove: () => change((value) => removeRelationship(value, edge.id)),
          removeLabel: `Remove ${edge.kind === 'approval' ? 'approval' : 'handoff'} from ${nodeTitle(graph, edge.source)} to ${nodeTitle(graph, edge.target)}`,
          removalDisabled, workPolicy: Boolean(graph.handoffs && edge.kind === 'execution'),
          maxWorkHandoffsPerRun: edge.maxWorkHandoffsPerRun,
          draftChanged: edge.maxWorkHandoffsPerRun !== baseGraph?.edges.find((item) => item.id === edge.id)?.maxWorkHandoffsPerRun,
          disabled: semanticLocked,
          onApplyLimit: (limit?: number) => {
            try { change((value) => setWorkConnectionLimit(value, edge.id, limit)) }
            catch (error) { report(error) }
          } } }
    })
  }, [graph, baseGraph, semanticLocked, change, report, removalDisabled])
  const onNodesChange = (allChanges: NodeChange<GraphNode | CiServerFlowNode>[]) => {
    const changes = allChanges.filter((item): item is NodeChange<GraphNode> => !('id' in item) || item.id !== CI_SERVER_NODE_ID)
    const nextSelection = new Set(presentation.getState().selectedNodeIds)
    for (const item of changes) if (item.type === 'select') {
      if (item.selected) nextSelection.add(item.id); else nextSelection.delete(item.id)
    }
    presentation.getState().setSelectedNodeIds(nextSelection)
    const result = adapter.update(changes)
    setNodes(result.nodes); pending(result.pending)
    if (result.finished) flush()
  }
  const connectNodes = (source: string, target: string) => {
    try { change((value) => value.edges.some((edge) => edge.kind === kind && edge.source === source && edge.target === target) ? value
      : putRelationship(value, WorkflowRelationshipSchema.parse({ id: `relationship-${crypto.randomUUID()}`, kind, source, target }))) }
    catch (error) { report(error) }
  }
  const selectNode = (nodeId: string) => inspect(() => {
    presentation.getState().setFocusedNodeId(nodeId)
    presentation.getState().setSelectedNodeIds(new Set([nodeId]))
    presentation.getState().setFocusedEdgeId(undefined)
  })
  const resize = (change: GraphGeometryChange) => {
    const result = adapter.update([
      { id: change.id, type: 'dimensions', dimensions: { width: change.width!, height: change.height! }, resizing: true },
      { id: change.id, type: 'position', position: change.position },
    ])
    setNodes(result.nodes)
    pending(result.pending)
  }
  // Chat windows live in local interaction state, one list per Board view (this draft here, each Run in its own canvas).
  const chatScope = `draft:${draftKey}`
  const selectSidePanel = board?.selectSidePanel
  const openChat = useCallback((nodeId: string) => {
    if (selectSidePanel) selectSidePanel({ kind: 'agent', nodeId, tab: 'chat' })
    else useChatWindowsStore.getState().openWindow(chatScope, nodeId)
  }, [selectSidePanel, chatScope])
  // Other code asks for a node's chat through the single open-panel state; chat itself opens as a window.
  useEffect(() => { if (open?.panel === 'chat') { openChat(open.nodeId); setOpen(undefined) } }, [open, openChat, setOpen])
  const chatWindow = (nodeId: string) => {
    const node = topology.nodes.find((item) => item.id === nodeId)
    if (!node || node.type !== 'agent') return undefined
    const { chat, chatHasHeader }: AgentPanels = panels(nodeId)
    return chat ? { name: node.data.label, harness: agentNodeFacts(node.data.agent).harness, chat, chatHasHeader } : undefined
  }
  const docked = board?.sidePanel?.kind === 'agent' ? board.sidePanel : undefined
  const shown = docked ? { nodeId: docked.nodeId, panel: docked.tab === 'details' ? 'info' as const : docked.tab } : undefined
  const setPanel = (next?: OpenAgentPanel) => {
    if (board?.selectSidePanel) board.selectSidePanel(next
      ? { kind: 'agent', nodeId: next.nodeId, tab: next.panel === 'info' ? 'details' : next.panel } : { kind: 'none' })
    else setOpen(next)
  }
  const context = { draftKey, inspect, open: board?.selectSidePanel ? shown : open, setOpen: setPanel, panels, openChat, chatScope, selectNode, beginResize, resize, finishResize }
  return <CanvasContext.Provider value={context}>
    <div ref={responsive.containerRef} className={`next-draft-canvas board-draft-canvas${connecting ? ' is-connecting' : ''}`} style={selectedRun ? { display: 'none' } : undefined} aria-hidden={!!selectedRun} inert={!!selectedRun} aria-label="Editable workflow graph">
      {/* While a Run is shown, the draft's data stays mounted but its flow does not: a hidden
          flow measures a zero-size box and would come back empty on Return to draft. */}
      {selectedRun ? null : <ReactFlow<GraphNode | CiServerFlowNode, DraftEdge> nodes={flowNodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        onNodesChange={onNodesChange} connectionMode={ConnectionMode.Loose} connectionRadius={120} deleteKeyCode={null}
        fitView fitViewOptions={fitViewOptions} proOptions={proOptions} minZoom={RESPONSIVE_MIN_ZOOM} maxZoom={1.6} onInit={responsive.onInit}
        onMove={responsive.onMove}
        isValidConnection={(connection) => connection.source !== connection.target}
        onConnectStart={() => setConnecting(true)} onConnectEnd={() => setConnecting(false)}
        onClickConnectStart={() => setConnecting(true)} onClickConnectEnd={() => setConnecting(false)}
        onNodeClick={(event, node) => {
          if (event.target instanceof Element && event.target.closest('.react-flow__handle')) return
          if (node.type !== 'ciServer') selectNode(node.id)
        }}
        onPaneClick={() => inspect(() => { setOpen(undefined); presentation.getState().setFocusedNodeId(undefined); presentation.getState().setFocusedEdgeId(undefined) })}
        onConnect={(connection) => {
          connectNodes(connection.source, connection.target)
        }}>
        <Background color="var(--border)" gap={24} size={1} />
      </ReactFlow>}
      {children}
      {selectedRun || board?.selectSidePanel ? null : <AgentChatWindowLayer scope={chatScope} content={chatWindow} />}
      <WorkflowAgentPanel panels={panels} chatScope={chatScope} active={!selectedRun && board?.authoringActive !== false}
        nodes={graph.nodes.map(node => ({ id: node.id, name: nodeTitle(graph, node.id) }))}
        findNode={nodeId => graph.nodes.some(node => node.id === nodeId) ? undefined : false} />
    </div>
    {selectedRun ? null : ci.dialog}
    {selectedRun ? <SelectedRunCanvas key={JSON.stringify(selectedRun)} scope={selectedRun} panels={panels} layout={topology.nodes} geometry={geometry} /> : null}
  </CanvasContext.Provider>
})
