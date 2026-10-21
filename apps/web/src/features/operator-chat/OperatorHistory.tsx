import type { ReactNode } from 'react'
import type { Message } from '@foreman-code/contracts'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { getOperatorConversationHistory } from '../../shared/api/operatorChatHistory'
import { identityChangedEvent, identityEpoch } from '../../shared/api/protectedChatStorage'
import { sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { Button } from '../../shared/ui/nocturne'
import { mergeChatMessages } from '../conversations/agentChat/model'
import { ConversationHistory } from '../conversations'
import { HistoryWindowNotice } from '../conversations/HistoryWindowNotice'
import { useOperatorChatStore } from './operatorChatStore'

function subscribeIdentity(listener: () => void) {
  window.addEventListener(identityChangedEvent, listener)
  return () => window.removeEventListener(identityChangedEvent, listener)
}

/** This is server state, not an outbox. Session changes still erase local plaintext. */
export function OperatorHistory({ conversationId, onBrowse, recentMessages = [], renderMessages }: { conversationId?: string; onBrowse?: () => void; recentMessages?: Message[]; renderMessages?: (messages: Message[]) => ReactNode }) {
  const selectedId = useOperatorChatStore((state) => state.selectedConversationId)
  const id = conversationId ?? selectedId
  const epoch = useSyncExternalStore(subscribeIdentity, identityEpoch, () => 'server')
  if (sessionIsSwitching()) return null
  if (!id) return renderMessages?.([]) ?? null
  return <OwnedHistory key={`${epoch}:${id}`} id={id} epoch={epoch} onBrowse={onBrowse} recentMessages={recentMessages} renderMessages={renderMessages} />
}

function OwnedHistory({ id, epoch, onBrowse, recentMessages, renderMessages }: { id: string; epoch: string; onBrowse: (() => void) | undefined; recentMessages: Message[]; renderMessages: ((messages: Message[]) => ReactNode) | undefined }) {
  const [open, setOpen] = useState(false)
  const client = useQueryClient()
  const key = ['operator-chat', 'history', epoch, id] as const
  const history = useInfiniteQuery({
    queryKey: key, maxPages: 5,
    queryFn: ({ pageParam, signal }) => getOperatorConversationHistory(id, pageParam ? { before: pageParam } : {}, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: open,
    retry: false,
  })
  useEffect(() => {
    // Immediately discard old-owner pages, including when identity changes in
    // another tab. The shared HTTP boundary also rejects late responses.
    const clear = () => {
      const queryKey = ['operator-chat', 'history', epoch, id]
      void client.cancelQueries({ queryKey })
      client.removeQueries({ queryKey })
    }
    window.addEventListener(identityChangedEvent, clear)
    return () => { window.removeEventListener(identityChangedEvent, clear); clear() }
  }, [client, epoch, id])

  const recentIds = new Set(recentMessages.map((message) => message.id))
  const messages = mergeChatMessages(...[...(history.data?.pages ?? [])].reverse().map((page) => page.entries.map((entry) => entry.message)), recentMessages)
    .filter((message) => !recentIds.has(message.id))
  const reloadNearer = () => {
    onBrowse?.()
    client.setQueryData<NonNullable<typeof history.data>>(key, { pages: [], pageParams: [] })
    void history.refetch()
  }
  return <section aria-label="Earlier messages">
    {history.data && history.data.pageParams[0] !== undefined ? <HistoryWindowNotice pending={history.isFetching}
      onReload={reloadNearer} /> : null}
    {!open || history.hasNextPage ? <Button size="sm" variant="ghost" disabled={open && history.isFetching}
      onClick={() => { onBrowse?.(); if (!open) setOpen(true); else void history.fetchNextPage() }}>
      {history.isFetching ? 'Loading…' : 'Load earlier messages'}
    </Button> : null}
    {history.isError ? <p role="alert">Earlier messages could not be loaded. <Button size="sm" onClick={() => void history.refetch()}>Retry history</Button></p> : null}
    {renderMessages ? renderMessages(messages) : messages.length ? <ConversationHistory messages={messages} /> : null}
  </section>
}
