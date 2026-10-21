import { useState, type ReactNode } from 'react'
import { Icon, IconButton } from '../../shared/ui/nocturne'
import './chatNotice.css'

/** A small one-line notice for a real problem. The user can dismiss it; a different message shows again. */
export function ChatNotice({ title, children, action, tone = 'warning', live = false }: {
  title: string; children?: ReactNode; action?: ReactNode; tone?: 'info' | 'warning' | 'danger'; live?: boolean
}) {
  const [dismissed, setDismissed] = useState<string>()
  if (dismissed === title) return null
  return <div className="chat-notice" data-tone={tone} role={live ? 'alert' : 'status'}>
    <p><strong>{title}</strong>{children ? <> {children}</> : null}</p>
    {action ? <span className="chat-notice-actions">{action}</span> : null}
    <IconButton label="Dismiss notice" size="sm" variant="ghost" onClick={() => setDismissed(title)}><Icon name="close" size={14} /></IconButton>
  </div>
}
