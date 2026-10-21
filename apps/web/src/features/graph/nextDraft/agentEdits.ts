import { SupportedHarnessConfigurationSchema } from '@foreman-code/contracts'
import type { Agent } from '@foreman-code/contracts'
import { StagedAgentSchema } from '@foreman-code/contracts/management'
import type { GraphDraftOperationV3, WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { draftAgents, sameValue, type DraftNode, type NextDraftContext } from './model'
import type { NextDraftEdit } from './state'

export type DraftAgentEdits = Record<string, Agent>
export function referencedAgentEdits(graph: WorkflowDefinitionV3, edits: DraftAgentEdits = {}): DraftAgentEdits {
  const ids = new Set(graph.nodes.filter(node=>node.kind!=='job').map((node) => node.agentId))
  return Object.fromEntries(Object.entries(edits).filter(([id]) => ids.has(id)))
}
export function hasAgentEdits(edit: NextDraftEdit): boolean {
  return Object.values(referencedAgentEdits(edit.graph, edit.agentEdits)).some((agent) =>
    !sameAgentContent(draftAgents(edit.context).find((item) => item.id === agent.id), agent))
}
export function editorAgents(edit: NextDraftEdit): Agent[] {
  return [...new Map([...draftAgents(edit.context), ...Object.values(edit.agentEdits ?? {})].map((agent) => [agent.id, agent])).values()]
}
function content(agent: Agent) {
  return { prompt: agent.prompt ?? {}, assignedSkills: agent.assignedSkills ?? [], description: agent.description ?? null, role: agent.role ?? null,
    ...(agent.productRole ? { productRole: agent.productRole } : {}),
    ...(agent.graphqlTools ? { graphqlTools: agent.graphqlTools } : {}),
    ...(agent.nativeTools ? { nativeTools: agent.nativeTools } : {}) }
}
/** Compare the fields the existing Agent writer persists, including its defaults. */
function sameAgentContent(before: Agent | undefined, after: Agent): boolean {
  const authored = (agent: Agent) => {
    const value = { ...agent, ...content(agent) }
    // Saved pins and runtime projections are not editable Agent settings.
    for (const key of ['configurationVersionId', 'createdAt', 'updatedAt', 'status', 'executionState', 'activeRunId', 'harnessSummary'] as const) delete value[key]
    // These display fields are derived from the complete harness configuration.
    if (agent.harnessConfiguration) for (const key of ['harness', 'model', 'effort', 'fastMode'] as const) delete value[key]
    return value
  }
  return !!before && sameValue(authored(before), authored(after))
}
function configuration(agent: Agent) {
  if (!agent.harnessConfiguration) throw new Error('Reload the complete Agent configuration before editing it.')
  return SupportedHarnessConfigurationSchema.parse(agent.harnessConfiguration)
}
export function addAgentOperations(agent: Agent, node: DraftNode): GraphDraftOperationV3[] {
  const harness = configuration(agent)
  if (!agent.productRole) throw new Error('Select an explicit Agent product role.')
  return [
    { type: 'agent.add', agentId: agent.id, nodeId: node.id, name: agent.name, productRole: agent.productRole,
      harness: harness.harness, configuration: harness },
    { type: 'agent.configure', agentId: agent.id, expectedAgentRevision: 0, configuration: harness, ...content(agent) },
  ]
}
export function configureAgentOperations(context: NextDraftContext, graph: WorkflowDefinitionV3, edits: DraftAgentEdits): GraphDraftOperationV3[] {
  const operations: GraphDraftOperationV3[] = []
  for (const [id, after] of Object.entries(referencedAgentEdits(graph, edits))) {
    const source = context.agents.find((item) => item.agent.id === id)
    const before = source?.agent
    if (!before) continue // Created explicitly by addAgentOperations in the same serial writer.
    const revision = source?.metadataRevision
    if (revision === undefined) throw new Error('The Agent revision is unavailable. Reload before editing its settings.')
    if (before.name !== after.name) operations.push({ type: 'agent.rename', agentId: id, expectedAgentRevision: revision, name: after.name })
    if (!sameValue({ configuration: before.harnessConfiguration, ...content(before) }, { configuration: after.harnessConfiguration, ...content(after) })) {
      operations.push({ type: 'agent.configure', agentId: id, expectedAgentRevision: revision, configuration: configuration(after), ...content(after) })
    }
  }
  return operations
}

/** Content-only edit. No server revision, configuration pin or pending receipt is invented. */
export function changeDraftAgent(edit: NextDraftEdit, agent: Agent, graph: WorkflowDefinitionV3): NextDraftEdit {
  return changeDraftAgents(edit, [agent], graph)
}

/** Role transitions and their reporting tree are one undoable draft action. */
export function changeDraftAgents(edit: NextDraftEdit, agents: Agent[], graph: WorkflowDefinitionV3): NextDraftEdit {
  if (edit.busy || edit.pending) throw new Error('Reconcile the pending draft command before editing Agent settings.')
  const displayed = new Map(editorAgents(edit).map(agent => [agent.id, agent]))
  if (agents.every(agent => sameAgentContent(displayed.get(agent.id), agent)) && sameValue(graph, edit.graph)) return edit
  const before = Object.fromEntries(agents.flatMap(agent => {
    const previous = displayed.get(agent.id)
    return previous ? [[agent.id, previous]] : []
  }))
  const history = (edit.agentHistory ?? edit.history.map(() => ({}))).map((snapshot: DraftAgentEdits) => ({ ...before, ...snapshot }))
  const previous = { ...snapshotAgentEdits(edit), ...before }
  const saved = new Map(draftAgents(edit.context).map(agent => [agent.id, agent]))
  const edits = { ...edit.agentEdits }
  for (const agent of agents) {
    if (sameAgentContent(saved.get(agent.id), agent)) delete edits[agent.id]
    else edits[agent.id] = agent
  }
  return { ...edit, graph, agentEdits: referencedAgentEdits(graph, edits), future: [],
    history: [...edit.history.slice(-49), edit.graph],
    historyOffset: (edit.historyOffset ?? 0) + Math.max(0, edit.history.length - 49),
    agentHistory: [...history.slice(-49), previous], validation: undefined }
}

/** Empty edit maps still capture previously edited Agents' authored base content. */
export function snapshotAgentEdits(edit: NextDraftEdit): DraftAgentEdits {
  const ids = new Set([Object.keys(edit.agentEdits ?? {}),
    ...(edit.agentHistory ?? []).map(snapshot => Object.keys(snapshot))].flat())
  return referencedAgentEdits(edit.graph, Object.fromEntries(editorAgents(edit)
    .filter(agent => ids.has(agent.id)).map(agent => [agent.id, agent])))
}

/** Historical authored settings become new edits against the acknowledged Agent base. */
export function rebaseAgentEdits(edits: DraftAgentEdits, context: NextDraftContext): DraftAgentEdits {
  const saved = new Map(draftAgents(context).map(agent => [agent.id, agent]))
  return Object.fromEntries(Object.entries(edits).flatMap(([id, agent]) => {
    const base = saved.get(id)
    if (sameAgentContent(base, agent)) return []
    const restored = base ? { ...agent, configurationVersionId: base.configurationVersionId,
      createdAt: base.createdAt, updatedAt: base.updatedAt } : agent
    return [[id, restored]]
  }))
}

/** Clear only the submitted Agent edits. Later edits survive normalization and publication. */
export function acknowledgeAgentEdits(current: DraftAgentEdits | undefined, sent: DraftAgentEdits | undefined, context: NextDraftContext, retainedGraph?: WorkflowDefinitionV3): DraftAgentEdits | undefined {
  if (!current) return undefined
  const saved = new Map(draftAgents(context).map((agent) => [agent.id, agent]))
  return Object.fromEntries(Object.entries(current).flatMap(([id, agent]) => {
    const submitted = sent?.[id]
    if (!submitted) return [[id, agent]]
    // Discard may retain a newly created node because its meaning was edited
    // again. Keep its local Agent until that dependent newer work is resolved.
    if (sameValue(agent, submitted) && (saved.has(id) || !retainedGraph?.nodes.some((node) => node.kind!=='job' && node.agentId === id))) return []
    const acknowledged = saved.get(id)
    return [[id, acknowledged ? { ...agent, configurationVersionId: acknowledged.configurationVersionId,
      createdAt: acknowledged.createdAt, updatedAt: acknowledged.updatedAt } : agent]]
  }))
}

/** Keep one Agent edit atomic while retaining its first operation's command identity. */
export function coalesceAgentEdits(operations: readonly GraphDraftOperationV3[]) {
  const edits = new Map<string, {
    index: number
    rename?: Extract<GraphDraftOperationV3, { type: 'agent.rename' }>
    configure?: Extract<GraphDraftOperationV3, { type: 'agent.configure' }>
  }>()
  operations.forEach((operation, index) => {
    if (operation.type !== 'agent.rename' && operation.type !== 'agent.configure') return
    const edit = edits.get(operation.agentId) ?? { index }
    const previous = edit.rename ?? edit.configure
    if (previous && previous.expectedAgentRevision !== operation.expectedAgentRevision) {
      throw new Error('Agent edits must share the same original revision.')
    }
    if (operation.type === 'agent.rename') edit.rename = operation
    else edit.configure = operation
    edits.set(operation.agentId, edit)
  })
  return edits
}

/** Pin each private Agent snapshot to the metadata revision displayed by this form. */
export function stageAgentEdits(edit: NextDraftEdit) {
  return Object.values(referencedAgentEdits(edit.graph, edit.agentEdits)).map((agent) => {
    const source = edit.context.agents.find((item) => item.agent.id === agent.id)
    if (source && source.agent.configurationVersionId !== agent.configurationVersionId) {
      throw new Error('The Agent form no longer matches its displayed configuration. Reload before staging.')
    }
    if (!source && agent.configurationVersionId) throw new Error('Reload the Agent revision before staging its settings.')
    return StagedAgentSchema.parse({ agent, baseRevision: source?.metadataRevision ?? null })
  })
}
