import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'
import { Button } from './Button'
import { clamp, cx, type Tone } from './utils'

export function Badge({ children, tone = 'neutral', dot = false, className }: { children: ReactNode; tone?: Tone; dot?: boolean; className?: string }) {
  return <span className={cx('n-badge', className)} data-tone={tone}>{dot && <span className="n-status-dot" aria-hidden="true" />}{children}</span>
}
export function StatusBadge({ label, tone = 'neutral', busy = false }: { label: string; tone?: Tone; busy?: boolean }) {
  return <Badge tone={tone}>{busy ? <span className="n-spinner n-spinner--small" aria-hidden="true" /> : <span className="n-status-dot" aria-hidden="true" />}{label}</Badge>
}
export function Alert({ title, children, tone = 'info', action, live = false }: { title: string; children?: ReactNode; tone?: Tone; action?: ReactNode; live?: boolean }) {
  return <div className="n-alert" data-tone={tone} role={live ? (tone === 'danger' ? 'alert' : 'status') : undefined}>
    <Icon name={tone === 'danger' || tone === 'warning' ? 'warning' : tone === 'success' ? 'check' : 'info'} />
    <div><strong>{title}</strong>{children && <div className="n-alert-description">{children}</div>}</div>{action && <div className="n-alert-action">{action}</div>}
  </div>
}
export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className="n-spinner-label" role="status"><span className="n-spinner" aria-hidden="true" /><span className="n-sr-only">{label}</span></span>
}
export function Skeleton({ width, height = '1rem', circle = false }: { width?: string; height?: string; circle?: boolean }) {
  return <span aria-hidden="true" className={cx('n-skeleton', circle && 'n-skeleton--circle')} style={{ width, height }} />
}
export function LoadingState({ label = 'Loading workspace…', rows = 3 }: { label?: string; rows?: number }) {
  return <div className="n-loading" role="status" aria-busy="true"><span className="n-sr-only">{label}</span>{Array.from({ length: Number.isFinite(rows) ? Math.max(1, Math.min(20, Math.floor(rows))) : 3 }, (_, index) =>
    <div className="n-loading-row" key={index}><Skeleton width="2.5rem" height="2.5rem" circle /><div className="n-stack"><Skeleton width="40%" /><Skeleton width="75%" height=".75rem" /></div></div>)}</div>
}
export function Progress({ label, value, max = 100, tone = 'accent', showValue = true }: { label: string; value?: number; max?: number; tone?: Tone; showValue?: boolean }) {
  const upper = Number.isFinite(max) && max > 0 ? max : 100
  const safe = value === undefined ? undefined : clamp(value, 0, upper)
  return <div className="n-progress" data-tone={tone}><div className="n-between"><span>{label}</span>{showValue && safe !== undefined && <span className="n-mono">{Math.round(safe / upper * 100)}%</span>}</div>
    <progress aria-label={label} value={safe} max={upper} /></div>
}
export function EmptyState({ title, titleHint, description, icon = 'folder', action }: { title: string; titleHint?: ReactNode; description?: string; icon?: IconName; action?: ReactNode }) {
  return <div className="n-empty"><span className="n-empty-icon"><Icon name={icon} size={24} /></span>{titleHint ? <div className="n-field-label"><h3>{title}</h3>{titleHint}</div> : <h3>{title}</h3>}{description && <p>{description}</p>}{action}</div>
}
export function ErrorState({ title = 'Something went wrong', description, onRetry, retrying = false }: { title?: string; description: string; onRetry?: () => void; retrying?: boolean }) {
  return <div className="n-error-state" role="alert"><EmptyState icon="warning" title={title} description={description}
    action={onRetry && <Button onClick={onRetry} loading={retrying} leading={<Icon name="refresh" size={16} />}>Try again</Button>} /></div>
}
export function ConnectionBanner({ state, onRetry, retrying = false }: { state: 'connected' | 'reconnecting' | 'offline'; onRetry?: () => void; retrying?: boolean }) {
  if (state === 'connected') return null
  return <Alert live title={state === 'offline' ? 'Connection lost' : 'Reconnecting…'} tone="warning"
    action={onRetry && <Button size="sm" onClick={onRetry} loading={retrying}>Reconnect</Button>}>
    The last received data is still visible. Actions may be unavailable until the connection returns.
  </Alert>
}
