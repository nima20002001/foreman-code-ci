import type { Dispatch, RefObject, SetStateAction } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { OperatorConversationState, RespondOperatorInteractionRequest } from '@foreman-code/contracts'
import { cancelOperatorTurn, respondOperatorInteraction } from '../../shared/api/client'
import { deleteOperatorConversation, restoreOperatorConversation } from '../../shared/api/operatorChatSummaries'
import { useOperatorChatStore } from './operatorChatStore'
import { currentSession, detailKey, listKey, type Summaries } from './operatorChatShared'

/** Cancel, approval response, delete and undo-delete mutations for the Operator chat. */
export function useOperatorConversationMutations({ acceptState, invalidate, deletedRevisions, setRemoved }: {
  acceptState: (id: string, state: OperatorConversationState) => void
  invalidate: (id: string) => Promise<void>
  deletedRevisions: RefObject<Map<string, number>>
  setRemoved: Dispatch<SetStateAction<{ id: string; title: string } | undefined>>
}) {
  const queryClient = useQueryClient()
  const select = useOperatorChatStore((state) => state.select)
  const cancel = useMutation({ mutationFn: ({ id, requestId }: { id: string; requestId: string; generation: number }) => cancelOperatorTurn(id, requestId),
    onSuccess: async (result, input) => {
      if (!currentSession(input.generation)) return
      acceptState(input.id, result.state); await invalidate(input.id)
    } })
  const respond = useMutation({ mutationFn: ({ id, input }: { id: string; input: RespondOperatorInteractionRequest; generation: number }) => respondOperatorInteraction(id, input),
    onSuccess: async (result, variables) => {
      if (!currentSession(variables.generation)) return
      acceptState(variables.id, result.state); await invalidate(variables.id)
    } })

  const remove = useMutation({
    mutationFn: ({ id }: { id: string; title: string; generation: number }) => deleteOperatorConversation(id),
    onSuccess: async (result, input) => {
      if (!currentSession(input.generation)) return
      const previous = queryClient.getQueryData<OperatorConversationState>(detailKey(input.id))?.revision
        ?? queryClient.getQueryData<Summaries>(listKey)?.conversations.find(item => item.conversationId === input.id)?.revision ?? 0
      deletedRevisions.current.set(input.id, result.revision ?? previous + 1)
      await queryClient.cancelQueries({ queryKey: listKey })
      await queryClient.cancelQueries({ queryKey: detailKey(input.id) })
      queryClient.setQueryData<Summaries>(listKey, (current) => current && ({ ...current, conversations: current.conversations.filter((item) => item.conversationId !== input.id) }))
      queryClient.removeQueries({ queryKey: detailKey(input.id) })
      queryClient.removeQueries({ queryKey: ['operator-chat', 'activity', input.id] })
      setRemoved({ id: input.id, title: input.title })
      if (useOperatorChatStore.getState().selectedConversationId === input.id) {
        select(queryClient.getQueryData<Summaries>(listKey)?.conversations[0]?.conversationId)
      }
      await queryClient.invalidateQueries({ queryKey: listKey })
    },
  })
  const restore = useMutation({
    mutationFn: ({ id }: { id: string; generation: number; navigationGeneration: number }) => restoreOperatorConversation(id),
    onSuccess: async (_result, input) => {
      if (!currentSession(input.generation)) return
      setRemoved(undefined)
      await queryClient.invalidateQueries({ queryKey: listKey })
      if (currentSession(input.generation)
        && useOperatorChatStore.getState().navigationGeneration === input.navigationGeneration) select(input.id)
    },
  })
  return { cancel, respond, remove, restore }
}
