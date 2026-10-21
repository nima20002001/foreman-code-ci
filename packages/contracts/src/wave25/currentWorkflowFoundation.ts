import { z } from 'zod'
import { graphqlToolsOutsideRole } from '../graphqlMcpTools.js'
import {
  AgentConfigurationVersionSchema, AcceptedWorkflowApprovalConfigurationSchema,
  HarnessWorkflowCompatibilitySchema,
  WorkflowRunRecordSchema, ExecutionResultSchema, TimestampSchema,
} from '../index.js'
import { GraphIdSchema } from '../schemaPrimitives.js'
import { validateHierarchyConfiguration } from './hierarchyValidation.js'
import { canonicalGraphJson } from './json.js'
import { ExecutionSemanticsVersionSchema as CurrentExecutionSemanticsSchema } from './workflowShape.js'
export { ExecutionSemanticsVersionSchema as CurrentExecutionSemanticsSchema } from './workflowShape.js'

import { CurrentWorkflowDefinitionBaseSchema, WorkHandoffPolicyV1Schema, type RepeatPlanV1 } from './workflowShape.js'
export { CurrentAgentWorkflowNodeSchema, CurrentWorkflowNodeSchema, CurrentWorkflowRelationshipSchema, CurrentWorkflowDefinitionBaseSchema } from './workflowShape.js'

/** Extracted current topology/lifecycle rules. No old WorkflowVersion validator,
 * validation projection, complexity-selected semantics or legacy dispatch. */
export const CurrentRunScopeSchema = z.object({
  workspaceId: GraphIdSchema, workflowId: GraphIdSchema, runId: GraphIdSchema,
  workflowVersionId: GraphIdSchema, executionSemanticsVersion: CurrentExecutionSemanticsSchema,
}).strict()
export const CurrentWorkflowVersionBaseSchema = z.object({
  id: GraphIdSchema, workspaceId: GraphIdSchema, workflowId: GraphIdSchema,
  version: z.number().int().positive(), executionSemanticsVersion: CurrentExecutionSemanticsSchema,
  entryNodeId: GraphIdSchema, definition: CurrentWorkflowDefinitionBaseSchema.extend({ handoffs: WorkHandoffPolicyV1Schema.optional() }),
  agentConfigurationVersionIds: z.record(GraphIdSchema, GraphIdSchema),
  /** Server-resolved node additions retained with this immutable workflow version. */
  nodeSkillSnapshots: z.record(GraphIdSchema, AgentConfigurationVersionSchema.shape.resolvedSkills.unwrap()).optional(),
  approval: AcceptedWorkflowApprovalConfigurationSchema,
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/), createdAt: TimestampSchema,
}).strict()
type Version = z.infer<typeof CurrentWorkflowVersionBaseSchema>

/** Proven entry, DAG, named-routing and all-required join rules, applied to the
 * actual V3 value. There is no old-schema parse or tag replacement. */
export function validateCurrentWorkflowTopology(version: Version, context: z.RefinementCtx): void {
  const issue = (message: string, path: (string | number)[] = ['definition']) => context.addIssue({ code: 'custom', path, message })
  const graph = version.definition
  // Hierarchy handoffs activate only an admitted request. Their saved routes may
  // return to the entry or form review loops; the separate reporting tree stays acyclic.
  const hierarchyRequests = Boolean(graph.hierarchy && graph.handoffs)
  if(graph.handoffs&&graph.nodes.some(node=>node.kind==='job'))issue('JOB_HANDOFF_POLICY_UNSUPPORTED: noninteractive job nodes use DAG or explicit finite repeat dependencies.')
  if (graph.id !== version.workflowId || graph.workspaceId !== version.workspaceId || graph.version !== version.version) issue('immutable scope/version mismatch')
  if (graph.entryNodeId !== version.entryNodeId) issue('authored and immutable entry must match', ['entryNodeId'])
  if (!graph.executionPolicy) context.addIssue({ code: 'custom', path: ['definition', 'executionPolicy'],
    message: 'Set execution limits.', params: { issueCode: 'EXECUTION_LIMITS_REQUIRED' } })
  else if (graph.executionPolicy.maxNodeExecutions < graph.nodes.length) context.addIssue({
    code: 'custom', path: ['definition', 'executionPolicy', 'maxNodeExecutions'],
    message: `Increase “Maximum node executions” to at least ${graph.nodes.length}.`,
    params: { issueCode: 'EXECUTION_LIMIT_TOO_LOW', minimum: graph.nodes.length, actual: graph.executionPolicy.maxNodeExecutions },
  })
  if (graph.requiredAgentCount !== undefined && graph.requiredAgentCount !== new Set(graph.nodes.filter(node => node.kind !== 'job').map(node => node.agentId)).size) issue('requiredAgentCount does not match the topology')
  if (canonicalGraphJson(graph.approval ?? null) !== canonicalGraphJson(version.approval)) issue('definition and immutable approval assignment must match')
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  const edges = new Map(graph.edges.map((edge) => [edge.id, edge]))
  if (nodes.size !== graph.nodes.length || edges.size !== graph.edges.length) issue('node and relationship IDs must be unique')
  if (!nodes.has(version.entryNodeId)) issue('entry must reference an existing node', ['entryNodeId'])
  const execution = graph.edges.filter((edge) => edge.kind === 'execution')
  const outgoing = new Map<string, string[]>()
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]))
  const reviewers = new Set<string>()
  for (const edge of graph.edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target) || edge.source === edge.target) issue('relationships require distinct existing endpoints')
    if (edge.artifactInputs) {
      const source = nodes.get(edge.source), target = nodes.get(edge.target)
      if (edge.kind !== 'execution' || source?.kind === 'job' || target?.kind === 'job' || edge.workRequestDirection === 'both') {
        issue('ARTIFACT_INPUTS_REQUIRE_FORWARD_AGENT_EXECUTION_EDGE', ['definition', 'edges', graph.edges.indexOf(edge), 'artifactInputs'])
      }
      if (!source || source.kind === 'job' || !source.artifactOutputs
        || edge.artifactInputs.outputKeys.some(key => !source.artifactOutputs!.outputKeys.includes(key))) {
        issue('ARTIFACT_INPUT_KEY_UNDECLARED', ['definition', 'edges', graph.edges.indexOf(edge), 'artifactInputs'])
      }
    }
    if (edge.kind === 'execution') {
      if (!hierarchyRequests && edge.target === version.entryNodeId) issue('entry cannot have an incoming execution dependency')
      outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target])
      indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
    } else {
      if(nodes.get(edge.source)?.kind==='job'||nodes.get(edge.target)?.kind==='job')issue('job nodes do not request or perform native approvals')
      if (reviewers.has(edge.target)) issue('an App-routed requester has at most one reviewer')
      reviewers.add(edge.target)
    }
  }
  const queue = [...indegree].filter(([, count]) => count === 0).map(([id]) => id)
  let processed = 0
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!
    processed++
    for (const target of outgoing.get(id) ?? []) {
      const remaining = (indegree.get(target) ?? 0) - 1
      indegree.set(target, remaining)
      if (remaining === 0) queue.push(target)
    }
  }
  if (!hierarchyRequests && processed !== nodes.size) issue('execution relationships must form an acyclic graph')
  const reachable = new Set<string>(), visit = [version.entryNodeId]
  for (let i = 0; i < visit.length; i++) {
    const id = visit[i]!
    if (reachable.has(id)) continue
    reachable.add(id); visit.push(...(outgoing.get(id) ?? []))
  }
  for (const edge of execution) if (!hierarchyRequests && !reachable.has(edge.source) && reachable.has(edge.target)) issue('an excluded component cannot supply a selected-component dependency')
  if (Object.keys(version.agentConfigurationVersionIds).length !== new Set(graph.nodes.filter(node => node.kind !== 'job').map(node => node.agentId)).size) issue('configuration pins must describe exactly this topology')
  for (const node of graph.nodes) {
    if (node.kind !== 'job' && !version.agentConfigurationVersionIds[node.agentId]) issue('each Agent requires an immutable configuration pin')
    if (!node.choice) continue
    const selected = new Set<string>()
    for (const declaration of node.choice.outcomes) {
      if (declaration.target.kind === 'branch_end') continue
      const edge = edges.get(declaration.target.relationshipId)
      if (!edge || edge.kind !== 'execution' || (edge.source !== node.id
        && !(version.definition.handoffs && edge.workRequestDirection === 'both' && edge.target === node.id))) {
        issue('choice targets must be permitted work relationships')
      }
      selected.add(declaration.target.relationshipId)
    }
    for (const edge of execution) if (edge.source === node.id && !selected.has(edge.id)) issue('every outgoing choice relationship requires a declared outcome')
  }
}

/** Interval checks run outside the graph, so they cannot hold a routed approval wait. Only
 * Agents that never ask the workflow for approval may be re-activated on an interval. */
function agentIntervalAllowed(harness: z.infer<typeof AgentConfigurationVersionSchema>['harness'],
  handler: 'user' | 'orchestrator' | 'native'): boolean {
  return handler === 'native' || harness.harness === 'codex' && harness.advanced?.approvalPolicy === 'never'
}

export function validateCurrentWorkflowConfigurations(value: { version: Version & { definition: { repeat?: RepeatPlanV1 } }; configurations: z.infer<typeof AgentConfigurationVersionSchema>[] }, context: z.RefinementCtx): void {
  const { version, configurations } = value
  const fail = (message: string) => context.addIssue({ code: 'custom', message })
  const configs = new Map(configurations.map((configuration) => [configuration.id, configuration]))
  const nodes = version.definition.nodes
  if (configs.size !== configurations.length) fail('configuration IDs must be unique')
  if (Object.keys(version.agentConfigurationVersionIds).length !== new Set(nodes.filter(node => node.kind !== 'job').map(node => node.agentId)).size || configurations.length !== new Set(nodes.filter(node => node.kind !== 'job').map(node => node.agentId)).size) fail('configuration pins must describe exactly this topology')
  for (const node of nodes) {
    if (node.kind === 'job') continue
    const configuration = configs.get(version.agentConfigurationVersionIds[node.agentId]!)
    if (node.browser?.enabled && !node.browser.profileId) fail(`node ${node.id} needs a browser profile before executable save`)
    if (!configuration || configuration.workspaceId !== version.workspaceId || configuration.agentId !== node.agentId || !configuration.productRole) fail('an exact scoped configuration with a pinned product role is required')
    const outside = configuration?.productRole && node.graphqlTools
      ? graphqlToolsOutsideRole(configuration.productRole, [...node.graphqlTools.add, ...node.graphqlTools.remove]) : []
    if (outside.length) fail(`node ${node.id} Foreman Code MCP tools are outside its Agent role: ${outside.join(', ')}`)
    const assigned = new Set((configuration?.assignedSkills ?? []).map(skill => skill.skillId))
    for (const skillId of node.skills?.remove ?? []) {
      if (!assigned.has(skillId)) fail(`node ${node.id} removes skill ${skillId} that its Agent does not assign`)
    }
    for (const { skillId } of node.skills?.add ?? []) {
      if (assigned.has(skillId)) fail(`node ${node.id} adds skill ${skillId} that its Agent already assigns`)
    }
    if (node.interval && configuration && !agentIntervalAllowed(configuration.harness, version.approval.handler)) {
      fail(`node ${node.id} loops need an Agent that never asks for workflow approval: `
        + 'use workflow approval handler "native", or a Codex Agent with approvalPolicy "never"')
    }
  }
  const role = (nodeId: string) => {
    const node = nodes.find((candidate) => candidate.id === nodeId)
    return node && node.kind !== 'job' && configs.get(version.agentConfigurationVersionIds[node.agentId]!)?.productRole
  }
  const orchestrators = nodes.filter((node) => role(node.id) === 'orchestrator')
  if (!nodes.length) fail('an executable workflow needs an entry node')
  if (nodes.length === 1 && version.entryNodeId !== nodes[0]?.id) fail('a sole node starts itself')
  if (version.definition.hierarchy) {
    validateHierarchyConfiguration(value, context)
  } else {
    if (nodes.some((node) => role(node.id) === 'master')) fail('Master nodes require an explicit hierarchy')
    if (orchestrators.length ? role(version.entryNodeId) !== 'orchestrator' : nodes.find(node => node.id === version.entryNodeId)?.kind !== 'job' && role(version.entryNodeId) !== 'coder') fail('entry must use the pinned Orchestrator role when present, otherwise the Worker (coder) role')
  }
  for (const configuration of configurations) {
    if (!HarnessWorkflowCompatibilitySchema.safeParse({ configuration: configuration.harness,
      workflowApprovalHandler: version.approval.handler, designatedOrchestrator: version.approval.handler === 'orchestrator'
        && configuration.agentId === version.approval.designatedOrchestratorAgentId }).success) {
      const harness = configuration.harness
      if (version.approval.handler === 'native' && harness.harness === 'codex'
        && harness.advanced?.approvalPolicy === undefined) {
        fail(`Agent ${configuration.agentId} is missing saved Codex advanced.approvalPolicy. `
          + 'Save the Agent with approvalPolicy: "never", or approvalPolicy: "on-request" and approvalsReviewer: "auto_review", '
          + 'then retry with its new configuration version. You can also choose workflow approval handler "user" or "orchestrator".')
      } else {
        fail('pinned native configuration conflicts with approval authority')
      }
    }
  }
  const approvals = version.definition.edges.filter((edge) => edge.kind === 'approval')
  if (version.approval.handler !== 'orchestrator') {
    if (approvals.length) fail('App reviewer assignments require an Orchestrator approval handler')
    return
  }
  const entry = nodes.find((node) => node.id === version.entryNodeId)
  const coordinatorRole = version.definition.hierarchy ? 'master' : 'orchestrator'
  if ((entry?.kind === 'job' || entry?.agentId !== version.approval.designatedOrchestratorAgentId) || role(version.entryNodeId) !== coordinatorRole) fail('the supported initialized reviewer must be the explicit entry coordinator')
  for (const edge of approvals) if (edge.source !== version.entryNodeId || edge.target === version.entryNodeId) fail('independent or recursive reviewer startup is unsupported')
  // Match repeatReviewerOccurrence: an outside reviewer is reusable, but an
  // in-block reviewer has no exported execution binding for another scope.
  // This is executable admission, not an authoring-shape/history restriction.
  const blocks = new Map<string, string>()
  for (const block of version.definition.repeat?.blocks ?? []) {
    for (const nodeId of block.nodeIds) blocks.set(nodeId, block.id)
  }
  for (const [index, edge] of version.definition.edges.entries()) {
    if (edge.kind !== 'approval') continue
    const reviewerBlock = blocks.get(edge.source)
    if (reviewerBlock !== undefined && blocks.get(edge.target) !== reviewerBlock) {
      context.addIssue({ code: 'custom', path: ['version', 'definition', 'edges', index],
        params: { publicCode: 'REPEAT_REVIEW_SCOPE_UNSUPPORTED' },
        message: 'REPEAT_REVIEW_SCOPE_UNSUPPORTED: an in-block reviewer can only review requesters in the same repeat block; use an outside entry Orchestrator for cross-scope review.' })
    }
  }
  for (const node of nodes) {
    if (node.kind === 'job') continue
    const configuration = configs.get(version.agentConfigurationVersionIds[node.agentId]!)
    const nativeSelfReview = configuration?.harness.harness === 'codex'
      && configuration.harness.advanced?.approvalPolicy === 'on-request' && configuration.harness.advanced.approvalsReviewer === 'auto_review'
    if (node.id !== version.entryNodeId && !nativeSelfReview && !approvals.some((edge) => edge.target === node.id)) fail('App-routed requester requires an explicit reviewer relationship')
  }
}

/** Public current Run. Private accepted Runs require location/principal below
 * the admission boundary; redacted public reads may omit those two fields. */
export const CurrentWorkflowRunSchema = WorkflowRunRecordSchema
export const AcceptedCurrentNodeResultSchema = ExecutionResultSchema.superRefine((value, context) => {
  if (value.outcome !== 'succeeded') context.addIssue({ code: 'custom', message: 'only successful results are accepted inputs' })
  try { canonicalGraphJson(value, 64 * 1024) } catch { context.addIssue({ code: 'custom', message: 'accepted result exceeds bounds' }) }
})
