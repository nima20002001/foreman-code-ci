import type { z } from 'zod'
import type { AgentConfigurationVersion } from '../index.js'
import { WorkflowHierarchyContextSchema } from '../workflowHierarchy.js'
import type { WorkflowDefinitionV3 } from './workflowShape.js'

/** Executable-only rules. An incomplete authoring draft remains representable. */
export function validateHierarchyConfiguration(value: {
  version: { workspaceId: string; workflowId: string; entryNodeId: string;
    definition: WorkflowDefinitionV3; agentConfigurationVersionIds: Record<string, string> }
  configurations: AgentConfigurationVersion[]
}, context: z.RefinementCtx): void {
  const { version, configurations } = value
  const graph = version.definition, hierarchy = graph.hierarchy
  if (!hierarchy) return
  const issue = (code: string, message: string, path: (string | number)[]) => context.addIssue({
    code: 'custom', path: ['version', 'definition', ...path], message,
    params: { issueCode: code, publicCode: code },
  })
  const configs = new Map(configurations.map(configuration => [configuration.id, configuration]))
  const identities = graph.nodes.flatMap(node => {
    if (node.kind === 'job') return []
    const configuration = configs.get(version.agentConfigurationVersionIds[node.agentId]!)
    return [{ workspaceId: version.workspaceId, workflowId: version.workflowId,
      workflowNodeId: node.id, agentId: node.agentId, productRole: configuration?.productRole,
      configurationVersionId: configuration?.id, displayName: node.name ?? node.label ?? node.id }]
  })
  const parsed = WorkflowHierarchyContextSchema.safeParse({ hierarchy, workspaceId: version.workspaceId,
    workflowId: version.workflowId, entryNodeId: version.entryNodeId, nodes: identities })
  if (!parsed.success) for (const problem of parsed.error.issues) {
    issue('HIERARCHY_INVALID', problem.message, ['hierarchy', ...problem.path.filter(
      (part): part is string | number => typeof part === 'string' || typeof part === 'number')])
  }
  if (!graph.handoffs) issue('HIERARCHY_HANDOFFS_REQUIRED', 'Master reporting needs work handoffs.', ['handoffs'])
  if (graph.repeat) issue('HIERARCHY_REPEAT_UNSUPPORTED', 'Master reporting does not support repeat blocks. Keep this as an ordinary workflow or remove the repeat explicitly.', ['repeat'])
  for (const [index, node] of graph.nodes.entries()) {
    if (node.kind === 'job') issue('HIERARCHY_JOB_UNSUPPORTED', 'Master reporting supports Agent nodes. Keep jobs in an ordinary workflow.', ['nodes', index])
    if (node.join) issue('HIERARCHY_JOIN_UNSUPPORTED', 'Master reporting uses explicitly requested work. Remove “Wait for all incoming connections” before saving.', ['nodes', index, 'join'])
    if (node.kind !== 'job' && node.interval) issue('HIERARCHY_INTERVAL_UNSUPPORTED', 'Master reporting does not support interval checks. Turn off the interval before saving.', ['nodes', index, 'interval'])
  }
  for (const [index, member] of hierarchy.parents.entries()) {
    const parent = graph.nodes.find(node => node.id === member.parentNodeId)
    const routes = parent?.choice?.outcomes.filter(outcome => {
      if (outcome.target.kind !== 'edge') return false
      const relationshipId = outcome.target.relationshipId
      const relationship = graph.edges.find(edge => edge.id === relationshipId)
      return relationship?.kind === 'execution' && relationship.source === member.parentNodeId
        && relationship.target === member.workflowNodeId
    }) ?? []
    if (!routes.length) issue('HIERARCHY_CHILD_ROUTE_REQUIRED',
      'Each reporting child needs a saved named work outcome on its parent.', ['hierarchy', 'parents', index])
  }
}
