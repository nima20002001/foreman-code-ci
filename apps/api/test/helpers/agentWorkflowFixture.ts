import type { WorkflowDefinitionV3, WorkflowVersionV3 } from '@foreman-code/contracts/wave25'

/** Agent-only fixtures reject Jobs rather than manufacturing Agent identities. */
export function agentWorkflowNode(node: WorkflowDefinitionV3['nodes'][number] | undefined) {
  if (!node || node.kind === 'job') throw new Error('Agent fixture requires an Agent workflow node')
  return node
}

export function agentWorkflowVersion(version: WorkflowVersionV3) {
  return { ...version, definition: { ...version.definition, nodes: version.definition.nodes.map(agentWorkflowNode) } }
}
