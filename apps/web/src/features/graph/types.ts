import type { WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import type {
  Agent,
  AgentExecutionState,
  HarnessExecutionState,
  RunOutcome,
  RunNodeLiveActivity,
  ReviewStatus,
  WorkflowExecutionPolicy,
  WorkflowRunSummary,
} from '@foreman-code/contracts'

import type { Edge, Node } from '@xyflow/react'

/**
 * Data used by the renderer only. The contracts package intentionally has no
 * dependency on React Flow or any other UI library.
 */
export type GraphNodeData = {
  workflowNodeId: string
  agentId: string
  agent: Agent
  label: string
  /** Static label only; volatile harness health stays out of the topology. */
  harnessLabel?: string
  role?: string
  description?: string
  executionState?: AgentExecutionState
  executionStateLabel: string
  stepLabel: string
  waitLabel?: string
  initialPrompt?: string
  /** Saved interval check period; absent when interval checks are off. */
  intervalSeconds?: number
  runState?: HarnessExecutionState
  runOutcome?: RunOutcome
  runActive?: boolean
  reviewState?: ReviewStatus['state']
  liveActivity?: RunNodeLiveActivity
  executionPolicy: WorkflowExecutionPolicy
  workflowNodeCount: number
  /** Renderer-only marker for a node that is animating out after removal. */
  departing?: boolean
  /** Renderer-only marker for a newly added node entering the canvas. */
  entering?: boolean
  onSelect?: (agentId: string, workflowNodeId: string, additive: boolean) => void
  onOpenSettings?: (agentId: string, workflowNodeId: string) => void
  onRemove?: (workflowNodeId: string) => void
  onSaveSettings?: (
    workflowNodeId: string,
    agent: Agent,
    initialPrompt: string | undefined,
    executionPolicy: WorkflowExecutionPolicy,
  ) => void
  onResize?: (workflowNodeId: string, width: number, height: number) => void
}

export type AgentGraphNode = Node<GraphNodeData, 'agent'> & {type:'agent'}
export type JobGraphNodeData = {kind:'job';workflowNodeId:string;workspaceId:string;jobDefinitionId:string;jobDefinitionRevision:number;jobDefinitionVersionId:string;label:string;description?:string;stepLabel:string;departing?:boolean;entering?:boolean;onOpen?: (nodeId:string)=>void}
export type JobGraphNode = Node<JobGraphNodeData,'job'> & {type:'job'}
export type GraphNode = AgentGraphNode | JobGraphNode

/** A node exposes exactly one handle per side, shared by every connection. */
export type GraphHandleSide = 'top' | 'right' | 'bottom' | 'left'

export type GraphEdgeData = {
  /** Disposable renderer-only copy of a removed connection. */
  departing?: boolean
  /** This is a visual explanation, not a permission or execution contract. */
  explanation: string
  onRemove?: (edgeId: string) => void
}

export type GraphEdge = Edge<GraphEdgeData>

export type GraphProjection = {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export type GraphMapperOptions = {
  onOpenJobNode?: (nodeId:string)=>void
  selectedAgentId?: string
  selectedNodeIds?: ReadonlySet<string>
  runStatesByNodeId?: ReadonlyMap<string, HarnessExecutionState>
  runOutcomesByNodeId?: ReadonlyMap<string, RunOutcome>
  runActive?: boolean
  reviewStatesByAgentId?: ReadonlyMap<string, ReviewStatus['state']>
  liveActivitiesByNodeId?: ReadonlyMap<string, RunNodeLiveActivity>
  onSelectAgent?: (agentId: string, workflowNodeId: string, additive: boolean) => void
  onOpenNodeSettings?: (agentId: string, workflowNodeId: string) => void
  onRemoveNode?: (workflowNodeId: string) => void
  onSaveNodeSettings?: (
    workflowNodeId: string,
    agent: Agent,
    initialPrompt: string | undefined,
    executionPolicy: WorkflowExecutionPolicy,
  ) => void
  onResizeNode?: (workflowNodeId: string, width: number, height: number) => void
  /** Removes a single connection edge without touching its nodes. */
  onRemoveEdge?: (edgeId: string) => void
  /** Authoritative run projections used to name an agent's active wait. */
  runFacts?: readonly WorkflowRunSummary[]
  /** Renderer-only ids used to play a node entrance animation after insertion. */
  enteringNodeIds?: ReadonlySet<string>
}

export type GraphSource = {
  workflow: WorkflowDefinitionV3
  agents: readonly Agent[]
  runFacts?: readonly WorkflowRunSummary[]
}
