import { useEffect, useState, type ComponentProps } from 'react'
import { Alert, Icon, IconButton } from '../../../shared/ui/nocturne'

export function BoardNotice({ noticeKey, action, ...props }: ComponentProps<typeof Alert> & { noticeKey?: unknown }) {
  const identity = noticeKey ?? props.title
  const [dismissed, setDismissed] = useState<unknown>()
  const [closing, setClosing] = useState<unknown>()
  useEffect(() => {
    const timer = window.setTimeout(() => setClosing(identity), 4000)
    return () => window.clearTimeout(timer)
  }, [identity])
  useEffect(() => {
    if (closing !== identity) return
    const timer = window.setTimeout(() => setDismissed(identity), 180)
    return () => window.clearTimeout(timer)
  }, [closing, identity])
  if (dismissed === identity) return null
  return <div className="board-notice" data-closing={closing === identity}><Alert {...props} action={<>{action}<IconButton size="sm" variant="ghost" label="Dismiss notification"
    onClick={() => setClosing(identity)}><Icon name="close" size={14} /></IconButton></>} /></div>
}
