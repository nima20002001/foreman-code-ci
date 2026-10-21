import type { Message, OperatorActivity } from '@foreman-code/contracts'
import type { HarnessOptions } from '@foreman-code/contracts/management'
import { ChatMessageFiles } from '../conversations/ChatMessageFiles'
import { TextTruncationNotice } from '../conversations/TextTruncationNotice'
import { MessageBubble } from '../../shared/ui/nocturne'
import { OperatorActivityList } from './OperatorActivityList'
import { OperatorThinking } from './OperatorThinking'
import { messageTextPartKey, savedTextPartKeys, selectLiveTextTimeline } from '../conversations/chatTimeline'
import type { OperatorTextProjection } from './operatorTextProjection'

/** Allocate activity once over the complete loaded message sequence. */
export function OperatorMessages({ messages, activities, activeRequestId, working = false, partialText = '', thinkingText = '', parts, timeline, modelCatalogs, onBrowse }: {
  messages: Message[]; activities: OperatorActivity[]; activeRequestId?: string | null; working?: boolean;
  partialText?: string; thinkingText?: string; parts?: Record<string, string>; timeline?: OperatorTextProjection; onBrowse(): void;
  modelCatalogs?: Partial<Record<HarnessOptions['harness'], HarnessOptions['models']>>;
}) {
  if (timeline && timeline.requestId === activeRequestId) {
    partialText = selectLiveTextTimeline(messages, activeRequestId, timeline.timeline)
      .filter(item => item.kind === 'text').map(item => item.text).join('\n\n')
  }
  // Reasoning stays at its original position: it follows the nearest earlier
  // ordinary message (or leads the list when none precedes it).
  const leadingReasoning: Message[] = []
  const reasoningAfter = new Map<string, Message[]>()
  let anchorId: string | undefined
  for (const message of messages) {
    if (message.activityChannel !== 'reasoning') { anchorId = message.id; continue }
    if (anchorId === undefined) { leadingReasoning.push(message); continue }
    reasoningAfter.set(anchorId, [...reasoningAfter.get(anchorId) ?? [], message])
  }
  messages = messages.filter((message) => message.activityChannel !== 'reasoning')
  const rows: Array<{ key: string; message?: Message; requestId?: string; live?: boolean; reasoning?: Message }> = []
  for (const message of leadingReasoning) rows.push({ key: message.id, reasoning: message })
  const acceptedModels = new Map<string, NonNullable<Message['acceptedModel']>>()
  for (const message of messages) if (message.requestId && message.acceptedModel) acceptedModels.set(message.requestId, message.acceptedModel)
  const lastAssistant = new Map<string, Message>()
  const assistantCounts = new Map<string, number>()
  for (const message of messages) if (message.role === 'assistant' && message.requestId) lastAssistant.set(message.requestId, message)
  for (const message of messages) {
    const requestId = message.requestId
    const prior = requestId ? assistantCounts.get(requestId) ?? 0 : 0
    rows.push({ key: message.role === 'assistant' && requestId
      ? prior === 0 ? `assistant:${requestId}` : `assistant:${requestId}:${message.id}` : message.id,
      message, requestId })
    for (const entry of reasoningAfter.get(message.id) ?? []) rows.push({ key: entry.id, reasoning: entry })
    if (message.role === 'assistant' && requestId) {
      assistantCounts.set(requestId, prior + 1)
      // Failed/canceled turns have no final assistant reply. Their unassigned
      // activity remains beside this turn, not hidden or moved to a later one.
      if (requestId !== activeRequestId && lastAssistant.get(requestId) === message
        && message.afterActivitySequence !== undefined
        && activities.some((entry) => entry.requestId === requestId && BigInt(entry.sequence) > BigInt(message.afterActivitySequence!))) {
        rows.push({ key: `assistant:${requestId}:tail`, requestId })
      }
    }
    if (message.role === 'user' && requestId && !lastAssistant.has(requestId)
      && (activities.some((entry) => entry.requestId === requestId)
        || requestId === activeRequestId && (working || partialText))) {
      rows.push({ key: `assistant:${requestId}`, requestId, live: requestId === activeRequestId })
    }
  }
  const lastSavedBoundary = activeRequestId ? lastAssistant.get(activeRequestId)?.afterActivitySequence : undefined
  if (activeRequestId && (working || partialText || activities.some((entry) => entry.requestId === activeRequestId
    && (lastSavedBoundary === undefined ? !assistantCounts.has(activeRequestId) : BigInt(entry.sequence) > BigInt(lastSavedBoundary))))
    && !rows.some((row) => row.live && row.requestId === activeRequestId)) {
    rows.push({ key: assistantCounts.has(activeRequestId) ? `assistant:${activeRequestId}:live` : `assistant:${activeRequestId}`,
      requestId: activeRequestId, live: true })
  }
  const lastActivity = new Map<string, bigint>()
  return <ol className="operator-messages" aria-label="Conversation history">
    {rows.map(({ key, message, requestId, live, reasoning }) => {
      if (reasoning) return <li key={key}><OperatorThinking text={reasoning.content} onBrowse={onBrowse} />
        <TextTruncationNotice truncation={reasoning.truncation} /></li>
      const role = message?.role ?? 'assistant'
      const assistant = role === 'assistant'
      const model = message?.acceptedModel ?? (requestId ? acceptedModels.get(requestId) : undefined)
      const author = model ? (model.harness === 'opencode' ? undefined : modelCatalogs?.[model.harness])?.find((entry) => entry.id === model.model)?.name || model.model : 'Assistant'
      const active = Boolean(requestId === activeRequestId && (live || message?.nativeMessageComplete === false))
      const priorActivity = requestId ? lastActivity.get(requestId) ?? -1n : -1n
      const boundary = message?.afterActivitySequence === undefined ? undefined : BigInt(message.afterActivitySequence)
      const entries = assistant ? activities.filter((entry) => entry.requestId === requestId
        && BigInt(entry.sequence) > priorActivity && (live || boundary === undefined || BigInt(entry.sequence) <= boundary)) : []
      if (assistant && requestId) lastActivity.set(requestId,
        boundary ?? entries.reduce((max, entry) => BigInt(entry.sequence) > max ? BigInt(entry.sequence) : max, priorActivity))
      const savedIds = savedTextPartKeys(messages, requestId)
      const nativePartKey = message ? messageTextPartKey(message) : undefined
      const streamed = nativePartKey && message?.nativeMessageComplete === false && active ? parts?.[nativePartKey] : undefined
      const content = streamed !== undefined && (timeline?.finalParts?.[nativePartKey ?? ''] || streamed.startsWith(message?.content ?? '')) ? streamed : message?.content
      let orderedTimeline: OperatorTextProjection['timeline'] | undefined
      if (assistant && timeline && timeline.requestId === requestId && timeline.timeline.length) {
        if (live) {
          const selected = selectLiveTextTimeline(messages, requestId, timeline.timeline)
            .filter(item => item.kind === 'text' || entries.some(entry => entry.id === item.id))
          if (selected.length) orderedTimeline = selected
        }
        else if (content) {
          const nativePart = nativePartKey
          const hasPart = timeline.timeline.some((item) => item.kind === 'text' && item.partId === nativePart)
          const candidate = timeline.timeline.filter((item) => item.kind === 'activity'
            ? entries.some((entry) => entry.id === item.id)
            : hasPart ? item.partId === nativePart : assistantCounts.get(requestId ?? '') === 1)
          if (candidate.filter((item) => item.kind === 'text').map((item) => item.text).join('') === content) orderedTimeline = candidate
        }
      }
      const placed = orderedTimeline ? new Set(orderedTimeline.filter((entry) => entry.kind === 'activity').map((entry) => entry.id)) : undefined
      let truncation = message?.truncation
      if (streamed !== undefined && nativePartKey) truncation = timeline?.truncations?.[nativePartKey] ?? truncation
      if (live && timeline && timeline.requestId === requestId) {
        truncation = Object.entries(timeline.truncations ?? {}).find(([partId, value]) => value.truncated
          && !partId.startsWith('thinking:') && !savedIds.has(partId))?.[1]
      }
      if (!content && !entries.length && !active && !orderedTimeline?.length && !message?.attachments?.length
        && !truncation?.truncated) return null
      return <li key={key} data-message-role={role}>
        <div aria-label={active ? 'Assistant response in progress' : undefined}>
          <MessageBubble author={assistant ? author : role === 'user' ? 'You' : role} role={assistant ? 'assistant' : role === 'user' ? 'user' : 'system'}>
            {assistant ? <>
              <OperatorActivityList entries={placed ? entries.filter((entry) => !placed.has(entry.id)) : entries} activeRequestId={activeRequestId} parts={parts} onBrowse={onBrowse} />
              {live && thinkingText && !entries.some((entry) => entry.kind === 'thinking') ? <OperatorThinking text={thinkingText} onBrowse={onBrowse} /> : null}
              {orderedTimeline ? orderedTimeline.map((item) => item.kind === 'activity'
                ? <OperatorActivityList key={item.id} entries={entries.filter((entry) => entry.id === item.id)} activeRequestId={activeRequestId} parts={parts} onBrowse={onBrowse} />
                : <div className="operator-answer" key={item.id}><p className="conversation-message-content">{item.text}</p></div>) : null}
            </> : null}
            {!orderedTimeline && (content || live && (partialText || working)) ? <div className={assistant ? 'operator-answer' : undefined}>
              {content || live && partialText ? <p className="conversation-message-content">{content || partialText}</p> : null}
              {live && working && !partialText ? <div className="operator-chat-typing" role="status" aria-label="Operator is typing"><span /><span /><span /><span className="n-sr-only">Operator is typing…</span></div> : null}
            </div> : null}
            {orderedTimeline && live && working && !partialText ? <div className="operator-chat-typing" role="status" aria-label="Operator is typing"><span /><span /><span /><span className="n-sr-only">Operator is typing…</span></div> : null}
            {message?.attachments?.length ? <ChatMessageFiles message={message} /> : null}
            <TextTruncationNotice truncation={truncation} />
          </MessageBubble>
        </div>
      </li>
    })}
  </ol>
}
