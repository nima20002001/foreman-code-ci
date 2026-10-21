import type { AgentNodeRef, MemoryCardWorkBinding } from '@foreman-code/contracts'
import type { MemoryNodeOption } from './ports'

export const statusLabels = { todo: 'Todo', doing: 'Doing', waiting_for_user: 'Waiting for user', blocked: 'Blocked', done: 'Done' } as const
export const nodeKey = (node: AgentNodeRef) => `${node.workspaceId}/${node.workflowId}/${node.workflowNodeId}/${node.agentId}`
export function nodeLabel(node: AgentNodeRef, nodes: readonly MemoryNodeOption[]): string {
  const found = nodes.find((candidate) => nodeKey(candidate.node) === nodeKey(node))
  return found?.available ? found.label : `This agent/workflow is no longer available · ${node.workflowNodeId.slice(0, 8)}`
}
export function bindingLabel(binding: MemoryCardWorkBinding): string {
  switch (binding.state) {
    case 'queued': return 'Queued'
    case 'running': return 'Working'
    case 'awaiting_acceptance': return 'Processing result'
    case 'waiting_children': return 'Waiting for child reports'
    case 'accepted': return 'Accepted'
    case 'blocked': return 'Blocked'
    case 'failed': return 'Failed'
    case 'canceled': return 'Canceled'
  }
}
export const visibleTime = (value: string | number) => new Date(value).toLocaleString()
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Couldn’t complete this request.'
