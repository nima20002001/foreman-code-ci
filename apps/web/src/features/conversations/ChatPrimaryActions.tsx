import type { ReactNode } from 'react'
import { Button, Icon, IconButton } from '../../shared/ui/nocturne'

export function ChatPrimaryActions({ children, onStop, stopLabel = 'Stop chat', stopReason,
  describedBy, appearance = 'button' }: {
  children?: ReactNode
  onStop?: () => void
  stopLabel?: string
  stopReason?: string | undefined
  describedBy?: string
  appearance?: 'button' | 'icon'
}) {
  let stop: ReactNode
  if (onStop && appearance === 'icon') {
    stop = <IconButton label={stopLabel} onClick={onStop} disabled={Boolean(stopReason)} title={stopReason ?? 'Stop this chat and its queued messages'}
      aria-describedby={describedBy} className="operator-composer-send"><Icon name="stop" size={15} /></IconButton>
  } else if (onStop) {
    stop = <Button size="sm" onClick={onStop} disabled={Boolean(stopReason)} title={stopReason ?? 'Stop this chat and its queued messages'}
      aria-describedby={describedBy}>{stopLabel}</Button>
  }
  return <>{stop}{children}</>
}
