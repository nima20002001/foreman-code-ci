import { useHoverControls } from '../../../shared/ui/useHoverControls'
import type { JobWorkflowAdmissionReference } from '@foreman-code/contracts/job-workflow'
import { isHierarchyReportingRoute } from '@foreman-code/contracts'
import { createContext, useCallback, useContext, memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { Background, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow, type Edge, type EdgeProps, type Node, type NodeChange, type NodeProps } from '@xyflow/react'
import type { RepeatGraphScopeV3, WorkflowNodeV3, WorkflowRelationship } from '@foreman-code/contracts/wave25'
import { AgentNodeView, AgentPopover, Dialog, Alert, Button, useReducedMotion, type AgentNodeState, type AgentNodeTransition } from '../../../shared/ui/nocturne'
import { useProtectedAccessError } from '../../../shared/api/useProtectedAccessError'
import type { AgentPanelRenderer, OpenAgentPanel } from '../../graph/nextDraft/DraftCanvas'
import { AgentChatWindowLayer } from '../../conversations/agentChat/AgentChatWindows'
import { useChatWindowsStore } from '../../conversations/agentChat/agentChatWindows'
import { CircularNodeResizer } from '../../graph/CircularNodeResizer'
import { createGraphGeometryAdapter, type GraphGeometryChange } from '../../graph/geometry'
import { AgentHandles } from '../../graph/AgentHandles'
import { GRAPH_NODE_DEFAULT_SIZE } from '../../graph/mapper'
import { layoutHierarchy } from '../../graph/hierarchyLayout'
import { SignalEdgeShape } from '../../graph/SignalEdgeShape'
import { intervalLabel } from '../../graph/nextDraft/intervalLabel'
import { agentNodeFacts, edgeBend, relationshipLines, useFloatingCurve } from '../../graph/signalEdge'
import type { EdgePulse } from '../../graph/SignalEdgeShape'
import { useWorkflowBoard } from '../context'
import { WorkflowAgentPanel } from '../WorkflowAgentPanel'
import { readPinnedAgentVersion } from '../runDetailsClient'
import { useSelectedRunQueryState, useSelectedRunRecord } from '../runFacts'
import { useRunHandoffsQuery } from '../runHandoffsQuery'
import { runInspectionQueryKey, useRunVersionQuery } from './queries'
import { checkingView, pinnedNodeStates, pinnedTopology, runningIntervalChecks } from './pinnedTopology'
import { runsSelectorApi } from '../../runs-selector/client'
import { isRunAccessError } from '../../runs-selector/query'
import { useRunChoreography } from './runChoreography'
import { useInteractionsQuery } from '../../../shared/api/query'
import { interactionWaits, liveNodeView } from './runLiveStatus'
import { RunSubagentsOverlay } from '../../run-subagents/RunSubagentsOverlay'
import { CiServerDialog, CiServerNode, CiTransferEdge,
  type CiServerFlowNode, type CiTransferFlowEdge } from './CiServer'
import { useCiTransfers } from './useCiTransfers'
import { CI_SERVER_NODE_ID, ciNodeActivities, ciServerFlowNode, ciServerSummary, ciJobRefreshing, runCiApi } from './ciServer'
import { useInspectionPresentation } from './presentation'
import type { SubagentLayoutNode } from '../../run-subagents/layout'
import './inspection.css'

const RunAgentPanels = createContext<{
  panels?: AgentPanelRenderer; open?: OpenAgentPanel; setOpen(value?: OpenAgentPanel): void
  chatScope: string; openChat(nodeId: string): void
  beginResize?: () => void
  resize?: (change: GraphGeometryChange) => void; finishResize?: (change: GraphGeometryChange) => void
} | null>(null)

type Facts = ReturnType<typeof agentNodeFacts>
type RunNode = Node<ReturnType<typeof pinnedTopology>['nodes'][number] & {
  workflowExecution?: JobWorkflowAdmissionReference
  blockId?: string; recorded: string; status: string; state: AgentNodeState; transition?: AgentNodeTransition; transitionKey?: number; facts: Facts
  selected: boolean; resizable?: boolean; inspect(): void
}, 'pinnedRunNode'>
/** Run identity is pinned; its circle uses the workflow's editable presentation. */
const PinnedRunNode = memo(function PinnedRunNode({ id, data, selected, width, height }: NodeProps<RunNode>) {
  const board = useWorkflowBoard()
  const ui = useContext(RunAgentPanels), anchor = useRef<HTMLButtonElement>(null)
  const chatOpen = useChatWindowsStore((state) => Boolean(ui && state.open[ui.chatScope]?.includes(id)))
  const panel = ui?.open?.nodeId === id ? ui.open.panel : undefined
  const meta = [...(data.blockId ? [{ label: 'Repeat', value: data.blockId }] : []),
    ...(data.kind === 'agent' && data.intervalSeconds ? [{ label: 'Loop', value: intervalLabel(data.intervalSeconds) }] : []),
    ...data.facts.meta].slice(0, 2)
  return <><AgentNodeView ref={anchor} className="pinned-run-node" name={data.label} harness={data.facts.harness} harnessLabel={data.facts.harnessLabel}
    model={data.facts.model} icon={data.facts.icon} statusLabel={data.status} state={data.state} transition={data.transition} transitionKey={data.transitionKey} meta={meta}
    entry={data.entry} selected={selected} ariaLabel={`Inspect Run node ${data.label}`} onSelect={()=>{if(data.kind==='job'){data.inspect();ui?.setOpen({nodeId:id,panel:'info'})}}} openPanel={panel ?? (chatOpen ? 'chat' : undefined)}
    onAction={ui?.panels && data.kind==='agent' ? (next) => next === 'chat' ? ui.openChat(id) : ui.setOpen(panel === next ? undefined : { nodeId: id, panel: next }) : undefined}>
    <AgentHandles name={data.label} connectable={false} />
    {data.kind === 'agent' && data.resizable ? <CircularNodeResizer id={id} name={data.label}
      width={width ?? GRAPH_NODE_DEFAULT_SIZE} height={height ?? GRAPH_NODE_DEFAULT_SIZE} onStart={ui?.beginResize} onResize={ui?.resize} onFinish={ui?.finishResize} /> : null}
  </AgentNodeView>
    {panel && ui?.panels && data.kind==='job' && !board?.selectSidePanel?<Dialog open className="job-dialog" title={data.label} description={`Selected Run · ${data.recorded}`} onOpenChange={value=>{if(!value)ui.setOpen(undefined)}}>{ui.panels(id,{kind:'job',jobDefinitionId:data.jobDefinitionId,jobDefinitionRevision:data.jobDefinitionRevision,jobDefinitionVersionId:data.jobDefinitionVersionId,name:data.label,workflowExecution:data.workflowExecution}).info}</Dialog>:null}
    {panel && panel !== 'chat' && ui?.panels && data.kind==='agent' && !board?.selectSidePanel ? <AgentPopover open anchor={anchor} title={data.label} subtitle={`Selected Run · ${data.recorded}`}
      harness={data.facts.harness} icon={data.facts.icon} panel={panel}
      onClose={() => ui.setOpen(undefined)}
      {...ui.panels(id,{agentId:data.agentId,name:data.label,role:data.facts.roleLabel,runLabel:data.status})} /> : null}
  </>
})
// Pulses and traces are timed once per canvas, so an edge remount never replays a handoff.
type LineMotion = { pulses: Map<string, EdgePulse[]> }
const Choreography = createContext<LineMotion>({ pulses: new Map() })

type RunEdge = Edge<{ kind: WorkflowRelationship['kind']; bend: number;
  handoffs: boolean; limit?: number; used?: number; reportingParent?: string }>
const PinnedRunEdge = memo(function PinnedRunEdge({ id, source, target, data, selected }: EdgeProps<RunEdge>) {
  const { pulses } = useContext(Choreography)
  const curve = useFloatingCurve(source, target, data?.bend ?? 0)
  const { hovered, onPointerEnter, onPointerLeave } = useHoverControls()
  const [expanded, setExpanded] = useState(false)
  if (!curve) return null
  const showUsage = hovered || selected || expanded
  const usage = data?.used === undefined ? 'Usage unavailable' : data.limit === undefined
    ? `${data.used} used · no connection cap` : `${data.used} of ${data.limit} used`
  return <g onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
    <SignalEdgeShape id={id} curve={curve} kind={data?.kind} pulses={pulses.get(id)} reportingParent={data?.reportingParent} />
    {data?.handoffs && showUsage ? <rect className="board-edge-hover-bridge"
      x={curve.mid.x - 90} y={curve.mid.y} width={180} height={54} /> : null}
    {data?.handoffs ? <foreignObject className="pinned-work-limit-object" data-visible={showUsage}
      x={curve.mid.x - 90} y={curve.mid.y + 12} width={180} height={showUsage ? 70 : 42}>
      <div className="pinned-work-limit-control nodrag nopan">
        <button type="button" className="pinned-work-limit-pill"
          aria-label={`Saved maximum work handoffs per Run: ${data.limit ?? 'unlimited'}. ${usage}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); setExpanded((current) => !current) }}
          onFocus={() => setExpanded(true)} onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Escape') setExpanded(false)
          }}>{data.limit ?? '∞'}</button>
        {showUsage ? <span className="pinned-work-limit-usage">{usage}</span> : null}
      </div>
    </foreignObject> : null}
  </g>
})
const nodeTypes = { pinnedRunNode: PinnedRunNode, ciServer: CiServerNode }
const edgeTypes = { pinnedRunEdge: PinnedRunEdge, ciTransfer: CiTransferEdge }
const fitViewOptions = { padding: 0.25, minZoom: 0.3, maxZoom: 1 }
const proOptions = { hideAttribution: true }
const unknownFacts: Facts = { harnessLabel: 'Pinned settings unavailable', icon: 'bot', roleLabel: 'Agent', meta: [] }

function useRunAgentPanels(scope: RepeatGraphScopeV3, board: NonNullable<ReturnType<typeof useWorkflowBoard>>) {
  const [localOpen, setLocalOpen] = useState<OpenAgentPanel>()
  const docked = board.sidePanel?.kind === 'agent' ? board.sidePanel : undefined
  const open = board.selectSidePanel ? docked && { nodeId: docked.nodeId, panel: docked.tab === 'details' ? 'info' as const : docked.tab } : localOpen
  const setOpen = (next?: OpenAgentPanel) => {
    if (board.selectSidePanel) board.selectSidePanel(next
      ? { kind: 'agent', nodeId: next.nodeId, tab: next.panel === 'info' ? 'details' : next.panel } : { kind: 'none' })
    else setLocalOpen(next)
  }
  // Each Run keeps its own floating chat windows; they never mix with the draft's.
  const chatScope = `run:${scope.workflowId}:${scope.runId}`
  const selectSidePanel = board.selectSidePanel
  const openChat = useCallback((nodeId: string) => {
    if (selectSidePanel) selectSidePanel({ kind: 'agent', nodeId, tab: 'chat' })
    else useChatWindowsStore.getState().openWindow(chatScope, nodeId)
  }, [selectSidePanel, chatScope])
  return { open, setOpen, chatScope, openChat }
}

/** The editor stays mounted beside this canvas. Only geometry is shared with
 * the draft; node identities and Run facts remain pinned by the /version service. */
export function SelectedRunCanvas({ scope, panels: suppliedPanels, layout, geometry }: {
  scope: RepeatGraphScopeV3; panels?: AgentPanelRenderer
  layout?: readonly Pick<WorkflowNodeV3, 'id' | 'position' | 'width' | 'height'>[]; geometry?: (changes: GraphGeometryChange[]) => void
}) {
  const board = useWorkflowBoard()!
  const { open, setOpen, chatScope, openChat } = useRunAgentPanels(scope, board)
  const query = useRunVersionQuery(scope)
  const denied = useProtectedAccessError(query)
  // Observe (never fetch) the canonical Run read: its confirmed denial hides the pinned topology too.
  const canonical = useSelectedRunQueryState()
  // Before the first current read lands, nodes say Loading rather than Unavailable.
  const recordLoading = !canonical || canonical.status === 'pending' && canonical.fetchStatus !== 'paused'
  const canonicalDenied = useProtectedAccessError({
    error: canonical?.error,
    failureReason: canonical?.fetchFailureReason,
    isSuccess: canonical?.status === 'success',
    failureCount: canonical?.fetchFailureCount ?? 0,
    dataUpdatedAt: canonical?.dataUpdatedAt ?? 0,
  })
  const version = query.isError || denied || canonicalDenied ? undefined : query.data?.version
  const panels = useMemo(() => withPinnedReportingParent(suppliedPanels, version), [suppliedPanels, version])
  const handoffsQuery = useRunHandoffsQuery(scope, Boolean(version?.definition.handoffs))
  const handoffsDenied = useProtectedAccessError(handoffsQuery)
  const handoffs = !handoffsDenied && !handoffsQuery.isError ? handoffsQuery.data : undefined
  const record = useSelectedRunRecord()
  const snapshotQuery = useQuery({
    queryKey: [...runInspectionQueryKey(scope), 'board-activity'],
    queryFn: ({ signal }) => runsSelectorApi.snapshot({ workspaceId: scope.workspaceId,
      workflowId: scope.workflowId, runId: scope.runId }, { signal }),
    enabled: Boolean(version && record && !canonicalDenied), retry: false, staleTime: 0,
    refetchInterval: query => isRunAccessError(query.state.error) ? false : 1500,
  })
  const checks = useMemo(() => new Map((snapshotQuery.isError ? undefined : snapshotQuery.data)?.intervalChecks
    ?.map((check) => [check.nodeId, check]) ?? []), [snapshotQuery.data, snapshotQuery.isError])
  const executionQueue = useMemo(() => new Map((snapshotQuery.isError ? undefined : snapshotQuery.data)?.executionQueue
    ?.map((entry) => [entry.workflowNodeId, entry.reason]) ?? []), [snapshotQuery.data, snapshotQuery.isError])
  const topology = useMemo(() => version ? pinnedTopology(version) : undefined, [version])
  const live = Boolean(record && record.state.run.executionState !== 'completed')
  // Every CI ticket this Run's Agents requested; polled while the Run or any ticket is still going.
  const ciList = useQuery({
    queryKey: [...runInspectionQueryKey(scope), 'ci-jobs'],
    queryFn: ({ signal }) => runCiApi.list({ workspaceId: scope.workspaceId, runId: scope.runId }, { signal }),
    enabled: Boolean(version && !canonicalDenied), retry: false, staleTime: 0,
    refetchInterval: (query) => isRunAccessError(query.state.error) ? false
      : live || query.state.data?.jobs.some(ciJobRefreshing) ? 1500 : false,
  })
  const ciDenied = useProtectedAccessError(ciList)
  const ciRunJobs = !ciDenied && ciList.data?.runId === scope.runId ? ciList.data.jobs : undefined
  const cis = useMemo(() => ciNodeActivities(ciList.isError ? [] : ciRunJobs ?? []), [ciRunJobs, ciList.isError])
  // Shown with the Agents from the first render, so the first fit includes it; unknown until its first read.
  const ciUnavailable = Boolean(ciDenied || ciList.isError && !ciRunJobs)
  const ciSummary = useMemo(() => {
    if (!ciRunJobs) return { ...ciServerSummary([]), state: 'unavailable' as const,
      label: ciUnavailable ? 'CI unavailable' : 'Loading CI' }
    const summary = ciServerSummary(ciRunJobs)
    return ciList.isError ? { ...summary, state: 'unavailable' as const, label: `Last read: ${summary.label}` } : summary
  }, [ciRunJobs, ciUnavailable, ciList.isError])
  const ciFlights = useCiTransfers(ciList.isError ? undefined : ciRunJobs, useReducedMotion())
  const transfers = useMemo(() => ciDenied || ciList.isError ? new Map<string, EdgePulse[]>() : ciFlights,
    [ciDenied, ciList.isError, ciFlights])
  const ciDialogKey = JSON.stringify(['ci-server', scope.runId])
  const ciDialogOpen = useInspectionPresentation((state) => !!state.open[ciDialogKey])
  const setCiDialogOpen = (value: boolean) => useInspectionPresentation.getState().setOpen(ciDialogKey, value)
  // The same pending-request read as the approval inbox; this Run's requests name why its Agents wait.
  const pending = useInteractionsQuery({ workspaceId: scope.workspaceId, workflowId: scope.workflowId, status: 'pending', limit: 100 }, live)
  const names = useMemo(() => new Map(topology?.nodes.map((node) => [node.id, node.label])), [topology])
  const waits = useMemo(() => interactionWaits(record, pending.isError ? [] : pending.data?.items ?? [], names),
    [record, pending.data, pending.isError, names])
  const states = useMemo(() => pinnedNodeStates(record), [record])
  const checking = useMemo(() => live ? runningIntervalChecks(record) : new Map<string, { check: number; queued: boolean }>(), [record, live])
  const choreography = useRunChoreography(record, topology?.edges)
  // One line per agent pair: an approval beside a handoff is drawn on the handoff's line.
  const lines = useMemo(() => relationshipLines(topology?.edges ?? []), [topology])
  const motion = useMemo<LineMotion>(() => {
    // A plain line: meaning travels on the pulse, not as a lasting glow or badge.
    const pulses = new Map<string, EdgePulse[]>()
    for (const [id, items] of choreography.pulses) {
      const line = lines.alias.get(id)
      if (line) pulses.set(line.lineId, [...pulses.get(line.lineId) ?? [], ...items.map((pulse) => ({ ...pulse, reversed: pulse.reversed !== line.flipped }))]
        .sort((a, b) => a.startsAt - b.startsAt))
    }
    return { pulses }
  }, [choreography.pulses, lines])
  // Facts come from each node's pinned Agent configuration version, never current Agent settings.
  const pins = useMemo(() => [...new Map(topology?.nodes.filter(node=>node.kind==='agent').map((node) => [node.configurationId, node.agentId])).entries()], [topology])
  const configurations = useQueries({ queries: pins.map(([versionId, agentId]) => ({
    queryKey: [...runInspectionQueryKey(scope), 'agent-version', agentId, versionId],
    queryFn: ({ signal }: { signal: AbortSignal }) => readPinnedAgentVersion(scope.workspaceId, agentId, versionId, { signal }),
    retry: false, staleTime: Infinity, gcTime: 60_000, refetchOnWindowFocus: false,
  })), combine: (results) => results.map((result) => result.data) })
  const facts = useMemo(() => new Map(configurations.flatMap((configuration) => configuration
    ? [[configuration.id, agentNodeFacts({ harnessConfiguration: configuration.harness, productRole: configuration.productRole })] as const] : [])),
  [configurations])
  // Activity-only ticks replace the whole current record. Keep each node's data
  // object (and its inspect callback) unless that node's own presentation changed,
  // so React Flow does not rebuild the pinned canvas on every poll.
  const inspectRef = useRef<(nodeId: string) => void>(() => undefined)
  // An agent click opens nothing: its Activity is in its Info panel, the Run's in Activities on top. Jobs open their details.
  inspectRef.current = (nodeId: string) => { board.selectInspection({ runNodeId: nodeId }); board.openRuns() }
  const jobReferences = useRef(new Map<string, JobWorkflowAdmissionReference>())
  const jobExecutions = useMemo(() => {
    const latest = new Map<string, { reference: JobWorkflowAdmissionReference; attempt: number }>()
    for (const fact of record?.state.executions ?? []) {
      if (fact.identity.kind !== 'job') continue
      const id = fact.identity, occurrenceIndex = id.occurrence?.occurrenceIndex ?? 0
      const previous = latest.get(id.workflowNodeId)
      if (!previous || occurrenceIndex > previous.reference.occurrenceIndex || occurrenceIndex === previous.reference.occurrenceIndex && id.attempt > previous.attempt) {
        latest.set(id.workflowNodeId, { attempt: id.attempt, reference: { kind: 'job', workspaceId: scope.workspaceId, workflowId: scope.workflowId,
          runId: scope.runId, workflowVersionId: scope.workflowVersionId, nodeId: id.workflowNodeId, nodeExecutionId: id.executionId,
          occurrenceId: id.occurrence?.occurrenceId ?? null, occurrenceIndex } })
      }
    }
    // Reuse an identical reference so a poll that changes nothing here leaves the node data untouched.
    const stable = new Map<string, JobWorkflowAdmissionReference>()
    for (const [nodeId, { reference }] of latest) {
      const known = jobReferences.current.get(nodeId)
      stable.set(nodeId, known && JSON.stringify(known) === JSON.stringify(reference) ? known : reference)
    }
    jobReferences.current = stable
    return stable
  }, [record, scope.workspaceId, scope.workflowId, scope.runId, scope.workflowVersionId])
  type Cached = { source: unknown; execution?: JobWorkflowAdmissionReference; selected: boolean; recorded: string; facts: Facts; shown: string; node: RunNode }
  const previous = useRef(new Map<string, Cached>())
  const nodes = useMemo<RunNode[]>(() => {
    const next = new Map<string, Cached>()
    const result = topology?.nodes.map((node) => {
      const state = states.get(node.id)
      const selected = board.inspection.runNodeId === node.id
      const recorded = !record ? recordLoading ? 'Loading current status' : 'Current status unavailable' : !state ? 'No activation in the bounded current cut' :
        `${state.label}${state.occurrenceIndex ? ` · repetition ${state.occurrenceIndex}` : ''}${state.attempt ? ` · attempt ${state.attempt}` : ''}`
        + (checking.has(node.id) ? ` · ${checkingView(checking.get(node.id)!.check, checking.get(node.id)!.queued).label}` : '')
      const nodeFacts:Facts = node.kind==='job'?{...unknownFacts,harness:undefined,harnessLabel:'Job',roleLabel:'Job',model:undefined,meta:[{label:'Revision',value:String(node.jobDefinitionRevision)}]}:facts.get(node.configurationId)??unknownFacts
      const baseView = !record ? { state: 'unavailable' as const, label: recordLoading ? 'Loading…' : 'Unavailable' }
        : choreography.nodes.get(node.id) ?? { state: 'idle' as const, label: 'Not started' }
      const current = liveNodeView(baseView, waits.get(node.id), cis.get(node.id), checks.get(node.id), checking.get(node.id),
        live ? executionQueue.get(node.id) : undefined)
      const view = current === baseView ? baseView : { ...baseView, ...current }
      const shown = `${view.state}:${view.label}:${'transition' in view ? `${view.transition}@${view.transitionKey}` : ''}`
      const cached = previous.current.get(node.id)
      const execution = node.kind === 'job' ? jobExecutions.get(node.id) : undefined
      const entry = cached && cached.source === node && cached.execution === execution && cached.selected === selected && cached.recorded === recorded && cached.facts === nodeFacts && cached.shown === shown ? cached
        : { source: node, execution, selected, recorded, facts: nodeFacts, shown, node: { id: node.id, type: 'pinnedRunNode', position: node.position,
          data: { ...node, workflowExecution: execution, selected, inspect: () => inspectRef.current(node.id), recorded, facts: nodeFacts,
            status:node.kind==='job'&&state?.jobOutcome?state.jobOutcome.replaceAll('_',' '):view.label,state:node.kind==='job'&&state?.jobOutcome&&state.jobOutcome!=='succeeded'&&state.jobOutcome!=='cancelled'?'failed':view.state, ...('transition' in view && view.transition ? { transition: view.transition, transitionKey: view.transitionKey } : {}) } } as RunNode }
      next.set(node.id, entry)
      return entry.node
    }) ?? []
    previous.current = next
    return result
  }, [topology, states, record, recordLoading, facts, jobExecutions, board.inspection.runNodeId, choreography.nodes,
    cis, waits, checks, checking, executionQueue, live])
  const { canvasNodes, presentedNodes, onNodesChange, beginResize, resize, finishResize } =
    useRunCanvasGeometry({ nodes, layout, version, geometry })
  const ciServerNode = useMemo(() => canvasNodes.length ? ciServerFlowNode(canvasNodes, ciSummary,
    () => useInspectionPresentation.getState().setOpen(ciDialogKey, true)) : undefined, [ciSummary, canvasNodes, ciDialogKey])
  const flowNodes = useMemo(() => ciServerNode ? [...canvasNodes, ciServerNode] : canvasNodes, [canvasNodes, ciServerNode])
  const edges = usePinnedRunEdges(lines, board.inspection.runRelationshipId, version, handoffs)
  // A light per Agent while its CI request or result travels; no lasting line to the server.
  const flowEdges = useMemo<(RunEdge | CiTransferFlowEdge)[]>(() => ciServerNode && transfers.size ? [...edges,
    ...[...transfers].filter(([nodeId]) => presentedNodes.some((node) => node.id === nodeId)).map(([nodeId, pulses]) => ({
      id: `ci-transfer:${nodeId}`, type: 'ciTransfer' as const, source: nodeId, target: CI_SERVER_NODE_ID,
      sourceHandle: 'right', targetHandle: 'left', selectable: false, focusable: false, deletable: false, data: { pulses } }))]
    : edges, [edges, transfers, ciServerNode, presentedNodes])
  const missingNode = !!version && !!board.inspection.runNodeId
    && !version.definition.nodes.some((node) => node.id === board.inspection.runNodeId)
  return <section className="next-draft-canvas board-draft-canvas pinned-run-canvas" aria-label="Selected Run pinned topology">
    {/* Seen, the Run is just this Board; the small Run tag names it. Assistive tech still gets the exact pins. */}
    <h2 className="visually-hidden">{version?.definition.name ?? 'Selected Run'} · Run {scope.runId} · version {scope.workflowVersionId}</h2>
    {query.isPaused ? <p role="status">Pinned topology refresh is paused. Any retained topology is a previously verified saved version.</p>
      : query.isPending ? <p role="status">Loading this Run’s exact saved topology…</p> : null}
    {query.isError || denied || canonicalDenied ? <Alert tone="warning" title="The selected Run topology is unavailable.">
      {!denied && !canonicalDenied ? <Button size="sm" onClick={() => void query.refetch()}>Retry pinned topology</Button> : null}
    </Alert> : null}
    {missingNode ? <Alert tone="warning" title="The linked node is not in this Run’s saved version.">
      <Button size="sm" onClick={() => board.selectInspection({})}>Clear missing node selection</Button>
    </Alert> : null}
    {version ? <div className="pinned-run-flow">
      <ReactFlowProvider><RunAgentPanels.Provider value={{ panels, open, setOpen, chatScope, openChat, beginResize, resize, finishResize }}><Choreography.Provider value={motion}><ReactFlow<RunNode | CiServerFlowNode, RunEdge | CiTransferFlowEdge> nodes={flowNodes} edges={flowEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        onNodesChange={onNodesChange} nodesDraggable={Boolean(geometry)} nodesConnectable={false} nodesFocusable edgesFocusable
        elementsSelectable deleteKeyCode={null} onlyRenderVisibleElements
        fitView fitViewOptions={fitViewOptions} proOptions={proOptions} minZoom={0.1} maxZoom={1.6}
        aria-label="Run graph canvas">
        <SelectedRunSubagents key={scope.runId} scope={scope} nodes={canvasNodes} />
        <Background color="var(--border)" gap={24} size={1} />
      </ReactFlow></Choreography.Provider></RunAgentPanels.Provider></ReactFlowProvider>
    </div> : null}
    {panels && !board.selectSidePanel ? <AgentChatWindowLayer scope={chatScope} content={(nodeId) => {
      const node = presentedNodes.find((item) => item.id === nodeId)
      if (!node || node.data.kind !== 'agent') return undefined
      const { chat, chatHasHeader } = panels(nodeId, { agentId: node.data.agentId, name: node.data.label, role: node.data.facts.roleLabel, runLabel: node.data.status })
      return chat ? { name: node.data.label, harness: node.data.facts.harness, chat, chatHasHeader } : undefined
    }} /> : null}
    {panels ? <RunRailAgentPanel panels={panels} chatScope={chatScope} nodes={presentedNodes} /> : null}
    <CiServerDialog open={ciDialogOpen} onOpenChange={setCiDialogOpen} scope={scope} workflow={{ workspaceId: scope.workspaceId, workflowId: scope.workflowId }} jobs={ciRunJobs ?? []} names={names}
      truncated={!ciDenied && (ciList.data?.truncated ?? false)} error={Boolean(ciDenied || ciList.isError)} loading={ciList.isPending} />
  </section>
}

function withPinnedReportingParent(panels: AgentPanelRenderer | undefined,
  version: NonNullable<ReturnType<typeof useRunVersionQuery>['data']>['version'] | undefined): AgentPanelRenderer | undefined {
  if (!panels) return undefined
  return (nodeId, pinned) => {
    if (!pinned || pinned.kind === 'job') return panels(nodeId, pinned)
    const hierarchy = version?.definition.hierarchy
    const parentId = hierarchy?.parents.find(member => member.workflowNodeId === nodeId)?.parentNodeId
    const parent = version?.definition.nodes.find(node => node.id === parentId)
    const reportingParent = parent ? parent.name ?? parent.label ?? parent.id
      : hierarchy?.masterNodeId === nodeId ? 'None (Master)' : hierarchy ? 'Unassigned' : undefined
    return panels(nodeId, { ...pinned, reportingParent })
  }
}

function usePinnedRunEdges(lines: ReturnType<typeof relationshipLines<WorkflowRelationship>>, selectedId: string | undefined,
  version: NonNullable<ReturnType<typeof useRunVersionQuery>['data']>['version'] | undefined,
  handoffs: ReturnType<typeof useRunHandoffsQuery>['data']) {
  return useMemo<RunEdge[]>(() => {
    const counts = new Map<string, number>()
    return lines.lines.map(edge => {
      const pair = JSON.stringify([edge.source, edge.target].sort()), count = counts.get(pair) ?? 0
      counts.set(pair, count + 1)
      const reporting = isHierarchyReportingRoute(version?.definition.hierarchy, edge)
      const parent = version?.definition.nodes.find(node => node.id === edge.source)
      return { id: edge.id, source: edge.source, target: edge.target, type: 'pinnedRunEdge',
        sourceHandle: 'right', targetHandle: 'left',
        selected: edge.members.some(member => member.id === selectedId),
        ariaLabel: `${reporting ? 'Orchestrates' : edge.kind} relationship ${edge.id} from ${edge.source} to ${edge.target}`,
        data: { kind: edge.kind, bend: edgeBend(count, edge.source < edge.target),
          reportingParent: reporting ? parent?.name ?? parent?.label ?? edge.source : undefined,
          handoffs: Boolean(version?.definition.handoffs && edge.kind === 'execution'),
          limit: edge.maxWorkHandoffsPerRun, used: handoffs?.connections.find(item => item.relationshipId === edge.id)?.used } }
    })
  }, [lines, selectedId, version, handoffs?.connections])
}

function RunRailAgentPanel({ panels, chatScope, nodes }: { panels: AgentPanelRenderer; chatScope: string; nodes: RunNode[] }) {
  return <WorkflowAgentPanel panels={panels} chatScope={chatScope}
    nodes={nodes.map(node => ({ id: node.id, name: node.data.label }))} findNode={nodeId => {
      const node = nodes.find(item => item.id === nodeId)
      return node?.data.kind === 'agent' ? { agentId: node.data.agentId, name: node.data.label,
        role: node.data.facts.roleLabel, runLabel: node.data.status } : node?.data.kind === 'job'
          ? { kind: 'job', jobDefinitionId: node.data.jobDefinitionId, jobDefinitionRevision: node.data.jobDefinitionRevision,
            jobDefinitionVersionId: node.data.jobDefinitionVersionId, name: node.data.label, workflowExecution: node.data.workflowExecution } : false
    }} />
}

function SelectedRunSubagents({ scope, nodes: flowNodes }: { scope: RepeatGraphScopeV3; nodes: RunNode[] }) {
  const initialized = useNodesInitialized()
  const flow = useReactFlow<RunNode>()
  const nodes: SubagentLayoutNode[] = flowNodes.flatMap((node) => {
    const measured = initialized ? flow.getInternalNode(node.id)?.measured : undefined
    // A resized node carries its size explicitly; React Flow may not re-measure it.
    const width = measured?.width ?? node.width
    const height = measured?.height ?? node.height
    if (!width || !height) return []
    return [{ id: node.id, kind: node.data.kind, position: node.position, size: { width, height } }]
  })
  return <RunSubagentsOverlay scope={scope} nodes={nodes} />
}

function useRunCanvasGeometry({ nodes, layout, version, geometry }: {
  nodes: RunNode[]
  layout: Parameters<typeof SelectedRunCanvas>[0]['layout']
  version: NonNullable<ReturnType<typeof useRunVersionQuery>['data']>['version'] | undefined
  geometry: Parameters<typeof SelectedRunCanvas>[0]['geometry']
}) {
  const [adapter] = useState(() => createGraphGeometryAdapter<RunNode>([]))
  const [canvasNodes, setCanvasNodes] = useState<RunNode[]>([])
  // Node selection is local presentation, like the draft canvas; it never changes the Run.
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())
  const layoutById = useMemo(() => new Map(layout?.map((node) => [node.id, node])), [layout])
  const pinnedById = useMemo(() => new Map(version?.definition.nodes.map((node) => [node.id, node])), [version])
  const presented = useRef(new Map<string, { source: RunNode; node: RunNode }>())
  const presentedNodes = useMemo(() => {
    const sizes = new Map(nodes.map((node) => {
      const placement = layoutById.get(node.id) ?? pinnedById.get(node.id)
      return [node.id, { width: placement?.width ?? GRAPH_NODE_DEFAULT_SIZE, height: placement?.height ?? GRAPH_NODE_DEFAULT_SIZE }] as const
    }))
    // A node still on the Board keeps the Board's place for it (the person's own, or the hierarchy's). A node the
    // Board no longer has keeps its pinned position, or the hierarchy of the Run's own pinned edges.
    const placed = layoutHierarchy(nodes.map((node) => ({ id: node.id, ...sizes.get(node.id)! })),
      version?.definition.edges ?? [], version?.entryNodeId)
    return nodes.map((node) => {
      const { width, height } = sizes.get(node.id)!
      const pinned = pinnedById.get(node.id)?.position
      const position = layoutById.get(node.id)?.position ?? (pinned?.manual ? { x: pinned.x, y: pinned.y } : undefined)
        ?? placed.get(node.id) ?? node.position
      const resizable = Boolean(layoutById.has(node.id) && geometry)
      const cached = presented.current.get(node.id)
      if (cached && cached.source === node && cached.node.width === width && cached.node.height === height
        && cached.node.position.x === position.x && cached.node.position.y === position.y
        && cached.node.data.resizable === resizable) return cached.node
      const result = { ...node, draggable: resizable, position, width, height, style: { width, height },
        data: { ...node.data, resizable } }
      presented.current.set(node.id, { source: node, node: result })
      return result
    })
  }, [nodes, layoutById, pinnedById, geometry, version])
  useLayoutEffect(() => {
    const selected = new Set([...picked, ...presentedNodes.filter((node) => node.data.selected).map((node) => node.id)])
    setCanvasNodes(adapter.reconcile(presentedNodes, selected))
  }, [adapter, presentedNodes, picked])
  const flushGeometry = () => {
    const changes = adapter.flush()
    if (changes.length) geometry?.(changes)
  }
  const onNodesChange = (changes: NodeChange<RunNode | CiServerFlowNode>[]) => {
    const selections = changes.filter((change) => change.type === 'select' && change.id !== CI_SERVER_NODE_ID)
    if (selections.length) setPicked((current) => {
      const next = new Set(current)
      for (const change of selections) if (change.type === 'select') { if (change.selected) next.add(change.id); else next.delete(change.id) }
      return next
    })
    const editable = changes.filter((change): change is NodeChange<RunNode> =>
      change.type === 'position' && Boolean(layoutById.has(change.id) && geometry))
    const result = adapter.update(editable)
    setCanvasNodes(result.nodes)
    if (result.finished) flushGeometry()
  }
  const resize = (change: GraphGeometryChange) => {
    const result = adapter.update([
      { id: change.id, type: 'dimensions', dimensions: { width: change.width!, height: change.height! }, resizing: true },
      { id: change.id, type: 'position', position: change.position },
    ])
    setCanvasNodes(result.nodes)
  }
  const finishResize = (change: GraphGeometryChange) => {
    setCanvasNodes(adapter.finishResize(change.id, change.width!, change.height!, change.position))
    flushGeometry()
  }
  return { canvasNodes, presentedNodes, onNodesChange, beginResize: adapter.beginResize, resize, finishResize }
}
