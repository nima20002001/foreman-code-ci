import type { ReactNode } from 'react'
import type { Message } from '@foreman-code/contracts'
import { EmptyState, MessageBubble } from '../../shared/ui/nocturne'
import './conversationHistory.css'
import { TextTruncationNotice } from './TextTruncationNotice'

export interface ConversationHistoryProps {
  messages: Message[]
  assistantName?: string
  /** Independently keyed siblings, never children of a message whose identity can change. */
  interleaved?: readonly { key: string; beforeMessageId: string | undefined; content: ReactNode }[]
  renderBefore?: (message: Message) => ReactNode
  renderAfter?: (message: Message) => ReactNode
  renderStatus?: (message: Message) => ReactNode
  renderActions?: (message: Message) => ReactNode
}

export function ConversationHistory({ messages, assistantName = 'Assistant', interleaved = [], renderBefore, renderAfter, renderStatus, renderActions }: ConversationHistoryProps) {
  if (messages.length === 0 && interleaved.length === 0) {
    return <div data-testid="conversation-empty"><EmptyState icon="history" title="No conversation history yet" /></div>
  }

  const renderInterleaved = (item: (typeof interleaved)[number]) => <li key={`interleaved:${item.key}`} className="conversation-history-interleaved">{item.content}</li>
  // One flat keyed array is essential: separate before/after arrays or message
  // fragments would give the same activity a different reconciliation parent.
  return (
    <ol aria-label="Conversation history">
      {[
        ...messages.flatMap((message) => [
          ...interleaved.filter((item) => item.beforeMessageId === message.id).map(renderInterleaved),
          <li key={`message:${message.id}`} data-message-role={message.role}>
            {renderBefore?.(message)}
            <MessageBubble
              author={message.role === 'assistant' ? assistantName : message.role === 'user' ? 'You' : message.role}
              role={message.role === 'assistant' || message.role === 'user' ? message.role : 'system'}
              status={renderStatus?.(message)}
              actions={renderActions?.(message)}
            >
              <p className="conversation-message-content">{message.content}</p>
              <TextTruncationNotice truncation={message.truncation} />
            </MessageBubble>
            {renderAfter?.(message)}
          </li>,
        ]),
        ...interleaved.filter((item) => item.beforeMessageId === undefined).map(renderInterleaved),
      ]}
    </ol>
  )
}
