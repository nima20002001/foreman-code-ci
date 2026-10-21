import type { RefObject } from 'react'
import type { OperatorConversationState, OperatorConversationSummary } from '@foreman-code/contracts'
import { selectLiveTextTimeline } from '../conversations/chatTimeline'
import type { useOperatorChatSetup } from '../../shared/api/operatorChatSetup'
import type { useProviderAccounts } from '../provider-accounts/providerAccountsQueries'
import { newerOperatorSummaries, operatorTurnStatus, summarizeOperatorConversation } from './operatorChatStatus'
import type { ConnectionState, PartialState, Summaries } from './operatorChatShared'
import type { useOperatorSettings } from './useOperatorSettings'

/** Settings, account binding and readiness for the next Operator message. */
export function deriveOperatorMessaging({ conversation, preferences, preferencesDenied, accounts, setup }: {
  conversation: OperatorConversationState | undefined
  preferences: ReturnType<typeof useOperatorSettings>
  preferencesDenied: boolean
  accounts: ReturnType<typeof useProviderAccounts>
  setup: ReturnType<typeof useOperatorChatSetup>
}) {
  const settings = preferencesDenied ? undefined : preferences.settings
  // Historical OpenCode chats stay readable, with no composer or response controls.
  const retired = conversation?.settings?.harness === 'opencode'
  const acceptedBinding = conversation?.providerAccountBinding
  let conversationAccountId: string | undefined
  if (acceptedBinding?.kind === 'slot') conversationAccountId = acceptedBinding.accountId
  else if (conversation?.settings?.harness !== 'opencode') conversationAccountId = conversation?.settings?.accountId
  const hasAcceptedConversation = Boolean(acceptedBinding || conversation?.messages.length || conversation?.hasEarlierMessages)
  const usesSavedAccount = hasAcceptedConversation && settings?.harness === conversation?.settings?.harness
  const defaultAccountId = accounts.data?.accounts.find(account =>
    account.provider === settings?.harness && account.isDefault && !account.removedAt)?.id
  const requestedAccountId = settings?.accountId ?? (usesSavedAccount ? conversationAccountId : defaultAccountId)
  const messageSettings = settings && !settings.accountId
    && usesSavedAccount && conversationAccountId ? { ...settings, accountId: conversationAccountId } : settings
  const pendingHandoff = Boolean(settings && conversation?.settings
    && (settings.harness !== conversation.settings.harness || requestedAccountId !== conversationAccountId)
    && (conversation.messages.length > 0 || conversation.hasEarlierMessages))
  const setupReady = setup.isSuccess && setup.data.status === 'configured' && setup.data.harness === settings?.harness
    && Boolean(setup.data.configurationVersionId)
  const settingsReady = Boolean(preferences.query.data) && !preferencesDenied && !preferences.form.isDirty && !preferences.form.isSaving && !preferences.form.uncertain
  return { settings, retired, messageSettings, pendingHandoff, setupReady, settingsReady }
}

/** Streamed text that has not reached an authoritative snapshot yet. */
export function deriveOperatorLiveText({ conversation, partial, selectedId, requestId }: {
  conversation: OperatorConversationState | undefined
  partial: PartialState
  selectedId: string | undefined
  requestId: string | null | undefined
}) {
  const liveTimeline = partial?.value && partial.conversationId === selectedId && partial.value.requestId === requestId
    ? selectLiveTextTimeline(conversation?.messages ?? [], requestId, partial.value.timeline) : []
  const partialText = liveTimeline.filter(item => item.kind === 'text').map(item => item.text).join('\n\n')
  const thinkingText = conversation?.settings?.showThinking && partial?.value && partial.conversationId === selectedId && partial.value.requestId === requestId
    ? Object.entries(partial.value.parts).filter(([id]) => id.startsWith('thinking:')).map(([, text]) => text).join('\n\n') : ''
  return { partialText, thinkingText }
}

/** History entries, attention badges and the connection-aware turn status line. */
export function deriveOperatorNavigation({ accessDenied, listData, conversation, deletedRevisions, connection, selectedId, selected }: {
  accessDenied: boolean
  listData: Summaries | undefined
  conversation: OperatorConversationState | undefined
  deletedRevisions: RefObject<Map<string, number>>
  connection: ConnectionState
  selectedId: string | undefined
  selected: { isError: boolean; failureCount: number; isSuccess: boolean }
}) {
  const entries: OperatorConversationSummary[] = accessDenied ? [] : (listData?.conversations ?? []).map((item) =>
    conversation?.conversation.id === item.conversationId && conversation.revision >= item.revision ? summarizeOperatorConversation(conversation) : item)
  const attention = accessDenied ? [] : newerOperatorSummaries(entries, listData?.attention ?? entries)
    .filter((item) => item.revision > (deletedRevisions.current.get(item.conversationId) ?? -1) && item.needsAttention)
  const liveConnection = connection && connection.id === selectedId ? connection.state : 'connecting'
  const connectionState = liveConnection !== 'connected' && (selected.isError || selected.failureCount > 0)
    ? 'reconnecting' : liveConnection
  const turnStatus = conversation
    ? operatorTurnStatus(conversation, connectionState, selected.isSuccess && selected.failureCount === 0) : ''
  return { entries, attention, connectionState, turnStatus }
}
