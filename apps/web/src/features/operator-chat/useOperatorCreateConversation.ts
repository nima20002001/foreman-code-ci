import { useRef, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { OperatorChatSetup } from '@foreman-code/contracts'
import { useConversationDraftStore } from '../conversations'
import { createOperatorConversation } from '../../shared/api/client'
import { sessionGeneration, SessionChangedError } from '../../shared/api/sessionBoundary'
import { operatorChatSetupKey, type useOperatorChatSetup } from '../../shared/api/operatorChatSetup'
import { isNarrowOperatorChat, useOperatorChatStore } from './operatorChatStore'
import type { useOperatorSettings } from './useOperatorSettings'
import { currentSession, listKey, type AppRequest, type AskSend } from './operatorChatShared'

export function useOperatorCreateConversation({ historyTriggerRef, setAskSend, setup, preferences, accessDenied, selectedId }: {
  historyTriggerRef: RefObject<HTMLButtonElement | null>
  setAskSend: Dispatch<SetStateAction<AskSend | undefined>>
  setup: ReturnType<typeof useOperatorChatSetup>
  preferences: ReturnType<typeof useOperatorSettings>
  accessDenied: boolean
  selectedId: string | undefined
}) {
  const queryClient = useQueryClient()
  const select = useOperatorChatStore((state) => state.select)
  const clearDraft = useConversationDraftStore((state) => state.clearDraft)
  const creating = useRef(false)
  const create = useMutation({ mutationFn: (input: {
    generation: number; navigationGeneration: number; commandId: string; request?: AppRequest
  }) => {
    if (!currentSession(input.generation)) throw new SessionChangedError()
    return createOperatorConversation({ commandId: input.commandId })
  },
    onSuccess: async ({ conversation }, input) => {
      if (!currentSession(input.generation)) return
      if (input.request) {
        const store = useOperatorChatStore.getState()
        if (store.request?.id !== input.request.id) return
        useConversationDraftStore.getState().setDraft(conversation.id, input.request.content)
        store.takeRequest(input.request.id)
      }
      if (useOperatorChatStore.getState().navigationGeneration === input.navigationGeneration) {
        select(conversation.id)
        if (isNarrowOperatorChat()) historyTriggerRef.current?.focus()
        if (input.request?.send) setAskSend({
          id: conversation.id, requestId: input.request.id, content: input.request.content,
          generation: input.generation, navigationGeneration: useOperatorChatStore.getState().navigationGeneration,
          ready: false,
        })
      }
      // Pre-creation inspection has no accepted configuration pin. Once one
      // exists, reuse its verified installation across every subsequent chat.
      const cached = queryClient.getQueryState<OperatorChatSetup>(operatorChatSetupKey(preferences.query.data?.revision,
        { ...(preferences.settings ? { harness: preferences.settings.harness } : {}) }))
      const inspected = cached?.fetchStatus === 'fetching' ? await setup.refetch({ cancelRefetch: false }) : cached
      if (inspected?.data?.status === 'configured' && !inspected.data.configurationVersionId) await setup.refetch()
      await queryClient.invalidateQueries({ queryKey: listKey })
    },
    onSettled: (_data, error, input) => {
      creating.current = false
      const requestId = input.request?.id
      if (!error && requestId) setAskSend((current) =>
        current?.requestId === requestId ? { ...current, ready: true } : current)
    },
  })
  const createConversation = async ({ retry = false }: { retry?: boolean } = {}) => {
    if (creating.current || accessDenied) return
    creating.current = true
    try {
      const failed = create.variables
      const commandId = retry && create.isError && failed && !failed.request
        && currentSession(failed.generation) ? failed.commandId : crypto.randomUUID()
      await create.mutateAsync({ generation: sessionGeneration(), commandId,
        navigationGeneration: useOperatorChatStore.getState().beginNavigation() })
      if (selectedId) {
        const draft = useConversationDraftStore.getState().drafts[selectedId] ?? ''
        if (/^\/n?e?w?$/.test(draft.trim())) clearDraft(selectedId, draft)
      }
    } catch { /* ignore: The mutation keeps the failure visible. */ }
    finally { creating.current = false }
  }
  return { create, creating, createConversation }
}
