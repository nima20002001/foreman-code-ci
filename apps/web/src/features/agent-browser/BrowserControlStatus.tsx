import { Button } from '../../shared/ui/nocturne'
import type { BrowserControllerSnapshot } from './types'

export function BrowserControlStatus({ snapshot, viewerId, setup, readOnly, onAcquire, onRelease, onReconnect }: {
  snapshot: BrowserControllerSnapshot; viewerId: string; setup: boolean; readOnly: boolean
  onAcquire(): void; onRelease(): void; onReconnect(): void
}) {
  const control = snapshot.control
  const user = snapshot.notice === 'user' && control.state === 'user' && control.controllingViewerId === viewerId
  const otherUser = control.state === 'user' && control.controllingViewerId !== viewerId
  const label = snapshot.notice === 'denied' ? 'Browser access is unavailable'
    : snapshot.notice === 'taking' ? 'Taking control…'
      : snapshot.notice === 'returning' ? 'Returning control…'
        : snapshot.notice === 'paused' ? 'Browser actions are paused'
          : user ? 'User has control over the browser'
            : otherUser ? 'Another viewer has control over the browser'
              : setup ? 'Browser ready for you — click to continue'
                : control.state === 'agent' ? 'Agent has control over the browser' : 'Browser control is not confirmed'
  return <div className="agent-browser-control">
    <p role="status" aria-live="polite">{label}</p>
    {snapshot.error ? <p role="alert">{snapshot.error}</p> : null}
    {readOnly ? <p>Read-only access: you can watch this browser.</p> : null}
    {!readOnly && !otherUser && snapshot.notice !== 'denied' ? <div className="agent-browser-actions">
      {!user ? <Button size="sm" data-browser-control disabled={snapshot.stale || snapshot.notice === 'taking' || snapshot.notice === 'returning'}
        onClick={onAcquire}>{snapshot.notice === 'paused' || setup ? 'Continue controlling' : 'Take control'}</Button> : null}
      {!setup && (user || snapshot.notice === 'paused' || snapshot.notice === 'returning') ? <Button size="sm" variant="ghost" data-browser-control
        disabled={snapshot.notice === 'returning'} onClick={onRelease}>Return control to agent</Button> : null}
    </div> : null}
    {snapshot.stale && snapshot.notice !== 'denied' ? <Button size="sm" onClick={onReconnect}>Reconnect view</Button> : null}
  </div>
}
