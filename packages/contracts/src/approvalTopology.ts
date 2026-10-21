import type { WorkflowDefinition } from './index.js'

export interface DirectApprovalConnection {
  requestingNodeId: string
  orchestratorNodeId: string
}

/**
 * An edge is an approval adjacency, not a grant. Execution direction is unchanged.
 * Resolve the requesting occurrence by node ID, never by a matching Agent elsewhere
 * in the graph. An ambiguous reviewer is not a designation.
 */
export function directApprovalConnection(
  definition: Pick<WorkflowDefinition, 'nodes' | 'edges'>,
  requestingNodeId: string,
  requestingAgentId: string,
  orchestratorAgentId: string,
): DirectApprovalConnection | undefined {
  const requesters = definition.nodes.filter((node) => node.kind !== 'job' && node.id === requestingNodeId)
  const reviewers = definition.nodes.filter((node) => node.kind !== 'job' && node.agentId === orchestratorAgentId)
  if (requesters.length !== 1 || reviewers.length !== 1) return undefined
  const requester = requesters[0]!
  const reviewer = reviewers[0]!
  if (requester.kind === 'job' || reviewer.kind === 'job') return undefined
  if (requester.agentId !== requestingAgentId || requester.id === reviewer.id
    || requestingAgentId === orchestratorAgentId) return undefined
  const adjacent = definition.edges.some((edge) =>
    (edge.source === requester.id && edge.target === reviewer.id)
    || (edge.target === requester.id && edge.source === reviewer.id))
  return adjacent ? { requestingNodeId: requester.id, orchestratorNodeId: reviewer.id } : undefined
}
