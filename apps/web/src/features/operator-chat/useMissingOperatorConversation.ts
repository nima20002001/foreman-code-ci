import { useEffect, useState } from 'react'
import { ApiError } from '../../shared/api/client'
import { identityEpoch } from '../../shared/api/protectedChatStorage'
import { sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { useOperatorChatStore } from './operatorChatStore'

export function isMissingOperatorConversation(error: unknown): boolean {
  return ApiError.is(error) && error.status === 404 && error.code === 'CONVERSATION_NOT_FOUND'
}

/** Detach only a definitively missing selection; drafts and uncertain sends stay intact. */
export function useMissingOperatorConversation(selectedId: string | undefined, missing: boolean): boolean {
  const epoch = identityEpoch()
  const [recoveredEpoch, setRecoveredEpoch] = useState<string>()
  useEffect(() => {
    if (!selectedId || !missing || sessionIsSwitching() || identityEpoch() !== epoch) return
    const current = useOperatorChatStore.getState()
    if (current.selectedConversationId !== selectedId) return
    current.select(undefined)
    setRecoveredEpoch(epoch)
  }, [epoch, missing, selectedId])
  return recoveredEpoch === epoch && !selectedId
}
