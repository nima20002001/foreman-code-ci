import type { RefObject } from 'react'
import type { OperatorConversationSummary } from '@foreman-code/contracts'
import { Badge, Icon, IconButton } from '../../shared/ui/nocturne'
import { useOperatorChatStore } from './operatorChatStore'

export function OperatorChatLauncher({ launcherRef, open, closing, panelId, attention, settingsWarning, listFailed }: {
  launcherRef: RefObject<HTMLButtonElement | null>
  open: boolean
  closing: boolean
  panelId: string
  attention: OperatorConversationSummary[]
  settingsWarning: string | undefined
  listFailed: boolean
}) {
  const setOpen = useOperatorChatStore((state) => state.setOpen)
  const select = useOperatorChatStore((state) => state.select)
  return <IconButton ref={launcherRef} className="operator-chat-launcher" variant="primary" label={attention.length ? `Open Operator chat, ${attention.length} conversation${attention.length === 1 ? '' : 's'} need your decision` : 'Open Operator chat'} hidden={open || closing}
    aria-expanded={open} aria-controls={open ? panelId : undefined} aria-haspopup="dialog"
    aria-description={settingsWarning ?? (listFailed ? 'Conversation status may be stale.' : undefined)}
    title={settingsWarning ?? (listFailed ? 'Conversation status may be stale' : 'Open Operator chat')}
    onClick={() => { if (attention[0]) select(attention[0].conversationId); setOpen(true) }}><Icon name="bot" />
    {attention.length ? <Badge tone="warning" className="operator-chat-badge" aria-hidden="true">{attention.length}</Badge> : null}
    {settingsWarning || listFailed ? <Badge tone="warning" className="operator-chat-connection-badge" aria-label="Connection warning">!</Badge> : null}
  </IconButton>
}
