import type { OperatorConversationState } from '@foreman-code/contracts'
import { Alert, Button } from '../../shared/ui/nocturne'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { ChatDecisionReceipts } from '../conversations/ChatDecisionReceipts'
import { ProviderAccountProblem } from '../provider-accounts/ProviderAccountChip'
import { OperatorTranscript } from './OperatorTranscript'
import { OperatorApprovalCard } from './OperatorApprovalCard'
import { useOperatorChatStore } from './operatorChatStore'
import type { PartialState } from './operatorChatShared'
import type { useOperatorChatReadback } from './useOperatorChatReadback'
import type { useOperatorConversationMutations } from './useOperatorConversationMutations'

/** Account problems, ended/handoff notices, the transcript and its pending approval card. */
export function OperatorConversationTranscript({ conversation, retired, archived, requestId, selectedId, partial, partialText, thinkingText,
  selected, respond }: {
  conversation: OperatorConversationState
  retired: boolean
  archived: boolean
  requestId: string | null | undefined
  selectedId: string | undefined
  partial: PartialState
  partialText: string
  thinkingText: string
  selected: ReturnType<typeof useOperatorChatReadback>['selected']
  respond: ReturnType<typeof useOperatorConversationMutations>['respond']
}) {
  const select = useOperatorChatStore((state) => state.select)
  return <>
    {!retired ? <ProviderAccountProblem binding={conversation.providerAccountBinding} /> : null}
    {archived ? <Alert tone="warning" title="Conversation ended">This conversation is read-only.</Alert> : null}
    {conversation.handoff ? <p className="operator-chat-handoff">Continued from <Button size="sm" variant="ghost" onClick={() => select(conversation.handoff!.parentConversationId)}>{conversation.handoff.sourceHarness} chat</Button>
      {conversation.handoff.omittedMessages ? ` · ${conversation.handoff.omittedMessages} older messages omitted from agent context` : ''}</p> : null}
    <OperatorTranscript key={conversation.conversation.id} conversationId={conversation.conversation.id} messages={conversation.messages} activities={conversation.activities} activityNextCursor={conversation.activityNextCursor}
      activeRequestId={requestId} parts={partial && partial.conversationId === selectedId ? partial.value?.parts : undefined} partialText={partialText} thinkingText={thinkingText} hasEarlierMessages={conversation.hasEarlierMessages} working={['starting', 'active'].includes(conversation.turnState) && !conversation.pendingInteraction}
      timeline={partial && partial.conversationId === selectedId ? partial.value : undefined}
      approvalRevision={JSON.stringify([requestId, conversation.pendingInteraction, conversation.activitySnapshot?.pendingInteractions, conversation.activitySnapshot?.activities.filter((item) => item.kind === 'interaction')])}
      approval={(onBrowse) => <><ChatDecisionReceipts snapshot={conversation.activitySnapshot} pending={selected.isFetching} onRefresh={() => { void selected.refetch() }} />
        {!retired && requestId && conversation.pendingInteraction ? <OperatorApprovalCard interaction={conversation.pendingInteraction!} onBrowse={onBrowse}
        disabled={Boolean(archived || !conversation.responseAvailability?.available || conversation.responseAvailability && (conversation.responseAvailability.nativeRequestId !== conversation.pendingInteraction?.turn.nativeRequestId || conversation.responseAvailability.nativeSessionId !== conversation.pendingInteraction?.session.nativeSessionId || conversation.responseAvailability.nativeRequestType !== conversation.pendingInteraction?.nativeRequestType) || (respond.isPending && respond.variables?.id === selectedId) || conversation.responseDelivery !== 'offered' || conversation.turnState === 'canceling')}
        onSelect={(optionId, response) => respond.mutate({ id: conversation.conversation.id, generation: sessionGeneration(),
          input: { requestId, nativeRequestId: conversation.pendingInteraction!.turn.nativeRequestId!, optionId,
            ...(response !== undefined ? { response } : {}) } })} /> : null}</>} />
  </>
}
