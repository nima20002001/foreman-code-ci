import type { ReactNode } from 'react'
import { Icon, IconButton, Tooltip } from '../../../shared/ui/nocturne'

export function AgentChatHeader({ name, state, detail, controls, onClose }: {
  name: string; state: string; detail?: string; controls?: ReactNode; onClose?: () => void
}) {
  const chip = <span className="agent-chat-session-label" data-state={state} role="status" aria-label="Agent state"
    tabIndex={detail ? 0 : undefined}>{state}</span>
  return <header className="agent-chat-header"><nav aria-label={`${name} chat controls`}>
    <div className="agent-chat-identity"><h2>{name}</h2></div>
    {detail ? <Tooltip content={detail}>{chip}</Tooltip> : chip}
    {controls ? <div className="agent-chat-header-controls">{controls}</div> : null}
    {onClose ? <IconButton className="agent-chat-close" label={`Close ${name}`} variant="ghost" onClick={onClose}>
      <Icon name="close" />
    </IconButton> : null}
  </nav></header>
}

export function AgentChatStatus({ children }: { children?: ReactNode }) {
  return children ? <div className="agent-chat-status" role="status">{children}</div> : null
}
