import type { ReactNode } from 'react'
import { isApiAccessError } from '../../../shared/api/accessError'
import { Alert, Button, LoadingState } from '../../../shared/ui/nocturne'
import { ConversationViewport } from '../ConversationViewport'
import { UnavailableChatDraft } from '../delivery/UnavailableChatDraft'

/** An unreadable permission endpoint cannot authorize history, but local drafts remain editable. */
export function AgentChatAccessState({ header, pending, error, denial, draftKey, refresh }: {
  header: ReactNode; pending: boolean; error: Error | null; denial?: Error; draftKey: string; refresh(): void
}) {
  const localOnly = !denial && error && !isApiAccessError(error)
  return <div className="agent-conversation">{header}<ConversationViewport revision="access">{() => pending && !denial
    ? <LoadingState label="Checking Agent chat access…" rows={1} /> : localOnly ? <>
    <p role="alert">Chat access could not be checked. Your local draft remains editable.</p>
    <UnavailableChatDraft draftKey={draftKey} pending={false} onRefresh={refresh} />
  </> : <Alert tone="warning" title="Agent chat access unavailable" live>
    <p>{denial?.message ?? error?.message ?? 'Your access does not allow reading chat for this Agent and Run.'}</p>
    <Button size="sm" onClick={refresh}>Refresh access</Button>
  </Alert>}</ConversationViewport></div>
}
