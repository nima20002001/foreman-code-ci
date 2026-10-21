import { useMemo } from 'react'
import type { Message } from '@foreman-code/contracts'
import { createFileCardHttpClient, MessageFileCards } from '../file-cards'
import { messageAttachmentRefs } from './chatAttachmentAttempt'

/** Persisted message readback only. Neither uploads nor synthetic activity rows become cards. */
export function ChatMessageFiles({ message, workspaceId }: { message: Message; workspaceId?: string }) {
  const conversationId = message.conversationId
  const client = useMemo(() => createFileCardHttpClient({
    download: `${workspaceId === undefined ? '/api/operator' : `/api/workspaces/${encodeURIComponent(workspaceId)}/agent-chat`}/conversations/${encodeURIComponent(conversationId)}/files/{fileId}/revisions/{revisionId}/content`,
  }), [conversationId, workspaceId])
  return <MessageFileCards attachments={messageAttachmentRefs(message)} files={message.attachments ?? []} client={client} />
}
