import { useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { agentChatApi } from '../../../shared/api/agentChat'
import { sessionGeneration } from '../../../shared/api/sessionBoundary'
import { Alert, Button } from '../../../shared/ui/nocturne'
import { AgentChatMessage } from './AgentChatMessage'

export function AgentConversationHistory({ workspaceId, conversationId, name }: {
  workspaceId: string; conversationId: string; name: string
}) {
  const [open, setOpen] = useState(false)
  const key = ['agent-chat-history', sessionGeneration(), workspaceId, conversationId]
  const conversation = useQuery({ queryKey: [...key, 'conversation'], enabled: open,
    queryFn: ({ signal }) => agentChatApi.readConversation(workspaceId, conversationId, { signal }),
  })
  const history = useInfiniteQuery({ queryKey: [...key, 'messages'], enabled: open,
    queryFn: ({ pageParam, signal }) => agentChatApi.history(workspaceId, conversationId, pageParam, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor ?? undefined,
  })
  const previous = conversation.data?.conversation?.previousConversationId
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Previous conversation</summary>
    {conversation.isError || history.isError ? <Alert tone="warning" title="Conversation history could not be loaded">
      <Button onClick={() => { void conversation.refetch(); void history.refetch() }}>Retry</Button>
    </Alert> : null}
    {previous ? <AgentConversationHistory workspaceId={workspaceId} conversationId={previous} name={name} /> : null}
    {history.hasNextPage ? <Button disabled={history.isFetchingNextPage}
      onClick={() => void history.fetchNextPage()}>Load earlier messages</Button> : null}
    {[...(history.data?.pages ?? [])].reverse().flatMap(page => page.messages)
      .filter(message => message.activityChannel !== 'reasoning')
      .map(message => <AgentChatMessage key={message.id} message={message} name={name} />)}
  </details>
}
