import { useEffect, useMemo, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { AttachmentClient } from './attachmentClient'
import { AttachmentDraftContext } from './attachmentContext'
import { createAttachmentDrafts } from './attachmentDrafts'

/** Mount inside QueryClientProvider, outside conversation-keyed composers; remount on login changes. */
export function AttachmentDraftProvider({ client, children }: { client: AttachmentClient; children: ReactNode }) {
  const queryClient = useQueryClient()
  const drafts = useMemo(() => createAttachmentDrafts(queryClient, client), [queryClient, client])
  useEffect(() => drafts.retain(), [drafts])
  return <AttachmentDraftContext.Provider value={drafts}>{children}</AttachmentDraftContext.Provider>
}
