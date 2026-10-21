import { http, HttpResponse } from 'msw'
import type { AgentChatContext } from '@foreman-code/contracts/agent-chat'

/** The Board resolves a node's chat target before it mounts a conversation. Outside a Run it resolves to the node itself. */
export function outsideRunTargetHandler(scope: { workspaceId: string; workflowId: string }, contexts: readonly AgentChatContext[],
  workflowVersionId: string) {
  return http.get(`/api/workspaces/${scope.workspaceId}/workflows/${scope.workflowId}/execution-chat/target`, ({ request }) => {
    const nodeId = new URL(request.url).searchParams.get('workflowNodeId')
    const context = contexts.find(item => item.workflowNodeId === nodeId)
    return context ? HttpResponse.json({ kind: 'outside_run', agent: context, workflowVersionId, reason: 'NO_LIVE_RUN' })
      : HttpResponse.json({ error: { code: 'CHAT_NODE_UNAVAILABLE', message: 'The selected Agent is unavailable.' } }, { status: 404 })
  })
}
