import { InfoHint } from '../../shared/ui/InfoHint'
import { useHoverControls } from '../../shared/ui/useHoverControls'
import { memo, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { UnsavedChangesContext } from '../../shared/ui/unsavedChanges'
import { useInternalNode, type NodeProps, type EdgeProps } from '@xyflow/react'
import { AgentFacts, AgentNodeView, AgentPopover, Button, Icon, type AgentNodeState, type AgentPanel } from '../../shared/ui/nocturne'
import { AgentSettingsForm } from './AgentSettingsForm'
import { AgentHandles } from './AgentHandles'
import { AgentChatPanel } from './AgentPanels'
import { NodeTelemetryInfo } from '../resource-telemetry/NodeTelemetryInfo'
import { GraphGeometryContext, GraphNodeMenuContext } from './graphContexts'
import { useGraphPresentation, useGraphPresentationStore } from './useGraphPresentation'
import { useGraphNodeRuntime } from './useGraphNodeRuntime'
import { presentGraphNodeRuntime } from './nodePresentation'
import { agentNodeFacts, agentSettingRows, edgeBend, floatingCurve, lineBend, useFloatingCurve } from './signalEdge'
import { SignalEdgeShape } from './SignalEdgeShape'
import type { AgentGraphNode, GraphNode, GraphEdge } from './types'
import './graphRendering.css'

export const AgentNode = memo(function AgentNode({ data: staticData, isConnectable }: NodeProps<AgentGraphNode>) {
  const presentation = useGraphPresentationStore()
  const geometry = useContext(GraphGeometryContext)
  const selected = useGraphPresentation((state) => state.selectedNodeIds.has(staticData.workflowNodeId))
  const entering = useGraphPresentation((state) => state.enteringNodeIds.has(staticData.workflowNodeId))
  const departureCue = useGraphPresentation((state) => state.departingNodeIds.has(staticData.workflowNodeId))
  const departing = Boolean(staticData.departing && departureCue)
  const menuOpen = useGraphPresentation((state) => state.openMenuNodeId === staticData.workflowNodeId)
  const runtime = useGraphNodeRuntime(staticData.workflowNodeId, staticData.agentId)
  const data = { ...staticData, entering, departing }
  // Legacy mapper fields are not a second source of runtime truth. With no
  // scoped canonical leaf, even a plausible static activity remains unavailable.
  const detachedRuntime = !runtime.activity && (staticData.liveActivity !== undefined
    || staticData.runState !== undefined || staticData.runOutcome !== undefined || staticData.runActive !== undefined
    || staticData.reviewState !== undefined || staticData.executionState !== undefined
    || staticData.agent.executionState !== undefined || staticData.agent.status !== undefined
    || staticData.agent.harnessSummary?.status !== undefined)
  const nodeView = presentGraphNodeRuntime(runtime.activity, runtime.unavailable || departing || detachedRuntime)
  const status = nodeView.state === 'working' ? 'Running' : nodeView.state === 'unavailable' ? 'Unavailable' : nodeView.label
  const state: AgentNodeState = nodeView.state === 'working' ? 'running' : nodeView.state
  const nodeMenu = useContext(GraphNodeMenuContext)
  const core = useRef<HTMLButtonElement>(null)
  const [panel, setPanel] = useState<AgentPanel>('settings')
  const facts = agentNodeFacts(data.agent, data.role ?? data.agent.productRole)
  const readOnly = Boolean(geometry?.readOnly)
  const guard = useContext(UnsavedChangesContext)

  const setMenuOpen = useCallback((nextOpen: boolean) => {
    if (nodeMenu) nodeMenu.setOpenMenuNodeId(nextOpen ? data.workflowNodeId : undefined)
    else presentation.getState().setOpenMenuNodeId(nextOpen ? data.workflowNodeId : undefined)
  }, [data.workflowNodeId, nodeMenu, presentation])
  const openPanel = (next: AgentPanel) => {
    if (menuOpen && next === panel) { setMenuOpen(false); return }
    setPanel(next)
    if (!menuOpen) {
      data.onOpenSettings?.(data.agentId, data.workflowNodeId)
      setMenuOpen(true)
    }
  }
  const view = (children?: ReactNode, interactive = false) => <AgentNodeView ref={interactive ? core : undefined}
    name={data.label} harness={facts.harness} harnessLabel={facts.harnessLabel} model={facts.model} icon={facts.icon}
    statusLabel={status} state={state} meta={facts.meta} selected={selected} openPanel={menuOpen ? panel : undefined}
    ariaLabel={`${data.label} agent, ${data.stepLabel}, ${nodeView.label}${nodeView.actionLabel ? `, ${nodeView.actionLabel}` : ''}`}
    onSelect={interactive ? (event) => data.onSelect?.(data.agentId, data.workflowNodeId, event.ctrlKey || event.metaKey) : undefined}
    onAction={interactive ? openPanel : undefined}>{children}</AgentNodeView>

  if (data.departing) return <div className="workflow-agent-node-departing" aria-hidden="true">{view()}</div>

  return (
    <article
      className={`workflow-agent-node${selected ? ' workflow-agent-node-selected' : ''}${nodeView.state === 'working' || nodeView.state === 'waiting' ? ' workflow-agent-node-active' : ''}${data.entering ? ' workflow-agent-node-entering' : ''}`}
      data-testid={`agent-node-${data.agentId}`}
      data-agent-id={data.agentId}
      data-workflow-node-id={data.workflowNodeId}
      data-execution-state={nodeView.state}
      data-run-state={nodeView.state}
      data-live-event={nodeView.eventId}
      onFocus={() => presentation.getState().setFocusedNodeId(data.workflowNodeId)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) presentation.getState().setFocusedNodeId(undefined)
      }}
    >
      {view(<AgentHandles name={data.label} connectable={isConnectable && !readOnly} />, true)}
      <AgentPopover open={menuOpen} anchor={core} title={data.label} subtitle={`${facts.harnessLabel}${facts.model ? ` · ${facts.model}` : ''}`}
        icon={facts.icon} harness={facts.harness} panel={panel} chatHasHeader
        onClose={() => void (async () => { if (!guard || await guard.surfaces()) setMenuOpen(false) })()}
        chat={<AgentChatPanel name={data.label} role={facts.roleLabel} activity={nodeView.actionLabel} running={nodeView.working}
          onClose={() => void (async () => { if (!guard || await guard.surfaces()) setMenuOpen(false) })()} />}
        settings={readOnly || !data.onSaveSettings ? <>
          <h3>Saved Run settings<InfoHint label="Saved Run settings">A Run keeps the settings it started with. Change them on the workflow board.</InfoHint></h3>
          <AgentFacts items={agentSettingRows(data.agent)} />
        </> : <AgentSettingsForm
          embedded
          workspaceId={nodeMenu?.workspaceId}
          workflowApprovalHandler={nodeMenu?.workflowApprovalHandler}
          designatedOrchestrator={nodeMenu?.workflowApprovalHandler === 'orchestrator'
            && nodeMenu.designatedOrchestratorAgentId === data.agentId}
          agent={data.agent}
          initialPrompt={data.initialPrompt}
          executionPolicy={data.executionPolicy}
          workflowNodeCount={data.workflowNodeCount}
          onClose={() => setMenuOpen(false)}
          onRemove={data.onRemove ? () => { data.onRemove?.(data.workflowNodeId); setMenuOpen(false) } : undefined}
          onSave={(agent, initialPrompt, executionPolicy) => {
            data.onSaveSettings?.(data.workflowNodeId, agent, initialPrompt, executionPolicy)
            setMenuOpen(false)
          }}
        />}
        info={<>
          <AgentFacts items={[
            { label: 'Status', value: nodeView.actionLabel ? `${status} · ${nodeView.actionLabel}` : status },
            { label: 'Role', value: facts.roleLabel },
            { label: 'Step', value: data.stepLabel },
            ...agentSettingRows(data.agent),
            { label: 'Agent ID', value: data.agentId, mono: true },
          ]} />
          {/* No accepted/observed placement or telemetry selector reaches this node yet: explicit unavailable, no request. */}
          <NodeTelemetryInfo />
        </>} />
    </article>
  )
})

/** Focus, pointer, and touch reveal the connection controls. */
export const HandoffEdge = memo(function HandoffEdge({
  id, source, target, sourceX, sourceY, targetX, targetY, label, data,
}: EdgeProps<GraphEdge>) {
  const presentation = useGraphPresentationStore()
  const focused = useGraphPresentation((state) => state.focusedEdgeId === id)
  const entering = useGraphPresentation((state) => state.enteringEdgeId === id)
  const geometry = useContext(GraphGeometryContext)
  const { hovered, onPointerEnter, onPointerLeave, clearHover } = useHoverControls()
  const [inspecting, setInspecting] = useState(false)
  const active = !data?.departing && (hovered || focused)
  const receiver = useInternalNode<GraphNode>(target)
  const floating = useFloatingCurve(source, target, edgeBend(0, true))
  const ends = [{ x: sourceX, y: sourceY }, { x: targetX, y: targetY }] as const
  const curve = floating ?? floatingCurve(ends[0], ends[1], lineBend(ends[0], ends[1]) + edgeBend(0, true), 0)
  const receiverRuntime = useGraphNodeRuntime(receiver?.data.workflowNodeId ?? target, receiver?.data && 'agentId' in receiver.data?receiver.data.agentId:undefined)
  const receiverView = presentGraphNodeRuntime(receiverRuntime.activity, receiverRuntime.unavailable || !receiver)
  // Light only follows scoped runtime truth: a handoff is shown while its receiver is working.
  const signal = receiverView.state === 'working' || receiverView.state === 'waiting' ? 'task' as const : undefined
  const description = `Connection from ${source} to ${target}${typeof label === 'string' && label ? `: ${label}` : ''}`
  const removeLabel = `Remove connection from ${source} to ${target}${typeof label === 'string' && label ? `: ${label}` : ''}`
  const canRemove = !data?.departing && !geometry?.readOnly && Boolean(data?.onRemove)
  const { mid } = curve

  return <g className={entering ? 'workflow-graph-edge-new' : undefined}
    role="group" tabIndex={data?.departing ? -1 : 0} aria-hidden={data?.departing || undefined} aria-label={description}
    onPointerEnter={(event) => { if (event.pointerType !== 'touch') onPointerEnter() }}
    onPointerLeave={onPointerLeave}
    onFocus={() => presentation.getState().setFocusedEdgeId(id)}
    onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) {
        presentation.getState().setFocusedEdgeId(undefined)
        setInspecting(false)
      }
    }}
    onClick={(event) => {
      event.stopPropagation()
      event.currentTarget.focus?.()
      presentation.getState().setFocusedEdgeId(id)
    }}
    onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setInspecting(false)
        clearHover()
        event.currentTarget.focus?.()
        presentation.getState().setFocusedEdgeId(undefined)
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        event.stopPropagation()
        presentation.getState().setFocusedEdgeId(id)
        setInspecting(true)
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        event.stopPropagation()
        if (canRemove) data?.onRemove?.(id)
      }
    }}>
    <title>{data?.explanation ?? description}</title>
    <SignalEdgeShape id={id} curve={curve} signal={signal} />
    {active ? <rect className="board-edge-hover-bridge" x={mid.x - 112} y={mid.y}
      width={224} height={48} /> : null}
    <foreignObject aria-hidden={!active} data-visible={active} className="graph-edge-active-controls"
      x={mid.x - 112} y={mid.y + 10} width={224} height={inspecting ? 112 : 38}>
      <div className="graph-edge-controls nodrag nopan">
        <Button variant="secondary" tabIndex={active ? 0 : -1} aria-label={`Inspect ${description.toLowerCase()}`} title="Inspect connection"
          onKeyDown={(event) => { if (event.key !== 'Escape') event.stopPropagation() }}
          onClick={(event) => { event.stopPropagation(); setInspecting((current) => !current) }}>
          <Icon name="info" size={14} />
        </Button>
        {canRemove ? <Button variant="secondary" tabIndex={active ? 0 : -1} className="workflow-graph-edge-remove"
          aria-label={removeLabel} title="Remove connection"
          onKeyDown={(event) => { if (event.key !== 'Escape') event.stopPropagation() }}
          onClick={(event) => { event.stopPropagation(); data?.onRemove?.(id) }}>
          <Icon name="close" size={13} />
        </Button> : null}
      </div>
      {inspecting ? <div className="graph-edge-inspection" role="note">{data?.explanation ?? description}</div> : null}
    </foreignObject>
  </g>
})
