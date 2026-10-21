import { Button, Textarea } from '../../../shared/ui/nocturne'
import { useConversationDraftStore } from '../conversationDraftStore'

/** Local editing does not require a readable native snapshot or a newly resolved target. */
export function UnavailableChatDraft({ draftKey, pending, onRefresh }: {
  draftKey: string; pending: boolean; onRefresh(): void
}) {
  const text = useConversationDraftStore(store => store.drafts[draftKey] ?? '')
  const setDraft = useConversationDraftStore(store => store.setDraft)
  return <div className="agent-chat-composer">
    <Textarea label="Message" value={text} rows={3} onChange={event => setDraft(draftKey, event.currentTarget.value)} />
    <p>{pending ? 'Loading the selected chat. Your draft remains editable.'
      : 'The selected chat could not be read. Your draft is kept; refresh its target before sending.'}</p>
    <div className="n-actions"><Button disabled>Send message</Button>
      <Button disabled={pending} onClick={onRefresh}>Refresh selected chat</Button></div>
  </div>
}
