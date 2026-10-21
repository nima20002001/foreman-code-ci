import { memo, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import type { Components } from 'react-markdown'
import type { Message } from '@foreman-code/contracts'
import { useMutation } from '@tanstack/react-query'
import { errorMessage } from '../../../shared/errorMessage'
import { Button, CodeBlock } from '../../../shared/ui/nocturne'
import { TextTruncationNotice } from '../TextTruncationNotice'

const markdownComponents: Components = {
  pre({ node }) {
    const code = node?.children[0]
    if (code?.type !== 'element') return null
    const text = code.children.map(child => child.type === 'text' ? child.value : '').join('')
    const classes = code.properties.className
    const language = Array.isArray(classes)
      ? classes.map(String).find(value => value.startsWith('language-'))?.slice(9) : undefined
    return <CodeBlock code={text.replace(/\n$/, '')} label="Code" language={language ?? 'text'} />
  },
  a({ children, href }) {
    return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
  },
  img({ alt }) {
    return <span>{alt}</span>
  },
}

const AgentMarkdown = memo(function AgentMarkdown({ content }: { content: string }) {
  return <Markdown components={markdownComponents} skipHtml>{content}</Markdown>
})

export function AgentChatMessage({ message, name, status, actions, children, onExpand }: {
  message: Omit<Message, 'conversationId'>
  name: string
  status?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  onExpand?(): Promise<void>
}) {
  const user = message.role === 'user'
  const timestamp = message.createdAt
  const time = timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : undefined
  if (message.role === 'tool') return <details className="agent-chat-tool">
    <summary>Tool output</summary><CodeBlock code={message.content} label="Tool output" />
    <TextTruncationNotice truncation={message.truncation} />{children}
  </details>
  return <article className={`agent-chat-message agent-chat-message--${user ? 'user' : 'agent'}`}
    aria-label={`Message from ${user ? 'You' : name}`} data-message-role={message.role}>
    <div className="conversation-message-content">
      {user ? message.content : <AgentMarkdown content={message.content} />}
    </div>
    <TextTruncationNotice truncation={message.truncation} />
    {message.truncation?.truncated && onExpand ? <MessageExpansion key={`${message.id}:${message.revision}`}
      onExpand={onExpand} /> : null}
    {children}
    <footer className="agent-chat-message-meta">
      {time ? <time dateTime={timestamp} title={new Date(timestamp!).toLocaleString()}>{time}</time> : null}
      {status}{actions}
    </footer>
  </article>
}

function MessageExpansion({ onExpand }: { onExpand(): Promise<void> }) {
  const expansion = useMutation({ mutationFn: onExpand, retry: false })
  return <>
    {!expansion.isSuccess ? <Button size="sm" variant="ghost" disabled={expansion.isPending}
      onClick={() => expansion.mutate()}>{expansion.isPending ? 'Loading full message…' : 'Show full message'}</Button> : null}
    {expansion.isError ? <p role="alert">{errorMessage(expansion.error, 'The full message could not be loaded.')}</p> : null}
  </>
}
