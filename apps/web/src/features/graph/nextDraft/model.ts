import { WorkflowRelationshipSchema, executableNodeContent, preserveNodeGeometry, preserveWorkflowGeometry, sameAuthoredWorkflow, sameWorkflowValue } from '@foreman-code/contracts/wave25'
import type { z } from 'zod'
import { addAgentOperations, configureAgentOperations, type DraftAgentEdits } from './agentEdits'
import type { JobDefinitionRecord } from '@foreman-code/contracts/job-verification'
import type { Agent, WorkflowApprovalConfiguration } from '@foreman-code/contracts'
import type { ManagedAgentSchema } from '@foreman-code/contracts/management'
import type { GraphDraftOperationV3, GraphDraftV3, WorkflowDefinitionV3, WorkflowRelationship } from '@foreman-code/contracts/wave25'

export type CatalogAgent = z.infer<typeof ManagedAgentSchema>
/** savedDraft retains the authoritative base while draft acknowledges local batches. */
export type NextDraftContext = { draft: GraphDraftV3; savedDraft?: GraphDraftV3; agents: CatalogAgent[] }
export type DraftNode = WorkflowDefinitionV3['nodes'][number]
export type AuthoringIssue = { code: string; message: string; nodeId?: string; relationshipId?: string }
export type RoleEvidence = {
  role?: 'master' | 'orchestrator' | 'coder'
  configurationVersionId?: string
  source: 'configuration' | 'staged' | 'local' | 'unavailable'
}

/** Kept as an authoring compatibility export; classification is shared. */
export const sameValue = sameWorkflowValue

export function draftAgents(context: NextDraftContext): Agent[] {
  // Board drafts are local; every Agent is a saved catalog Agent.
  return [...new Map(context.agents.map(({ agent }) => [agent.id, agent])).values()]
}

/** Existing Agents require server evidence. Explicit new-Agent roles are only
 * local authoring evidence, never a saved configuration pin or execution grant. */
export function roleEvidence(context: NextDraftContext, agentId: string, agentEdits: DraftAgentEdits = {}): RoleEvidence {
  const agent = context.agents.find((item) => item.agent.id === agentId)?.agent
  const expected = context.draft.sourceAgentPins?.find((pin) => pin.agentId === agentId)
  const local = agentEdits[agentId]
  if (!agent && !expected && !context.draft.graph.nodes.some((node) => node.kind!=='job' && node.agentId === agentId)
    && local?.id === agentId && !local.configurationVersionId
    && (local.productRole === 'coder' || local.productRole === 'orchestrator' || local.productRole === 'master')) {
    return { role: local.productRole, source: 'local' }
  }
  if (!agent || !agent.configurationVersionId
    || (expected && expected.configurationVersionId !== agent.configurationVersionId)) return { source: 'unavailable' }
  const role = agent.productRole
  if (role !== 'master' && role !== 'orchestrator' && role !== 'coder') return { source: 'unavailable' }
  return { role, source: 'configuration', configurationVersionId: agent.configurationVersionId }
}

export function entryChoices(graph: WorkflowDefinitionV3, context: NextDraftContext, agentEdits: DraftAgentEdits = {}) {
  const roles = new Map(graph.nodes.filter(node=>node.kind!=='job').map((node) => [node.id, roleEvidence(context, node.agentId, agentEdits)]))
  const unresolved = graph.nodes.filter((node) => node.kind!=='job' && !roles.get(node.id)?.role)
  const masters = graph.nodes.filter((node) => roles.get(node.id)?.role === 'master')
  const orchestrators = graph.nodes.filter((node) => roles.get(node.id)?.role === 'orchestrator')
  // An unresolved node might be an Orchestrator. Do not enable a permissive Worker fallback.
  const eligible = unresolved.length || masters.length > 1 ? [] : masters.length ? masters : orchestrators.length ? orchestrators : graph.nodes.filter((node) => node.kind==='job' || roles.get(node.id)?.role === 'coder')
  return { roles, unresolved, eligible,
    valid: graph.entryNodeId !== null && eligible.some((node) => node.id === graph.entryNodeId),
    mode: graph.nodes.length === 1 ? 'sole' : masters.length ? 'master' : orchestrators.length ? 'orchestrator' : 'worker',
  }
}

export function nodeTitle(graph: WorkflowDefinitionV3, id: string): string {
  const node = graph.nodes.find((item) => item.id === id)
  return node?.name ?? node?.label ?? `Missing node (${id})`
}

/** Hints explain frozen acceptance rules. Only the shared service can accept a version. */
export function authoringHints(graph: WorkflowDefinitionV3, context: NextDraftContext, agentEdits: DraftAgentEdits = {}): AuthoringIssue[] {
  const issues: AuthoringIssue[] = []
  if (!graph.executionPolicy) issues.push({ code: 'EXECUTION_LIMITS_REQUIRED', message: 'Set execution limits in workflow settings.' })
  else if (graph.executionPolicy.maxNodeExecutions < graph.nodes.length) issues.push({ code: 'EXECUTION_LIMIT_TOO_LOW',
    message: `Increase “Maximum node executions” to at least ${graph.nodes.length}.` })
  const entry = entryChoices(graph, context, agentEdits)
  if (!graph.nodes.length) issues.push({ code: 'ENTRY_REQUIRED', message: 'Add an agent to start building this workflow.' })
  else if (entry.unresolved.length) issues.push({ code: 'ROLE_PIN_UNAVAILABLE', message: 'An agent’s role changed or can’t be confirmed. Reload the saved draft.' })
  else if (!entry.valid) issues.push({ code: 'ENTRY_REQUIRED', message: entry.mode === 'sole'
    ? 'Mark the only agent as the one that starts the workflow.'
    : entry.mode === 'master' ? 'Choose the master that starts the workflow.'
    : entry.mode === 'orchestrator' ? 'Choose the orchestrator that starts the workflow.'
      : 'Choose the worker that starts the workflow.' })
  for (const edge of graph.edges) {
    if (edge.kind === 'execution' && edge.target === graph.entryNodeId) issues.push({
      code: 'ENTRY_HAS_DEPENDENCY', relationshipId: edge.id, message: 'The starting agent can’t receive a handoff. Remove or redirect that connection.',
    })
  }
  for (const node of graph.nodes) {
    if (!node.choice) continue
    if (!node.choice.outcomes.length) issues.push({ code: 'CHOICE_INCOMPLETE', nodeId: node.id, message: 'Add at least one outcome and send it to a handoff or end the branch.' })
    const declared = new Set<string>()
    const targets = new Set<string>()
    for (const item of node.choice.outcomes) {
      if (!/^[a-z][a-z0-9_]{0,47}$/.test(item.outcome) || declared.has(item.outcome)) issues.push({ code: 'OUTCOME_INVALID', nodeId: node.id, message: 'Outcome names must be unique, start with a lowercase letter and use only lowercase letters, digits or underscores (up to 48).' })
      declared.add(item.outcome)
      if (item.target.kind === 'edge') {
        targets.add(item.target.relationshipId)
        if (!graph.edges.some((edge) => item.target.kind === 'edge' && edge.id === item.target.relationshipId && edge.kind === 'execution' && edge.source === node.id)) issues.push({
          code: 'CHOICE_TARGET_REQUIRED', nodeId: node.id, relationshipId: item.target.relationshipId,
          message: 'Send each outcome to one of this agent’s handoffs, or end the branch.',
        })
      }
    }
    if (node.choice.outcomes.length > 16) issues.push({ code: 'CHOICE_TOO_LARGE', nodeId: node.id, message: 'An agent can have at most 16 outcomes.' })
    for (const edge of graph.edges) if (edge.kind === 'execution' && edge.source === node.id && !targets.has(edge.id)) issues.push({
      code: 'UNDECLARED_CHOICE_EDGE', nodeId: node.id, relationshipId: edge.id, message: 'Every handoff from an agent that chooses by outcome needs an outcome.',
    })
  }
  const approvals = graph.edges.filter((edge) => edge.kind === 'approval')
  if (!graph.approval) issues.push({ code: 'APPROVAL_MODE_REQUIRED', message: 'Choose who handles approvals in workflow settings.' })
  if (graph.approval?.handler !== 'orchestrator' && approvals.length) issues.push({ code: 'APPROVAL_MODE_CONFLICT', message: 'Approval connections only work when an agent reviews approvals. Remove them or change who handles approvals.' })
  if (graph.approval?.handler === 'orchestrator') {
    const reviewer = graph.nodes.find((node) => node.id===graph.entryNodeId && node.kind!=='job' && node.agentId === graph.approval?.designatedOrchestratorAgentId)
    if (!reviewer || reviewer.id !== graph.entryNodeId || !['master', 'orchestrator'].includes(entry.roles.get(reviewer.id)?.role ?? '')) issues.push({
      code: 'REVIEWER_BOOTSTRAP_UNSUPPORTED', message: 'The reviewer must be the orchestrator that starts the workflow.',
    })
    if (reviewer && reviewer.kind !== 'job') {
      const configuration = (agentEdits[reviewer.agentId] ?? context.agents.find((item) => item.agent.id === reviewer.agentId)?.agent)?.harnessConfiguration
      if (configuration?.harness === 'codex' && (configuration.advanced?.approvalPolicy !== 'on-request'
        || configuration.advanced?.approvalsReviewer !== 'auto_review')) issues.push({
        code: 'APPROVAL_CODEX_REVIEW_CONFIGURATION_REQUIRED', nodeId: reviewer.id,
        message: 'Choose “You, the Operator” for approvals, or set the reviewing agent to “Ask when needed” and “Codex automatic review”.',
      })
    }
    if (approvals.some((edge) => edge.source !== graph.entryNodeId || edge.target === graph.entryNodeId)) issues.push({
      code: 'REVIEWER_BOOTSTRAP_UNSUPPORTED', message: 'Approval connections must go from the starting orchestrator to another agent.',
    })
  }
  return issues
}

export function removeRelationship(graph: WorkflowDefinitionV3, relationshipId: string): WorkflowDefinitionV3 {
  const edges = graph.edges.filter((edge) => edge.id !== relationshipId)
  // Deliberately retain now-incomplete choice references. Do not invent a branch end.
  return edges.length === graph.edges.length ? graph : { ...graph, edges }
}

export function removeNode(graph: WorkflowDefinitionV3, nodeId: string): WorkflowDefinitionV3 {
  if (!graph.nodes.some((node) => node.id === nodeId)) return graph
  return { ...graph, nodes: graph.nodes.filter((node) => node.id !== nodeId),
    edges: graph.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
    entryNodeId: graph.entryNodeId === nodeId ? null : graph.entryNodeId }
}

export function putRelationship(graph: WorkflowDefinitionV3, relationship: WorkflowRelationship): WorkflowDefinitionV3 {
  const previous = graph.edges.find((edge) => edge.id === relationship.id)
  if (previous && previous.kind !== relationship.kind) throw new Error('A relationship identity cannot change meaning. Remove that record and create a new one.')
  if (relationship.source === relationship.target || ![relationship.source, relationship.target].every((id) => graph.nodes.some((node) => node.id === id))) throw new Error('Choose distinct existing endpoints.')
  if (relationship.kind === 'approval' && graph.edges.some((edge) => edge.kind === 'approval' && edge.target === relationship.target && edge.id !== relationship.id)) throw new Error('A requester can have only one App reviewer. Edit its existing approval record.')
  if (previous && sameValue(previous, relationship)) return graph
  return { ...graph, edges: previous ? graph.edges.map((edge) => edge.id === relationship.id ? relationship : edge) : [...graph.edges, relationship] }
}

export function setWorkConnectionLimit(graph: WorkflowDefinitionV3, relationshipId: string, limit?: number): WorkflowDefinitionV3 {
  const edge = graph.edges.find((item) => item.id === relationshipId)
  if (!graph.handoffs || !edge || edge.kind !== 'execution') throw new Error('Choose a work connection in a handoff workflow.')
  const next = { ...edge }
  if (limit === undefined) delete next.maxWorkHandoffsPerRun
  else next.maxWorkHandoffsPerRun = limit
  return putRelationship(graph, WorkflowRelationshipSchema.parse(next))
}

export function changeApprovalHandler(graph: WorkflowDefinitionV3, handler: WorkflowApprovalConfiguration['handler']): WorkflowDefinitionV3 {
  if (handler !== 'orchestrator' && graph.edges.some((edge) => edge.kind === 'approval')) throw new Error('Remove approval assignments individually before switching handler. Execution routes will be preserved.')
  return { ...graph, approval: handler === 'orchestrator' && graph.approval?.handler === handler ? graph.approval : { handler } }
}

export function attachAgent(graph: WorkflowDefinitionV3, record: CatalogAgent, nodeId: string): WorkflowDefinitionV3 {
  if (record.archivedAt || !record.agent.configurationVersionId || !['master', 'coder', 'orchestrator'].includes(record.agent.productRole ?? '')) throw new Error('A board Agent with an available product-role configuration pin is required.')
  if (graph.nodes.some((node) => node.id === nodeId)) throw new Error('A node identity can occur only once in this workflow definition.')
  // No position: the Board places a new node in the hierarchy until the person drags it.
  const node: DraftNode = { id: nodeId, agentId: record.agent.id, name: record.agent.name }
  return { ...graph, nodes: [...graph.nodes, node], entryNodeId: graph.nodes.length === 0 ? nodeId : graph.entryNodeId }
}

/** IDs/kinds/directions survive visual pair inspection; this does not coalesce records. */
export function relationshipPairs(graph: WorkflowDefinitionV3): WorkflowRelationship[][] {
  const pairs = new Map<string, WorkflowRelationship[]>()
  for (const edge of graph.edges) {
    const key = JSON.stringify([edge.source, edge.target].sort())
    const pair = pairs.get(key) ?? []
    pair.push(edge); pairs.set(key, pair)
  }
  return [...pairs.values()]
}

/** Generate only the current V3 operations, retaining exact revision/source pins. */
export function draftOperations(context: NextDraftContext, graph: WorkflowDefinitionV3, agentEdits: DraftAgentEdits = {}): GraphDraftOperationV3[] {
  const base = context.draft.graph
  if (base.id !== graph.id || base.workspaceId !== graph.workspaceId) throw new Error('Draft scope changed; reload this workspace.')
  const operations: GraphDraftOperationV3[] = []
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  const oldNodes = new Map(base.nodes.map((node) => [node.id, node]))
  const edges = new Map(graph.edges.map((edge) => [edge.id, edge]))
  for (const edge of base.edges) if (!edges.has(edge.id)) operations.push({ type: 'edge.disconnect', edgeId: edge.id })
  for (const node of base.nodes) if (!nodes.has(node.id)) operations.push({ type: 'node.remove', nodeId: node.id })
  for (const node of graph.nodes) {
    const old = oldNodes.get(node.id)
    if(old && ((old.kind==='job')!==(node.kind==='job') || (old.kind==='job' && node.kind==='job' ? old.jobDefinitionId!==node.jobDefinitionId : old.kind!=='job' && node.kind!=='job' && old.agentId!==node.agentId)))throw new Error('Node identity cannot be rebound to another executable identity.')
    if(node.kind==='job') {
      if(!old || !sameValue(executableNodeContent(old),executableNodeContent(node)))operations.push({type:'node.replace_v3',node})
      continue
    }
    if (!old) {
      const source = context.agents.find((item) => item.agent.id === node.agentId)
      const local = agentEdits[node.agentId]
      if (!source && local) operations.push(...addAgentOperations(local, node))
      else {
        if (!source?.agent.configurationVersionId || source.archivedAt) throw new Error('The selected Agent source pin is unavailable. Reload before attaching it.')
        operations.push({ type: 'agent.attach', agentId: node.agentId, nodeId: node.id,
          expectedAgentRevision: source.metadataRevision, expectedConfigurationVersionId: source.agent.configurationVersionId,
          name: node.name ?? node.label, ...(node.position ? { position: node.position } : {}) })
      }
      operations.push({ type: 'node.replace_v3', node })
    } else if (!sameValue(executableNodeContent(old), executableNodeContent(node))) {
      const { choice: oldChoice, ...oldMetadata } = executableNodeContent(old)
      const { choice, ...metadata } = executableNodeContent(node)
      if (sameValue(oldMetadata, metadata)) operations.push({ type: 'node.set_choice', nodeId: node.id, choice: choice ?? null })
      else operations.push({ type: 'node.replace_v3', node: preserveNodeGeometry(node, old) })
      // Keep the destructured prior choice explicit: it is not copied into a new result.
      void oldChoice
    }
  }
  operations.push(...configureAgentOperations(context, graph, agentEdits))
  if (!sameValue(base.nodes.map((node) => node.id), graph.nodes.map((node) => node.id))) operations.push({ type: 'nodes.reorder', nodeIds: graph.nodes.map((node) => node.id) })
  if (!sameValue(base.approval, graph.approval)) {
    if (!graph.approval) throw new Error('Choose an explicit approval handler; clearing authority is unsupported.')
    if (graph.approval.handler !== 'orchestrator' && graph.edges.some((edge) => edge.kind === 'approval')) throw new Error('Remove approval records before changing handler.')
    operations.push({ type: 'workflow.set_approval', approval: graph.approval })
  }
  const oldEdges = new Map(base.edges.map((edge) => [edge.id, edge]))
  for (const edge of graph.edges) {
    const old = oldEdges.get(edge.id)
    if (old && old.kind !== edge.kind) throw new Error('A relationship ID cannot be reused for another meaning.')
    if (!sameValue(old, edge)) operations.push({ type: 'relationship.put', relationship: edge })
  }
  if (!sameValue(base.edges, graph.edges)) operations.push({ type: 'edges.reorder', edgeIds: graph.edges.map((edge) => edge.id) })
  if (base.entryNodeId !== graph.entryNodeId) operations.push({ type: 'workflow.set_entry', entryNodeId: graph.entryNodeId })
  if (!sameValue(base.executionPolicy, graph.executionPolicy)) operations.push(graph.executionPolicy
    ? { type: 'workflow.set_execution_limits', ...graph.executionPolicy } : { type: 'workflow.reset_execution_limits' })
  if (base.requiredAgentCount !== graph.requiredAgentCount) operations.push(graph.requiredAgentCount !== undefined
    ? { type: 'workflow.set_required_agent_count', requiredAgentCount: graph.requiredAgentCount } : { type: 'workflow.reset_required_agent_count' })
  if (!sameValue(base.executionCondition, graph.executionCondition)) operations.push({ type: 'workflow.set_execution_condition', executionCondition: graph.executionCondition })
  if (!sameValue(base.repeat, graph.repeat)) operations.push({ type: 'workflow.set_repeat', repeat: graph.repeat ?? null })
  if (!sameValue(base.defaultWorktree, graph.defaultWorktree)) {
    operations.push({ type: 'workflow.set_worktree', worktree: graph.defaultWorktree ?? null })
  }
  return operations
}

function mergeFields<T extends object>(current: T, sent: T, saved: T): T {
  if (sameValue(current, sent)) return sameValue(current, saved) ? current : saved
  const next = { ...current } as Record<string, unknown>
  const a = current as Record<string, unknown>, b = sent as Record<string, unknown>, c = saved as Record<string, unknown>
  for (const key of new Set([...Object.keys(b), ...Object.keys(c)])) {
    if (!sameValue(a[key], b[key])) continue
    if (Object.hasOwn(c, key)) next[key] = c[key]
    else delete next[key]
  }
  return sameValue(current, next) ? current : next as T
}

/** An acknowledged own command can normalize its submission, never erase newer typing. */
export function mergeAcknowledgement(current: WorkflowDefinitionV3, sent: WorkflowDefinitionV3, saved: WorkflowDefinitionV3): WorkflowDefinitionV3 {
  if (sameValue(current, sent)) {
    const accepted = preserveWorkflowGeometry(saved, current)
    return sameValue(current, accepted) ? current : accepted
  }
  const mergeEntities = <T extends { id: string }>(items: T[], before: T[], after: T[], meaning: (item: T) => unknown): T[] => {
    const b = new Map(before.map((item) => [item.id, item])), a = new Map(after.map((item) => [item.id, item]))
    const now = new Map(items.map((item) => [item.id, item])), merged = new Map<string, T>()
    for (const item of items) {
      const previous = b.get(item.id), accepted = a.get(item.id)
      // A discarded addition disappears only if its meaning was not edited
      // again. Geometry alone must not keep an otherwise discarded node alive.
      if (previous && !accepted && sameValue(meaning(item), meaning(previous))) continue
      merged.set(item.id, previous && accepted ? mergeFields(item, previous, accepted) : item)
    }
    for (const item of after) {
      // Restore staged removals, but never resurrect a deletion made AFTER
      // the submitted snapshot (present in before, absent in current).
      if (!now.has(item.id) && !b.has(item.id)) merged.set(item.id, item)
    }
    const ids = (values: T[]) => values.map((item) => item.id)
    const order = ids(sameValue(ids(items), ids(before)) ? after : items).filter((id) => merged.has(id))
    // Install restored entities in saved order without reordering newer work.
    const savedOrder = ids(after)
    for (const [index, id] of savedOrder.entries()) {
      if (!merged.has(id) || order.includes(id)) continue
      const next = savedOrder.slice(index + 1).find((candidate) => order.includes(candidate))
      order.splice(next === undefined ? order.length : order.indexOf(next), 0, id)
    }
    for (const id of merged.keys()) if (!order.includes(id)) order.push(id)
    const result = order.map((id) => merged.get(id)!)
    return result.length === items.length && result.every((item, index) => item === items[index]) ? items : result
  }
  const nodes = mergeEntities(current.nodes, sent.nodes, saved.nodes, executableNodeContent)
  const nodeIds = new Set(nodes.map((node) => node.id))
  const currentEdges = new Set(current.edges.map((edge) => edge.id))
  const edges = mergeEntities(current.edges, sent.edges, saved.edges, (edge) => edge).filter((edge) =>
    // A restored edge cannot undo a newer endpoint deletion. Already local
    // records remain visible for explicit correction, rather than being hidden.
    currentEdges.has(edge.id) || (nodeIds.has(edge.source) && nodeIds.has(edge.target)))
  const fields = mergeFields(current, sent, saved)
  // Restoring an old entry must not point at a node deleted only after Stage.
  // Keep an already-local unresolved selection visible for explicit correction.
  const entryNodeId = fields.entryNodeId && !nodeIds.has(fields.entryNodeId) && fields.entryNodeId !== current.entryNodeId
    ? current.entryNodeId : fields.entryNodeId
  return preserveWorkflowGeometry({ ...fields, entryNodeId, nodes, edges }, current)
}

export function hasLocalChanges(context: NextDraftContext, graph: WorkflowDefinitionV3): boolean {
  return !sameAuthoredWorkflow(context.draft.graph, graph)
}

/** Discard affects staged meaning only. It never dispatches a Run command. */
export function discardMeaningfulChanges(context: NextDraftContext, graph: WorkflowDefinitionV3): WorkflowDefinitionV3 {
  return preserveWorkflowGeometry((context.savedDraft ?? context.draft).graph, graph)
}

export function attachJob(graph:WorkflowDefinitionV3,definition:JobDefinitionRecord,nodeId:string):WorkflowDefinitionV3 {
  if(definition.workspaceId!==graph.workspaceId||graph.nodes.some(node=>node.id===nodeId))throw new Error('Choose a saved job in this workspace and a new node identity.')
  if(graph.handoffs)throw new Error('Job nodes require a DAG or finite repeat workflow.')
  const node:DraftNode={kind:'job',id:nodeId,jobDefinitionId:definition.id,jobDefinitionRevision:definition.revision,jobDefinitionVersionId:definition.versionId,name:definition.name}
  return {...graph,nodes:[...graph.nodes,node],entryNodeId:graph.nodes.length===0?nodeId:graph.entryNodeId}
}
