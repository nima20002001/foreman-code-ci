import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { SessionMode } from '@foreman-code/contracts'
import { useConversationDraftStore } from '../conversations'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { useOperatorChatStore } from './operatorChatStore'
import type { useOperatorCreateConversation } from './useOperatorCreateConversation'
import { currentSession, type AskSend } from './operatorChatShared'

/**
 * A request from elsewhere in the app (askOperator) starts its own conversation
 * and is sent once the chat can send.
 */
export function useAskOperatorRequest({ enabled, open, accessDenied, create, creating, askSend, setAskSend, selectedId, askReady, submit }: {
  enabled: boolean
  open: boolean
  accessDenied: boolean
  create: ReturnType<typeof useOperatorCreateConversation>['create']
  creating: RefObject<boolean>
  askSend: AskSend | undefined
  setAskSend: Dispatch<SetStateAction<AskSend | undefined>>
  selectedId: string | undefined
  askReady: boolean
  submit: (content: string, sessionMode?: SessionMode) => Promise<void>
}) {
  const request = useOperatorChatStore((state) => state.request)
  const requestedDraft = useConversationDraftStore((state) => askSend ? state.drafts[askSend.id] : undefined)
  const submitRef = useRef<((content: string) => Promise<void>) | undefined>(undefined)
  useEffect(() => {
    if (!enabled || !open || !request || accessDenied || creating.current) return
    if (create.isError && create.variables?.request?.id === request.id) return
    creating.current = true
    create.mutate({ generation: sessionGeneration(), commandId: request.id,
      navigationGeneration: useOperatorChatStore.getState().beginNavigation(), request })
  }, [accessDenied, create, creating, enabled, open, request])
  submitRef.current = submit
  useEffect(() => {
    if (!askSend) return
    const store = useOperatorChatStore.getState()
    if (!currentSession(askSend.generation) || store.navigationGeneration !== askSend.navigationGeneration
      || (store.request && store.request.id !== askSend.requestId) || requestedDraft !== askSend.content) {
      setAskSend(undefined)
      return
    }
    if (!askSend.ready || askSend.id !== selectedId || !askReady) return
    setAskSend(undefined)
    void submitRef.current?.(askSend.content)
  }, [askReady, askSend, request, requestedDraft, selectedId, setAskSend])
  return request
}
