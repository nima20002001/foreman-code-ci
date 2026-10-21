import type { RefObject } from 'react'
import type { OperatorConversationSummary } from '@foreman-code/contracts'
import { Alert, Button, EmptyState, Icon, LoadingState } from '../../shared/ui/nocturne'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { OperatorHistoryActions } from './OperatorHistoryActions'
import { isNarrowOperatorChat, useOperatorChatStore } from './operatorChatStore'
import { operatorNavigationStatus } from './operatorChatStatus'
import { detailKey } from './operatorChatShared'
import type { useOperatorChatReadback } from './useOperatorChatReadback'
import type { useOperatorConversationMutations } from './useOperatorConversationMutations'

export function OperatorChatHistory({ historyOpen, historyId, historyRef, historyTriggerRef, list, entries, selectedId, accessDenied,
  creating, onNewChat, loadOlderChats, remove }: {
  historyOpen: boolean
  historyId: string
  historyRef: RefObject<HTMLElement | null>
  historyTriggerRef: RefObject<HTMLButtonElement | null>
  list: ReturnType<typeof useOperatorChatReadback>['list']
  entries: OperatorConversationSummary[]
  selectedId: string | undefined
  accessDenied: boolean
  creating: boolean
  onNewChat: () => void
  loadOlderChats: () => void
  remove: ReturnType<typeof useOperatorConversationMutations>['remove']
}) {
  const select = useOperatorChatStore((state) => state.select)
  return <aside aria-hidden={!historyOpen} inert={!historyOpen} ref={historyRef} id={historyId} aria-label="Operator conversation history"
    onScroll={(event) => { const node = event.currentTarget; if (node.scrollHeight - node.scrollTop - node.clientHeight < 72) loadOlderChats() }}>
    <Button variant="ghost" className="operator-chat-new" leading={<Icon name="plus" size={14} />} onClick={onNewChat} disabled={creating || accessDenied}>New chat</Button>

    {list.isPending ? <LoadingState label="Loading conversation history…" rows={3} /> : null}
    {list.isError ? <Alert live tone="danger" title={list.data ? 'History refresh failed' : 'Conversation history could not be loaded'} action={<Button size="sm" disabled={list.isFetching} loading={list.isFetching} onClick={() => void list.refetch()}>Retry history</Button>}>{list.data ? 'Previously loaded conversations are still shown.' : 'Try the request again.'}</Alert> : null}
    {list.isSuccess && entries.length === 0 ? <EmptyState icon="history" title="No conversations yet. Start a new chat." /> : null}
    <nav aria-label="Conversations">{entries.map((item) => <div className="operator-chat-row" key={item.conversationId}>
      <Button variant="ghost" className="operator-chat-row-select" aria-current={item.conversationId === selectedId ? 'page' : undefined}
        onClick={() => { select(item.conversationId); if (isNarrowOperatorChat()) historyTriggerRef.current?.focus() }}
        title={`${item.title ?? 'Conversation'} · ${operatorNavigationStatus(item)}`}>
        <span className="operator-chat-title-clip"><span>{item.title ?? 'Conversation'}</span></span>
        <span className={`operator-chat-state-dot${item.needsAttention ? ' needs-attention' : ''}`} aria-label={operatorNavigationStatus(item)} />
      </Button>
      <OperatorHistoryActions summary={item} queryKey={detailKey(item.conversationId)}
        enabled={!accessDenied} removing={remove.isPending}
        onRemove={() => remove.mutate({ id: item.conversationId, title: item.title ?? 'Conversation', generation: sessionGeneration() })} />
    </div>)}</nav>
    {list.data?.hasMore ? <Button size="sm" variant="ghost" className="operator-chat-load-more" loading={list.isFetching} loadingLabel="Loading…" onClick={loadOlderChats}>Load older chats</Button> : null}
  </aside>
}
