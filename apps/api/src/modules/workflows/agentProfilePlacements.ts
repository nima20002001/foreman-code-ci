import type { AgentConfigurationVersion } from '@foreman-code/contracts'
import { sameWorkflowValue, type WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { DomainError } from '../errors.js'

export function reconcileAgentProfilePlacements(
  graph: WorkflowDefinitionV3,
  configurations: readonly AgentConfigurationVersion[],
): WorkflowDefinitionV3 {
  const byAgent = new Map(configurations.map(configuration => [configuration.agentId, configuration]))
  const nodes = graph.nodes.map((node, index) => {
    if (node.kind === 'job' || !node.placement) return node
    const selection = byAgent.get(node.agentId)?.harnessProfileSelection
    if (!selection) return node
    if (!sameWorkflowValue(node.placement.hostRef, selection.target.hostRef)) {
      const message = `Node '${node.name ?? node.label ?? node.id}' (${node.id}) uses a different computer `
        + `from Agent '${node.agentId}'s selected profile. Select a profile on this node's computer `
        + 'or explicitly change the node placement before saving.'
      throw new DomainError('GRAPH_INVALID', message, 409, { issues: [{
        code: 'AGENT_PROFILE_PLACEMENT_CONFLICT', path: ['nodes', index, 'placement'], message,
      }] })
    }
    return { ...node, placement: { ...node.placement,
      instanceId: selection.instanceId,
      instanceRevision: selection.instanceRevision,
      harnessInstallationId: selection.target.harnessInstallationId,
    } }
  })
  return { ...graph, nodes }
}
