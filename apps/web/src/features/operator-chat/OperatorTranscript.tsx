import { useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import type { Message, OperatorActivity } from '@foreman-code/contracts'
import { Button, Icon } from '../../shared/ui/nocturne'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { identityEpoch } from '../../shared/api/protectedChatStorage'
import { getOperatorActivity, mergeOperatorActivity } from '../../shared/api/operatorActivity'
import { useNativeHarnessOptions } from '../../shared/api/harnessSettings'
import { OperatorMessages } from './OperatorMessages'
import { OperatorHistory } from './OperatorHistory'
import { HistoryWindowNotice } from '../conversations/HistoryWindowNotice'
import { useChatTurnCompleted } from '../conversations/chatTurnCompletion'
import type { OperatorTextProjection } from './operatorTextProjection'

function AcceptedModelMessages(props: ComponentProps<typeof OperatorMessages>) {
  const harnesses = new Set(props.messages.map((message) => message.acceptedModel?.harness))
  const codex = useNativeHarnessOptions('codex', harnesses.has('codex'))
  const claude = useNativeHarnessOptions('claude', harnesses.has('claude'))
  return <OperatorMessages {...props} modelCatalogs={{ codex: codex.data?.models, claude: claude.data?.models }} />
}

/** Follow meaningful new output, never the identity of a freshly created React element. */
export function OperatorTranscript({ messages, partialText, thinkingText = '', hasEarlierMessages = false, working = false,
  conversationId, activities = [], activityNextCursor, activeRequestId, parts, timeline, approval, approvalRevision }: {
  messages: Message[]; partialText: string; thinkingText?: string; hasEarlierMessages?: boolean; working?: boolean;
  conversationId?: string; activities?: OperatorActivity[]; activityNextCursor?: string | null;
  activeRequestId?: string | null; parts?: Record<string, string>;
  timeline?: OperatorTextProjection;
  approval?: ReactNode | ((onBrowse: () => void) => ReactNode);
  approvalRevision?: string;
}) {
  const client = useQueryClient()
  const turnCompleted = useChatTurnCompleted(conversationId, activeRequestId)
  const activityKey = ['operator-chat', 'activity', conversationId ?? '', identityEpoch()] as const
  const earlierActivity = useInfiniteQuery({
    maxPages: 5, queryKey: activityKey,
    queryFn: ({ pageParam, signal }) => getOperatorActivity(conversationId ?? '', pageParam ? { before: pageParam } : {}, { signal }),
    initialPageParam: activityNextCursor ?? undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: false, retry: false,
  })
  const entries = mergeOperatorActivity(...(earlierActivity.data?.pages.map((page) => page.activities) ?? []), activities)
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const followLatest = useRef(true)
  const [hasNewContent, setHasNewContent] = useState(false)
  const onBrowse = () => { followLatest.current = false }
  const jumpToLatest = () => {
    const scroll = scrollRef.current
    if (scroll) scroll.scrollTop = scroll.scrollHeight
    followLatest.current = true
    setHasNewContent(false)
  }
  // Polling can create new arrays/elements with identical contents. Loading old
  // pages is browsing, not new output, so only the recent stream participates.
  const contentRevision = JSON.stringify([
    messages.map((message) => [message.id, message.content, message.afterActivitySequence, message.nativeMessageComplete, message.attachments]),
    activities.map((entry) => [entry.id, entry.revision]), partialText, thinkingText, timeline?.timeline,
    approvalRevision ?? Boolean(approval),
  ])
  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    if (followLatest.current) { scroll.scrollTop = scroll.scrollHeight; setHasNewContent(false) }
    else setHasNewContent(true)
  }, [contentRevision])
  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !contentRef.current) return
    const observer = new ResizeObserver(() => {
      const scroll = scrollRef.current
      if (scroll && followLatest.current) scroll.scrollTop = scroll.scrollHeight
    })
    observer.observe(contentRef.current)
    if (scrollRef.current) observer.observe(scrollRef.current)
    return () => observer.disconnect()
  }, [])
  const renderMessages = (older: Message[]) => <AcceptedModelMessages messages={[...older, ...messages]} activities={entries}
    activeRequestId={activeRequestId} parts={parts} timeline={timeline} working={working && !turnCompleted} partialText={partialText}
    thinkingText={thinkingText} onBrowse={onBrowse} />
  return <div className="operator-chat-transcript">
    <div ref={scrollRef} className="operator-chat-transcript-scroll" role="region" aria-label="Operator transcript" tabIndex={0}
      onScroll={(event) => {
        const scroll = event.currentTarget
        followLatest.current = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 48
        if (followLatest.current) setHasNewContent(false)
      }}>
      <div ref={contentRef}>
        {earlierActivity.data && earlierActivity.data.pageParams[0] !== (activityNextCursor ?? undefined)
          ? <HistoryWindowNotice pending={earlierActivity.isFetching} onReload={() => {
            onBrowse()
            void client.resetQueries({ queryKey: activityKey, exact: true }).then(() => earlierActivity.fetchNextPage())
          }} /> : null}
        {(activityNextCursor && !earlierActivity.data) || earlierActivity.hasNextPage ? <Button size="sm" variant="ghost" disabled={earlierActivity.isFetching}
          onClick={() => { onBrowse(); void earlierActivity.fetchNextPage() }}>Load earlier activity</Button> : null}
        {earlierActivity.isError ? <p role="alert">Earlier activity could not be loaded. <Button size="sm" onClick={() => { onBrowse(); void earlierActivity.fetchNextPage() }}>Retry activity</Button></p> : null}
        {hasEarlierMessages ? <OperatorHistory conversationId={conversationId} recentMessages={messages} onBrowse={onBrowse}
          renderMessages={renderMessages} /> : renderMessages([])}
        {typeof approval === 'function' ? approval(onBrowse) : approval}
      </div>
    </div>
    {hasNewContent ? <Button size="sm" variant="secondary" className="operator-chat-jump" leading={<Icon name="down" size={14} />} onClick={jumpToLatest}>New output — Jump to latest</Button> : null}
  </div>
}
