import type { WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import type { Agent } from '@foreman-code/contracts'
import { workflowToGraph } from './mapper'
import { retainArray, sameFields } from './graphReferences'
import type { GraphMapperOptions, GraphNode, GraphProjection } from './types'

/** No runtime, selection, menu, or animation input is accepted by the static projector. */
export type GraphTopologyActions = Pick<GraphMapperOptions,
  'onOpenJobNode' | 'onSelectAgent' | 'onOpenNodeSettings' | 'onRemoveNode' | 'onSaveNodeSettings' | 'onResizeNode' | 'onRemoveEdge'>

function editableAgent(agent: Agent): Agent {
  const metadata = { ...agent }
  // Workspace discovery may update these without changing the card's authored metadata.
  // Runtime leaves read the original Query records, never this render-only projection.
  delete metadata.executionState
  delete metadata.status
  delete metadata.activeRunId
  delete metadata.harnessSummary
  delete metadata.updatedAt
  return metadata
}

function retainNode(previous: GraphNode | undefined, next: GraphNode): GraphNode {
  if (!previous || previous.type!==next.type) return next
  if(next.type==='job') {
    if(previous.type!=='job')return next
    const candidate={...next,position:sameFields(previous.position,next.position)?previous.position:next.position,style:previous.style&&next.style&&sameFields(previous.style,next.style)?previous.style:next.style,data:sameFields(previous.data,next.data)?previous.data:next.data}
    return sameFields(previous,candidate)?previous:candidate
  }
  if(previous.type==='job')return next
  const policy = sameFields(previous.data.executionPolicy, next.data.executionPolicy)
    ? previous.data.executionPolicy : next.data.executionPolicy
  const data = { ...next.data, executionPolicy: policy,
    agent: sameFields(previous.data.agent, next.data.agent) ? previous.data.agent : next.data.agent }
  const candidate: GraphNode = {
    ...next,
    position: sameFields(previous.position, next.position) ? previous.position : next.position,
    style: previous.style && next.style && sameFields(previous.style, next.style) ? previous.style : next.style,
    data: sameFields(previous.data, data) ? previous.data : data,
  }
  return sameFields(previous, candidate) ? previous : candidate
}

/**
 * One instance per canvas. It caches derived metadata/render objects, not server facts.
 * In particular, a runtime-only Agent change does not call workflowToGraph at all.
 */
export function createGraphTopologyProjector(project = workflowToGraph) {
  let priorWorkflow: WorkflowDefinitionV3 | undefined
  let priorActions: GraphTopologyActions | undefined
  let agents: Agent[] = []
  let labels = new Map<string, string | undefined>()
  let graph: GraphProjection = { nodes: [], edges: [] }
  const metadataBySource = new WeakMap<Agent, Agent>()

  return (workflow: WorkflowDefinitionV3, incomingAgents: readonly Agent[], actions: GraphTopologyActions = {}): GraphProjection => {
    // Pick actions explicitly: structurally assignable wider option objects cannot leak runtime fields.
    const staticActions: GraphTopologyActions = {
      onOpenJobNode:actions.onOpenJobNode,onSelectAgent: actions.onSelectAgent, onOpenNodeSettings: actions.onOpenNodeSettings,
      onRemoveNode: actions.onRemoveNode, onSaveNodeSettings: actions.onSaveNodeSettings,
      onResizeNode: actions.onResizeNode, onRemoveEdge: actions.onRemoveEdge,
    }
    const nextLabels = new Map(incomingAgents.map((agent) => [agent.id, agent.harnessSummary?.label]))
    const labelsUnchanged = labels.size === nextLabels.size
      && [...nextLabels].every(([id, label]) => labels.has(id) && labels.get(id) === label)
    const previousAgents = new Map(agents.map((agent) => [agent.id, agent]))
    const nextAgents = retainArray(agents, incomingAgents.map((agent) => {
      let metadata = metadataBySource.get(agent)
      if (!metadata) {
        const candidate = editableAgent(agent)
        const previous = previousAgents.get(agent.id)
        metadata = previous && sameFields(previous, candidate) ? previous : candidate
        metadataBySource.set(agent, metadata)
      }
      return metadata
    }))
    if (workflow === priorWorkflow && agents === nextAgents && labelsUnchanged && priorActions && sameFields(priorActions, staticActions)) return graph
    const next = project({ workflow, agents: nextAgents }, staticActions)
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]))
    const edgesById = new Map(graph.edges.map((edge) => [edge.id, edge]))
    const nodes = retainArray(graph.nodes, next.nodes.map((node) => retainNode(nodesById.get(node.id), node.type==='job'?node:{
      ...node, data: { ...node.data, harnessLabel: nextLabels.get(node.data.agentId) },
    })))
    const edges = retainArray(graph.edges, next.edges.map((edge) => {
      const previous = edgesById.get(edge.id)
      if (!previous) return edge
      const candidate = {
        ...edge,
        data: previous.data && edge.data && sameFields(previous.data, edge.data) ? previous.data : edge.data,
      }
      return sameFields(previous, candidate) ? previous : candidate
    }))
    priorWorkflow = workflow
    priorActions = staticActions
    labels = nextLabels
    agents = nextAgents
    if (graph.nodes !== nodes || graph.edges !== edges) graph = { nodes, edges }
    return graph
  }
}
