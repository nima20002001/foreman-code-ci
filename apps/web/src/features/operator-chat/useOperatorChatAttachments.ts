import { useQuery } from '@tanstack/react-query'
import type { OperatorConversationState } from '@foreman-code/contracts'
import { LocalHumanAccessSchema } from '@foreman-code/contracts/management'
import { useConversationAttachments } from '../attachments'
import { settingsExperienceKeys } from '../../shared/api/settingsExperience'
import { apiClient } from '../../shared/api/client'
import type { useOperatorAttachmentReceipts } from './useOperatorAttachmentReceipts'

export function useOperatorChatAttachments({ enabled, selectedId, accessDenied, selectedData, attachmentReceipts }: {
  enabled: boolean
  selectedId: string | undefined
  accessDenied: boolean
  selectedData: OperatorConversationState | undefined
  attachmentReceipts: ReturnType<typeof useOperatorAttachmentReceipts>
}) {
  const browserAccess = useQuery({ queryKey: settingsExperienceKeys.access(), enabled: false,
    queryFn: ({ signal }) => apiClient.request('/api/local-human', LocalHumanAccessSchema, { signal }),
  })
  const fileConversation = selectedId && !accessDenied && selectedData?.conversation.id === selectedId ? selectedData.conversation : undefined
  const owner = !browserAccess.isError && browserAccess.data?.principal
  const attachments = useConversationAttachments(enabled && fileConversation?.scope === 'application' && owner
    && Date.parse(owner.expiresAt) > Date.now() ? { kind: 'temporary', chat: { kind: 'operator',
      conversationId: fileConversation.id, operatorId: fileConversation.agentId, ownerPrincipalId: owner.id,
    } } : null)
  const attachmentReceiptPending = Boolean(selectedId && attachmentReceipts.blocksSend(selectedId, attachments.readyRefs))
  return { attachments, attachmentReceiptPending }
}
