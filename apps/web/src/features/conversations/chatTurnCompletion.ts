import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { QueryObserver, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { sessionGeneration } from '../../shared/api/sessionBoundary'

const completionKey = (conversationId: string, requestId: string, generation: number) =>
  ['chat-turn-completed', generation, conversationId, requestId] as const

/** Terminal notifications hide responding dots while the full snapshot is still being read.
 * Keep them in Query across reconnects and stale reads; they do not change command availability. */
export function markChatTurnCompleted(client: QueryClient, conversationId: string, requestId: string): void {
  client.setQueryData(completionKey(conversationId, requestId, sessionGeneration()), true)
}

export function useChatTurnCompleted(conversationId: string | undefined, requestId: string | null | undefined): boolean {
  const client = useQueryClient()
  const generation = sessionGeneration()
  // Subscribe directly so completion removes the animation in the event's render batch.
  const observer = useMemo(() => new QueryObserver<boolean>(client, {
    queryKey: completionKey(conversationId ?? '', requestId ?? '', generation),
    enabled: false,
  }), [client, conversationId, requestId, generation])
  const subscribe = useCallback((onChange: () => void) => observer.subscribe(onChange), [observer])
  const getSnapshot = () => observer.getCurrentResult().data === true
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
