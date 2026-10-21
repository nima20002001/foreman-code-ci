import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import type { WorkflowDefinitionV3, WorkflowNodeV3 } from '@foreman-code/contracts/wave25'
import type {
  Agent,
  AgentExecutionState,
  WorkflowRunSummary,
} from '@foreman-code/contracts'

import type { XYPosition } from '@xyflow/react'

import { layoutHierarchy } from './hierarchyLayout'

import type {
  GraphEdge,
  GraphHandleSide,
  GraphMapperOptions,
  GraphNode,
  GraphProjection,
} from './types'

export const AGENT_HANDOFF_EDGE_TYPE = 'agentHandoff'

export const GRAPH_NODE_MIN_WIDTH = 120
export const GRAPH_NODE_MAX_WIDTH = 520
export const GRAPH_NODE_MIN_HEIGHT = 120
export const GRAPH_NODE_MAX_HEIGHT = 320
// Compact on purpose: a hierarchy of many Agents has to stay readable at a glance.
export const GRAPH_NODE_DEFAULT_SIZE = 156
const DEFAULT_NODE_WIDTH = GRAPH_NODE_DEFAULT_SIZE
const DEFAULT_NODE_HEIGHT = GRAPH_NODE_DEFAULT_SIZE
export const ORCHESTRATOR_NODE_SIZE = 188
const DEFAULT_NODE_GAP = 92
const DEFAULT_NODE_Y = 120
// Placement reserves the default circle plus room for rim actions and connections.
const PLACEMENT_SIZE = 212
const PLACEMENT_GAP = 88

const executionStateLabels: Record<AgentExecutionState, string> = {
  available: 'Available',
  working: 'Working',
  waiting_browser: 'Waiting for browser',
  auth_required: 'Auth required',
  interrupted: 'Interrupted',
  disconnected: 'Disconnected',
}

export function executionStateLabel(state?: AgentExecutionState): string {
  return state ? executionStateLabels[state] : 'Idle'
}

function fallbackPosition(index: number): XYPosition {
  return {
    x: index * (DEFAULT_NODE_WIDTH + DEFAULT_NODE_GAP) + 64,
    y: DEFAULT_NODE_Y,
  }
}

function workflowNodePosition(node: WorkflowNodeV3, index: number): XYPosition {
  return node.position ? { x: node.position.x, y: node.position.y } : fallbackPosition(index)
}

function rectanglesOverlap(
  left: { position: XYPosition; width: number; height: number },
  right: { position: XYPosition; width: number; height: number },
): boolean {
  return left.position.x < right.position.x + right.width
    && left.position.x + left.width > right.position.x
    && left.position.y < right.position.y + right.height
    && left.position.y + left.height > right.position.y
}

/**
 * Finds the first free slot around an insertion anchor. Newly added steps stay
 * close to the add control while avoiding every existing node, including nodes
 * that were moved or resized by the user.
 */
export function findOpenNodePosition(
  nodes: readonly WorkflowNodeV3[],
  anchor: XYPosition,
  width = PLACEMENT_SIZE,
  height = PLACEMENT_SIZE,
): XYPosition {
  const occupied = nodes.map((node, index) => ({
    position: workflowNodePosition(node, index),
    width: Math.max(PLACEMENT_SIZE, node.width ?? PLACEMENT_SIZE),
    height: Math.max(PLACEMENT_SIZE, node.height ?? PLACEMENT_SIZE),
  }))
  const stepX = width + PLACEMENT_GAP
  const stepY = height + PLACEMENT_GAP
  const offsets: XYPosition[] = [
    { x: 0, y: 0 },
    { x: stepX, y: 0 },
    { x: -stepX, y: 0 },
    { x: 0, y: stepY },
    { x: 0, y: -stepY },
    { x: stepX, y: stepY },
    { x: -stepX, y: stepY },
    { x: stepX, y: -stepY },
    { x: -stepX, y: -stepY },
  ]

  for (const offset of offsets) {
    const candidate = { x: anchor.x + offset.x, y: anchor.y + offset.y }
    const box = { position: candidate, width, height }
    if (!occupied.some((existing) => rectanglesOverlap(box, existing))) return candidate
  }

  // A large, irregularly arranged canvas can consume the compact ring. Keep
  // searching in expanding rings instead of falling back to a colliding node.
  for (let ring = 2; ring < 50; ring += 1) {
    const candidates = [
      { x: ring * stepX, y: 0 },
      { x: -ring * stepX, y: 0 },
      { x: 0, y: ring * stepY },
      { x: 0, y: -ring * stepY },
    ]
    for (const offset of candidates) {
      const candidate = { x: anchor.x + offset.x, y: anchor.y + offset.y }
      const box = { position: candidate, width, height }
      if (!occupied.some((existing) => rectanglesOverlap(box, existing))) return candidate
    }
  }

  return { x: anchor.x, y: anchor.y }
}

function clampNodeSize(width: number, height: number) {
  return {
    width: Math.min(GRAPH_NODE_MAX_WIDTH, Math.max(GRAPH_NODE_MIN_WIDTH, width)),
    height: Math.min(GRAPH_NODE_MAX_HEIGHT, Math.max(GRAPH_NODE_MIN_HEIGHT, height)),
  }
}

function agentState(agent: Agent | undefined): AgentExecutionState | undefined {
  return agent?.executionState ?? agent?.status
}

type NodeBox = {
  position: XYPosition
  width: number
  height: number
}

/**
 * Routes a connection from the side of the source that faces the target and
 * into the side of the target that faces the source. Ties prefer the
 * horizontal axis so left/right handoffs stay predictable.
 */
export function closestHandleSides(
  source: NodeBox,
  target: NodeBox,
): { sourceHandle: GraphHandleSide; targetHandle: GraphHandleSide } {
  const sourceCenterX = source.position.x + source.width / 2
  const sourceCenterY = source.position.y + source.height / 2
  const targetCenterX = target.position.x + target.width / 2
  const targetCenterY = target.position.y + target.height / 2
  const dx = targetCenterX - sourceCenterX
  const dy = targetCenterY - sourceCenterY
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceHandle: 'right', targetHandle: 'left' }
      : { sourceHandle: 'left', targetHandle: 'right' }
  }
  return dy >= 0
    ? { sourceHandle: 'bottom', targetHandle: 'top' }
    : { sourceHandle: 'top', targetHandle: 'bottom' }
}

function activeRunId(agent: Agent | undefined): string | undefined {
  if (!agent || !('activeRunId' in agent)) return undefined
  const value = agent.activeRunId
  return typeof value === 'string' ? value : undefined
}

function waitLabel(
  agent: Agent | undefined,
  state: AgentExecutionState | undefined,
  runFacts: readonly WorkflowRunSummary[] = [],
): string | undefined {
  if (state !== 'waiting_browser' && state !== 'auth_required') return undefined

  const runId = activeRunId(agent)
  if (!runId) return undefined

  const browserWait = runFacts.find((run) => run.id === runId)?.browserWait
  if (!browserWait) return undefined

  const resourceName = browserWait.resourceName?.trim()
  const holderLabel = browserWait.holderLabel?.trim()
  if (resourceName && holderLabel) return `${resourceName} · held by ${holderLabel}`
  if (resourceName) return resourceName
  if (holderLabel) return `held by ${holderLabel}`
  return undefined
}

function nodeLabel(workflowNode: WorkflowNodeV3, agent: Agent | undefined): string {
  return workflowNode.name ?? workflowNode.label ?? agent?.name ?? (workflowNode.kind==='job'?'Job':workflowNode.agentId)
}

export function workflowToGraph(
  { workflow, agents }: { workflow: WorkflowDefinitionV3; agents: readonly Agent[] },
  options: GraphMapperOptions = {},
): GraphProjection {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]))
  const executionPolicy = workflow.executionPolicy ?? {
    maxParallelism: Math.max(1, workflow.nodes.length),
    maxNodeExecutions: Math.max(1, workflow.nodes.length),
  }

  const nodes: GraphNode[] = workflow.nodes.map((workflowNode, index) => {
    if(workflowNode.kind==='job') {
      const size=clampNodeSize(workflowNode.width??DEFAULT_NODE_WIDTH,workflowNode.height??DEFAULT_NODE_HEIGHT)
      return {id:workflowNode.id,type:'job',position:workflowNodePosition(workflowNode,index),initialWidth:size.width,initialHeight:size.height,width:size.width,height:size.height,style:size,selected:Boolean(options.selectedNodeIds?.has(workflowNode.id)),
        data:{kind:'job',workflowNodeId:workflowNode.id,workspaceId:workflow.workspaceId,jobDefinitionId:workflowNode.jobDefinitionId,jobDefinitionRevision:workflowNode.jobDefinitionRevision,jobDefinitionVersionId:workflowNode.jobDefinitionVersionId,label:nodeLabel(workflowNode,undefined),description:workflowNode.description,stepLabel:`Step ${index+1}`,entering:options.enteringNodeIds?.has(workflowNode.id),onOpen:options.onOpenJobNode}}
    }
    const agent = agentsById.get(workflowNode.agentId)
      ?? { id: workflowNode.agentId, name: workflowNode.name ?? workflowNode.label ?? workflowNode.agentId }
    const state = agentState(agent)
    const liveActivity = options.runActive ? options.liveActivitiesByNodeId?.get(workflowNode.id) : undefined
    const runState = options.runStatesByNodeId?.get(workflowNode.id)
    const runOutcome = options.runOutcomesByNodeId?.get(workflowNode.id)
    const defaultSize = agent.productRole === 'master' || agent.productRole === 'orchestrator' ? ORCHESTRATOR_NODE_SIZE : DEFAULT_NODE_WIDTH
    const size = clampNodeSize(workflowNode.width ?? defaultSize, workflowNode.height ?? defaultSize)
    return {
      id: workflowNode.id,
      type: 'agent',
      position: workflowNodePosition(workflowNode, index),
      initialWidth: size.width,
      initialHeight: size.height,
      width: size.width,
      height: size.height,
      style: size,
      selected: Boolean(
        options.selectedNodeIds?.has(workflowNode.id)
        || ((!options.selectedNodeIds || options.selectedNodeIds.size === 0)
          && options.selectedAgentId === workflowNode.agentId),
      ),
      data: {
        workflowNodeId: workflowNode.id,
        agentId: workflowNode.agentId,
        agent,
        label: nodeLabel(workflowNode, agent),
        role: agent?.role,
        description: workflowNode.description ?? agent?.description,
        executionState: state,
        executionStateLabel: executionStateLabel(state),
        stepLabel: `Step ${index + 1}`,
        waitLabel: waitLabel(agent, state, options.runFacts),
        initialPrompt: workflowNode.initialPrompt,
        ...(workflowNode.interval ? { intervalSeconds: workflowNode.interval.everySeconds } : {}),
        runState,
        runOutcome,
        runActive: options.runActive,
        liveActivity: liveActivity?.agentId === workflowNode.agentId ? liveActivity : undefined,
        reviewState: options.reviewStatesByAgentId?.get(workflowNode.agentId),
        executionPolicy,
        workflowNodeCount: workflow.nodes.length,
        entering: options.enteringNodeIds?.has(workflowNode.id),
        onSelect: options.onSelectAgent,
        onOpenSettings: options.onOpenNodeSettings,
        onRemove: options.onRemoveNode,
        onSaveSettings: options.onSaveNodeSettings,
        onResize: options.onResizeNode,
      },
    }
  })

  // Only explicit manual placement overrides the hierarchy; older saved positions are automatic.
  const placed = layoutHierarchy(nodes.map((node) => ({ id: node.id, width: node.width ?? DEFAULT_NODE_WIDTH, height: node.height ?? DEFAULT_NODE_HEIGHT })),
    workflow.edges, workflow.entryNodeId ?? undefined)
  nodes.forEach((node, index) => {
    if (!workflow.nodes[index]!.position?.manual) nodes[index] = { ...node, position: placed.get(node.id)! } as GraphNode
  })

  const nodeBoxes = new Map<string, NodeBox>(nodes.map((node) => [node.id, {
    position: node.position,
    width: node.width ?? DEFAULT_NODE_WIDTH,
    height: node.height ?? DEFAULT_NODE_HEIGHT,
  }]))

  const edges: GraphEdge[] = workflow.edges.map((workflowEdge) => {
    const source = nodeBoxes.get(workflowEdge.source)
    const target = nodeBoxes.get(workflowEdge.target)
    const sides = source && target
      ? closestHandleSides(source, target)
      : { sourceHandle: 'right' as const, targetHandle: 'left' as const }
    return {
      id: workflowEdge.id,
      source: workflowEdge.source,
      target: workflowEdge.target,
      type: AGENT_HANDOFF_EDGE_TYPE,
      sourceHandle: sides.sourceHandle,
      targetHandle: sides.targetHandle,
      label: workflowEdge.label,
      data: { explanation: workflowEdge.kind === 'approval' ? 'Approval relationship' : 'Execution relationship', onRemove: options.onRemoveEdge },
    }
  })

  return { nodes, edges }
}

export function makeSequentialHandoffEdge(source: string, target: string): GraphEdge {
  return {
    id: `edge-${source}-${target}`,
    source,
    target,
    type: AGENT_HANDOFF_EDGE_TYPE,
    data: { explanation: 'Sequential handoff' },
  }
}

export function hasConnection(
  edges: readonly Pick<GraphEdge, 'source' | 'target'>[],
  source: string,
  target: string,
): boolean {
  return edges.some((edge) => edge.source === source && edge.target === target)
}

/**
 * Materializes the position and size the canvas derives for each node. A draft
 * that only carries those derived values still compares equal to the saved
 * definition it was projected from.
 */
export function normalizeWorkflow(workflow: WorkflowDefinitionV3): WorkflowDefinitionV3 {
  return {
    ...workflow,
    nodes: workflow.nodes.map((node, index) => ({
      ...node,
      position: workflowNodePosition(node, index),
      ...clampNodeSize(
        node.width ?? DEFAULT_NODE_WIDTH,
        node.height ?? DEFAULT_NODE_HEIGHT,
      ),
    })),
  }
}

/**
 * Structural equality for dirty-state checks. Definitions are normalized and
 * serialized with stable key order so an untouched draft never counts as a
 * persisted change.
 */
export function sameWorkflow(left: WorkflowDefinitionV3, right: WorkflowDefinitionV3): boolean {
  return canonicalJson(normalizeWorkflow(left))
    === canonicalJson(normalizeWorkflow(right))
}

export function withoutAgentReferences(
  workflow: WorkflowDefinitionV3,
  agentIds: ReadonlySet<string>,
): WorkflowDefinitionV3 {
  if (agentIds.size === 0) return workflow
  const removedNodeIds = new Set(
    workflow.nodes.filter((node) => node.kind!=='job' && agentIds.has(node.agentId)).map((node) => node.id),
  )
  if (removedNodeIds.size === 0) return workflow
  return {
    ...workflow,
    nodes: workflow.nodes.filter((node) => !removedNodeIds.has(node.id)),
    edges: workflow.edges.filter((edge) => !removedNodeIds.has(edge.source) && !removedNodeIds.has(edge.target)),
  }
}

export function resizeWorkflowNode(
  workflow: WorkflowDefinitionV3,
  workflowNodeId: string,
  width: number,
  height: number,
): WorkflowDefinitionV3 {
  const size = clampNodeSize(width, height)
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => node.id === workflowNodeId ? { ...node, ...size } : node),
  }
}
