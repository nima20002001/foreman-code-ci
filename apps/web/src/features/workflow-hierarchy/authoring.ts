import type { Agent } from '@foreman-code/contracts'
import type { WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { changeDraftAgents, editorAgents } from '../graph/nextDraft/agentEdits'
import { nodeTitle, removeNode, roleEvidence } from '../graph/nextDraft/model'
import type { NextDraftEdit } from '../graph/nextDraft/state'

export function hierarchyNodes(edit: NextDraftEdit, masterNodeId = edit.graph.hierarchy?.masterNodeId) {
  return edit.graph.nodes.filter(node => node.kind !== 'job').map(node => ({ node,
    role: node.id === masterNodeId ? 'master' as const
      : masterNodeId && roleEvidence(edit.context, node.agentId, edit.agentEdits).role === 'master' ? 'orchestrator' as const
        : roleEvidence(edit.context, node.agentId, edit.agentEdits).role,
  }))
}

function assertHierarchySupported(graph: WorkflowDefinitionV3) {
  if (graph.repeat) throw new Error('Remove the repeat configuration before adding a Master hierarchy.')
  if (graph.nodes.some(node => node.kind === 'job')) throw new Error('A Master hierarchy supports Agent nodes. Remove job nodes before applying it.')
  if (graph.nodes.some(node => node.join !== undefined || node.kind !== 'job' && node.interval !== undefined)) {
    throw new Error('Remove join and interval settings from Agent nodes before applying a Master hierarchy.')
  }
}

/** Explicit hierarchy authoring adds missing parent routes and keeps every old connection. */
function withHierarchyRoutes(graph: WorkflowDefinitionV3): WorkflowDefinitionV3 {
  if (!graph.hierarchy) return graph
  const edges = [...graph.edges], nodes = [...graph.nodes]
  for (const member of graph.hierarchy.parents) {
    const index = nodes.findIndex(node => node.id === member.parentNodeId)
    const parent = nodes[index]
    if (!parent || parent.kind === 'job') throw new Error('Choose a saved Agent as the reporting parent.')
    const outcomes = parent.choice?.outcomes ?? []
    const routed = outcomes.some(outcome => {
      if (outcome.target.kind !== 'edge') return false
      const relationshipId = outcome.target.relationshipId
      return edges.some(edge => edge.id === relationshipId && edge.kind === 'execution'
        && edge.source === member.parentNodeId && edge.target === member.workflowNodeId)
    })
    if (routed) continue
    let edge = edges.find(item => item.kind === 'execution'
      && item.source === member.parentNodeId && item.target === member.workflowNodeId)
    if (!edge) {
      const reverse = edges.findIndex(item => item.kind === 'execution' && item.workRequestDirection === 'both'
        && item.source === member.workflowNodeId && item.target === member.parentNodeId)
      if (reverse >= 0) {
        edge = { ...edges[reverse]!, source: member.parentNodeId, target: member.workflowNodeId }
        edges[reverse] = edge // Same two permitted work directions, ID, named references and cap.
      }
    }
    if (!edge) {
      edge = { id: `hierarchy-${crypto.randomUUID()}`, kind: 'execution',
        source: member.parentNodeId, target: member.workflowNodeId }
      edges.push(edge)
    }
    const prefix = `delegate_${member.workflowNodeId.toLowerCase().replaceAll(/[^a-z0-9_]/g, '_')}`.slice(0, 40)
    let outcome = prefix, suffix = 1
    while (outcomes.some(item => item.outcome === outcome)) outcome = `${prefix}_${suffix++}`
    nodes[index] = { ...parent, choice: { outcomes: [...outcomes, {
      outcome, target: { kind: 'edge', relationshipId: edge.id },
    }] } }
  }
  // A newly introduced named dictionary must still describe retained ordinary
  // outgoing connections. Naming them neither dispatches nor turns them into children.
  for (const [index, node] of nodes.entries()) {
    if (!node.choice) continue
    const outcomes = [...node.choice.outcomes]
    for (const edge of edges.filter(item => item.kind === 'execution' && item.source === node.id)) {
      if (outcomes.some(item => item.target.kind === 'edge' && item.target.relationshipId === edge.id)) continue
      let suffix = 1, outcome = `handoff_${suffix}`
      while (outcomes.some(item => item.outcome === outcome)) outcome = `handoff_${++suffix}`
      outcomes.push({ outcome, target: { kind: 'edge', relationshipId: edge.id } })
    }
    if (outcomes.length !== node.choice.outcomes.length) nodes[index] = { ...node, choice: { outcomes } }
  }
  return { ...graph, nodes, edges }
}

/** Reparenting is an explicit draft edit; the former handoff remains an ordinary connection. */
export function reparentHierarchyWorker(graph: WorkflowDefinitionV3, nodeId: string, parentNodeId: string): WorkflowDefinitionV3 {
  if (!graph.hierarchy) return graph
  return withHierarchyRoutes({ ...graph, hierarchy: { ...graph.hierarchy,
    parents: [...graph.hierarchy.parents.filter(member => member.workflowNodeId !== nodeId),
      ...(parentNodeId ? [{ workflowNodeId: nodeId, parentNodeId }] : [])],
  } })
}

/** Explicitly adopt or replace the Master; all reused Agent role edits use the normal Save journal. */
export function applyMasterHierarchy(edit: NextDraftEdit, masterNodeId: string, workerParents: Readonly<Record<string, string>>,
  previousMaster: 'keep' | 'remove' = 'keep'): NextDraftEdit {
  assertHierarchySupported(edit.graph)
  const previousMasterId = edit.graph.hierarchy?.masterNodeId
  const removePrevious = previousMaster === 'remove' && previousMasterId && previousMasterId !== masterNodeId
  const source = removePrevious ? withoutNode(edit.graph, previousMasterId) : edit.graph
  const nodes = hierarchyNodes({ ...edit, graph: source }, masterNodeId)
  const master = nodes.find(item => item.node.id === masterNodeId)
  if (!master) throw new Error('Choose an Agent node for Master.')
  const existingRole = roleEvidence(edit.context, master.node.agentId, edit.agentEdits).role
  if (existingRole !== 'orchestrator' && existingRole !== 'master') throw new Error('Choose an Orchestrator or create a new Master.')
  const identities = new Map(editorAgents(edit).map(agent => [agent.id, agent]))
  const changes: Agent[] = []
  for (const { node, role } of nodes) {
    const agent = identities.get(node.agentId)
    if (!role || !agent || !roleEvidence(edit.context, node.agentId, edit.agentEdits).role) {
      throw new Error(`Reload the complete saved role for ${nodeTitle(edit.graph, node.id)}.`)
    }
    if (agent.productRole === role) continue
    if (nodes.filter(item => item.node.agentId === node.agentId).length !== 1) {
      throw new Error(`${agent.name} is used by several nodes. Add a distinct Agent before changing one node’s role.`)
    }
    if (edit.agentForms?.[node.id]) throw new Error(`Apply the open settings for ${agent.name} to the draft before changing its role.`)
    changes.push({ ...agent, productRole: role })
  }
  const orchestrators = new Set(nodes.filter(item => item.role === 'orchestrator').map(item => item.node.id))
  const parents = nodes.filter(item => item.node.id !== masterNodeId).map(({ node, role }) => {
    const parentNodeId = role === 'orchestrator' ? masterNodeId : workerParents[node.id]
    if (!parentNodeId || role === 'coder' && !orchestrators.has(parentNodeId)) {
      throw new Error(`Choose an Orchestrator for ${nodeTitle(edit.graph, node.id)} to report to.`)
    }
    return { workflowNodeId: node.id, parentNodeId }
  })
  return changeDraftAgents(edit, changes, withHierarchyRoutes({ ...source, entryNodeId: masterNodeId,
    handoffs: edit.graph.handoffs ?? { contractVersion: 1 }, hierarchy: { version: 1, masterNodeId, parents } }))
}

function withoutNode(graph: WorkflowDefinitionV3, nodeId: string): WorkflowDefinitionV3 {
  const next = { ...graph, nodes: graph.nodes.filter(node => node.id !== nodeId),
    edges: graph.edges.filter(edge => edge.source !== nodeId && edge.target !== nodeId),
    entryNodeId: graph.entryNodeId === nodeId ? null : graph.entryNodeId }
  if (graph.hierarchy?.masterNodeId === nodeId) delete next.hierarchy
  else if (graph.hierarchy) next.hierarchy = { ...graph.hierarchy,
    parents: graph.hierarchy.parents.filter(member => member.workflowNodeId !== nodeId && member.parentNodeId !== nodeId) }
  // Named references survive as precise authoring issues, just like Remove connection.
  return next
}

/** Explicit removal preserves every Worker and makes its route changes one Undo step. */
export function removeHierarchyNode(edit: NextDraftEdit, nodeId: string, destinationParentId?: string): NextDraftEdit {
  const node = edit.graph.nodes.find(item => item.id === nodeId)
  if (!node) throw new Error('This node is no longer in the draft.')
  const children = edit.graph.hierarchy?.parents.filter(member => member.parentNodeId === nodeId) ?? []
  let graph = edit.graph
  if (graph.hierarchy?.masterNodeId !== nodeId && children.length) {
    if (!hierarchyNodes(edit).some(item => item.role === 'orchestrator' && item.node.id !== nodeId
      && item.node.id === destinationParentId)) throw new Error('Choose another Orchestrator for every Worker before removing this team.')
    graph = withHierarchyRoutes({ ...graph, hierarchy: { ...graph.hierarchy!, parents: graph.hierarchy!.parents.map(member =>
      member.parentNodeId === nodeId ? { ...member, parentNodeId: destinationParentId! } : member) } })
  }
  graph = graph.hierarchy?.masterNodeId === nodeId ? withoutNode(graph, nodeId) : removeNode(graph, nodeId)
  const agentForms = { ...edit.agentForms }; delete agentForms[nodeId]
  const workflowForms = { ...edit.workflowForms }; delete workflowForms.removeNode
  const workerParents = { ...workflowForms.workerParents }; delete workerParents[nodeId]
  if (Object.keys(workerParents).length) workflowForms.workerParents = workerParents
  else delete workflowForms.workerParents
  return changeDraftAgents({ ...edit, agentForms, workflowForms }, [], graph)
}

/** The former Master becomes an Orchestrator in a new configuration on explicit removal. */
export function removeMasterHierarchy(edit: NextDraftEdit): NextDraftEdit {
  if (!edit.graph.hierarchy) return edit
  const master = edit.graph.nodes.find(node => node.id === edit.graph.hierarchy!.masterNodeId)
  const agent = master?.kind !== 'job' && master ? editorAgents(edit).find(item => item.id === master.agentId) : undefined
  if (!agent || !master) throw new Error('Reload the Master configuration before removing the hierarchy.')
  if (edit.agentForms?.[master.id]) throw new Error('Apply the Master’s open settings to the draft before removing its role.')
  if (edit.graph.nodes.filter(node => node.kind !== 'job' && node.agentId === agent.id).length !== 1) {
    throw new Error('The Master Agent is used by several nodes. Resolve those references before changing its role.')
  }
  const graph = { ...edit.graph }
  delete graph.hierarchy
  return changeDraftAgents(edit, [{ ...agent, productRole: 'orchestrator' }], graph)
}

/** New Agents are private staged configurations until the existing Save transaction publishes them. */
export function stageHierarchyAgent(edit: NextDraftEdit, agent: Agent, nodeId: string, parentNodeId?: string,
  fields: Pick<Exclude<WorkflowDefinitionV3['nodes'][number], { kind: 'job' }>, 'initialPrompt' | 'graphqlTools' | 'placement' | 'worktree'> = {}): NextDraftEdit {
  if (!agent.productRole || agent.configurationVersionId) {
    throw new Error('Create a new board Agent with an explicit role.')
  }
  if (edit.graph.nodes.some(node => node.id === nodeId) || editorAgents(edit).some(item => item.id === agent.id)) {
    throw new Error('This Agent already exists. Reopen the creation form.')
  }
  if (agent.productRole === 'master') {
    if (edit.graph.hierarchy || hierarchyNodes(edit).some(item => item.role === 'master')) {
      throw new Error('Use the Master selection in Workflow settings to replace the current Master.')
    }
    assertHierarchySupported(edit.graph)
  }
  const graph = { ...edit.graph, nodes: [...edit.graph.nodes, { ...fields, id: nodeId, agentId: agent.id, name: agent.name }],
    entryNodeId: edit.graph.nodes.length ? edit.graph.entryNodeId : nodeId }
  if (agent.productRole === 'master') {
    graph.entryNodeId = nodeId
    graph.handoffs ??= { contractVersion: 1 }
    graph.hierarchy = { version: 1, masterNodeId: nodeId, parents: hierarchyNodes(edit)
      .filter(item => item.role === 'orchestrator').map(item => ({ workflowNodeId: item.node.id, parentNodeId: nodeId })) }
  } else if (graph.hierarchy) {
    if (agent.productRole === 'coder' && !hierarchyNodes(edit).some(item => item.node.id === parentNodeId && item.role === 'orchestrator')) {
      throw new Error('Choose an Orchestrator for the new Worker to report to.')
    }
    graph.hierarchy = { ...graph.hierarchy, parents: [...graph.hierarchy.parents, {
      workflowNodeId: nodeId, parentNodeId: agent.productRole === 'orchestrator' ? graph.hierarchy.masterNodeId : parentNodeId!,
    }] }
  }
  return changeDraftAgents(edit, [agent], withHierarchyRoutes(graph))
}
