import { getOperatorConversation } from '../../shared/api/client'
import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { OperatorActivitySchema } from '@foreman-code/contracts'
import type { OperatorConversationState } from '@foreman-code/contracts'
import { createStreamReadback } from '../../shared/api/streamReadback'
import { committedMessage, createCommittedMessageBuffer, patchCommittedMessages } from '../conversations/delivery/committedMessageStream'
import { markChatTurnCompleted } from '../conversations/chatTurnCompletion'
import { subscribeOperatorChat } from '../../shared/api/operatorChatStream'
import { identityEpoch } from '../../shared/api/protectedChatStorage'
import { projectOperatorActivity } from './operatorTextProjection'
import { detailKey, listKey, type ConnectionState, type PartialState } from './operatorChatShared'
import { newerOperatorConversationState } from './operatorConversationReadback'

/** Live Operator stream. Presentation-only fragments; Query/PostgreSQL still own all finalized state. */
export function useOperatorChatStream({ enabled, open, selectedId, accessDenied, acceptState, readGeneration, setPartial, setConnection }: {
  enabled: boolean
  open: boolean
  selectedId: string | undefined
  accessDenied: boolean
  acceptState: (id: string, state: OperatorConversationState) => void
  readGeneration: RefObject<number>
  setPartial: Dispatch<SetStateAction<PartialState>>
  setConnection: Dispatch<SetStateAction<ConnectionState>>
}) {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!enabled || !open || !selectedId || accessDenied) return
    let disposed = false
    const readback = createStreamReadback(async () => {
      if (disposed) return
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: detailKey(selectedId) }, { cancelRefetch: false }),
        queryClient.invalidateQueries({ queryKey: listKey }),
        queryClient.invalidateQueries({ queryKey: ['operator-chat', 'history', identityEpoch(), selectedId] }),
      ])
    })
    const refresh = readback.request
    const text = createCommittedMessageBuffer(messages => {
      if (disposed) return
      queryClient.setQueryData<OperatorConversationState>(detailKey(selectedId), previous => previous
        ? patchCommittedMessages(previous, messages, selectedId, previous.activeRequestId) : previous)
    }, refresh)
    const close = subscribeOperatorChat(selectedId, {
      recover: async () => {
        await queryClient.cancelQueries({ queryKey: detailKey(selectedId), exact: true })
        if (disposed) throw new DOMException('Conversation changed.', 'AbortError')
        const state = await queryClient.fetchQuery({ queryKey: detailKey(selectedId), retry: false, staleTime: 0,
          queryFn: async ({ signal }) => {
            const incoming = await getOperatorConversation(selectedId, { signal })
            signal.throwIfAborted()
            return newerOperatorConversationState(queryClient.getQueryData<OperatorConversationState>(detailKey(selectedId)), incoming, 'read')
          } })
        if (disposed) throw new DOMException('Conversation changed.', 'AbortError')
        acceptState(selectedId, state)
      },
      snapshot: (state) => {
        text.clear()
        readGeneration.current++
        void queryClient.cancelQueries({ queryKey: detailKey(selectedId), exact: true })
        acceptState(selectedId, state)
        refresh()
      },
      reconnect: () => { text.clear(); setPartial((current) => current?.conversationId === selectedId ? undefined : current); refresh() },
      connection: (state) => setConnection((current) => current?.id === selectedId && current.state === state ? current : { id: selectedId, state }),
      event: (event) => {
        if (event.type === 'state' && typeof event.data.requestId === 'string'
          && ['idle', 'error'].includes(String(event.data.turnState))) {
          markChatTurnCompleted(queryClient, selectedId, event.data.requestId)
        }
        const state = queryClient.getQueryData<OperatorConversationState>(detailKey(selectedId))
        if (event.type === 'delta') {
          const message = committedMessage(event.data, selectedId, state?.activeRequestId)
          if (message) { text.push(message); return }
        }
        text.clear()
        if (event.type === 'activity') {
          const activity = OperatorActivitySchema.safeParse(event.data.activity)
          if (!activity.success || typeof event.data.revision !== 'number') { refresh(); return }
          const value = activity.data
          // A partial event cannot advance the revision of a complete snapshot.
          refresh()
          setPartial((current) => ({ conversationId: selectedId,
            value: projectOperatorActivity(current?.conversationId === selectedId ? current.value : undefined,
              state?.activeRequestId ?? null, value.requestId, value.id) }))
        } else if (event.type === 'delta') {
          refresh()
        } else {
          // Keep the streamed reply until the authoritative snapshot contains its
          // final replacement. Clearing here creates a visible blank during refetch.
          refresh()
        }
      },
    })
    return () => { disposed = true; text.clear(); readback.dispose(); close() }
  }, [acceptState, accessDenied, enabled, open, queryClient, readGeneration, selectedId, setConnection, setPartial])
}
