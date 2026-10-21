import { useEffect, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { AgentChatContext } from '@foreman-code/contracts/agent-chat'
import { agentChatApi } from '../../../shared/api/agentChat'
import { errorMessage } from '../../../shared/errorMessage'
import type { ConversationAttachments } from '../../attachments'

/**
 * Files upload into an existing conversation. A new Agent chat has none until its first message,
 * so the first picked or dropped file creates the stored conversation (no native session), then
 * the same files are added to the real upload draft once that conversation is read back.
 */
export function useFirstAttachment({ context, executionId, hasConversation, ready, attachments, refresh }: {
  context: AgentChatContext; executionId?: string; hasConversation: boolean; ready: boolean
  attachments: ConversationAttachments; refresh(): void
}) {
  const [waiting, setWaiting] = useState<readonly File[]>()
  const ensure = useMutation({ retry: false, networkMode: 'always',
    mutationFn: () => agentChatApi.ensureConversation(context, executionId),
    onSuccess: refresh, onError: () => setWaiting(undefined) })
  useEffect(() => {
    if (!hasConversation || !waiting || !attachments.available) return
    attachments.addFiles(waiting)
    setWaiting(undefined)
  }, [hasConversation, waiting, attachments])
  if (hasConversation) return { draft: attachments, error: undefined }
  return {
    draft: { ...attachments, canAdd: ready && !ensure.isPending && !waiting,
      addFiles: (files: readonly File[]) => { if (!files.length) return; setWaiting(files); ensure.mutate() } },
    error: ensure.isError ? errorMessage(ensure.error, 'The conversation could not be prepared for files.') : undefined,
  }
}
