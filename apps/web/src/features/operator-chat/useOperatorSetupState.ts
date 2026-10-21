import { ApiError } from '../../shared/api/client'
import { sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { useOperatorChatSetup } from '../../shared/api/operatorChatSetup'
import { pendingOperatorSetupTarget } from '../../shared/api/operatorSetupTarget'
import { isMissingOperatorConversation, useMissingOperatorConversation } from './useMissingOperatorConversation'
import { readPendingOperatorMessage } from './operatorOutbox'
import type { useOperatorSettings } from './useOperatorSettings'

export function useOperatorSetupState({ enabled, open, selectedId, accessDenied, selectedError, preferences, preferencesDenied }: {
  enabled: boolean
  open: boolean
  selectedId: string | undefined
  accessDenied: boolean
  selectedError: unknown
  preferences: ReturnType<typeof useOperatorSettings>
  preferencesDenied: boolean
}) {
  const pending = selectedId && !accessDenied && enabled && !sessionIsSwitching() ? readPendingOperatorMessage(selectedId) : {}
  const setup = useOperatorChatSetup(enabled && open && !pending.command && Boolean(preferences.settings), preferences.query.data?.revision,
    { ...(preferences.settings ? { harness: preferences.settings.harness } : {}) })
  const retrySetup = useOperatorChatSetup(enabled && open && Boolean(pending.command) && !accessDenied, undefined,
    pendingOperatorSetupTarget(selectedId, pending.command))
  const shownSetup = pending.command ? retrySetup : setup
  const setupDenied = ApiError.is(shownSetup.error) && [401, 403].includes(shownSetup.error.status)
  const missingSelection = Boolean(selectedId) && !accessDenied && !preferencesDenied && !setupDenied
    && (isMissingOperatorConversation(selectedError) || isMissingOperatorConversation(shownSetup.error))
  const recoveredSelection = useMissingOperatorConversation(selectedId, missingSelection)
  return { pending, setup, shownSetup, missingSelection, recoveredSelection }
}
