import { useEffect, useMemo, useRef, type RefObject } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import type { AgentChatContext, AgentChatState } from '@foreman-code/contracts/agent-chat'
import { agentChatApi } from '../../../shared/api/agentChat'
import { ApiError } from '../../../shared/api/client'
import { isApiAccessError } from '../../../shared/api/accessError'
import { assertSession } from '../../../shared/api/sessionBoundary'
import { readEarlierChatHistory } from './historyReadback'

export function useAgentChatHistory(context: AgentChatContext, state: AgentChatState | undefined, generation: number,
  key: readonly unknown[], commandDenial: RefObject<ApiError | undefined>, readGeneration: RefObject<number>) {
  const client = useQueryClient(), historyId = state?.conversation?.id
  const historyKey = useMemo(() => ['agent-chat', generation, context, historyId, 'history'], [context, generation, historyId])
  const history = useInfiniteQuery({ queryKey: historyKey, maxPages: 5,
    queryFn: async ({ pageParam, signal }) => {
      try {
        const result = await readEarlierChatHistory(before => agentChatApi.history(context.workspaceId, historyId!, before, { signal }),
          pageParam, state?.messages[0]?.id)
        signal.throwIfAborted(); assertSession(generation)
        return result
      } catch (error) {
        if (isApiAccessError(error)) {
          commandDenial.current = error; readGeneration.current++
          await client.cancelQueries({ queryKey: key, exact: true })
        }
        throw error
      }
    }, initialPageParam: undefined as string | undefined, getNextPageParam: page => page.nextCursor ?? undefined,
    enabled: false, retry: false,
  })
  const historyRevision = useRef<{ identity: string; revision: number } | undefined>(undefined)
  const { data, refetch } = history
  useEffect(() => {
    const identity = JSON.stringify(historyKey), revision = state?.revision
    if (revision === undefined) return
    const previous = historyRevision.current; historyRevision.current = { identity, revision }
    const advanced = previous?.identity === identity && revision > previous.revision
    const mutable = data?.pages.some(batch => batch.pages.some(page => page.messages.some(message => message.role === 'assistant' && message.nativeMessageComplete === false)))
    if (advanced && mutable) void refetch()
  }, [historyKey, state?.revision, data, refetch])
  return { history, historyKey }
}
