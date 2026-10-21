import type { HTMLAttributes, ReactNode } from 'react'
import { cx, type Tone } from './utils'
import { Icon, type IconName } from './Icon'

export function Surface({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cx('n-surface', className)}>{children}</div>
}
export function Card({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cx('n-card', className)}>{children}</div>
}
export function CardHeader({ title, description, action, eyebrow }: { title: string; description?: string; action?: ReactNode; eyebrow?: string }) {
  return <div className="n-card-header"><div>{eyebrow && <p className="n-eyebrow">{eyebrow}</p>}<h3>{title}</h3>{description && <p>{description}</p>}</div>{action}</div>
}
export function CardBody({ children, className }: { children: ReactNode; className?: string }) { return <div className={cx('n-card-body', className)}>{children}</div> }
export function CardFooter({ children }: { children: ReactNode }) { return <div className="n-card-footer">{children}</div> }
export function PageHeader({ title, description, eyebrow, actions, headingLevel = 1 }: { title: string; description?: string; eyebrow?: string; actions?: ReactNode; headingLevel?: 1 | 2 }) {
  const Heading = headingLevel === 2 ? 'h2' : 'h1'
  return <header className="n-page-header"><div>{eyebrow && <p className="n-eyebrow">{eyebrow}</p>}<Heading>{title}</Heading>{description && <p>{description}</p>}</div>{actions && <div className="n-actions">{actions}</div>}</header>
}
/** A semantic grouping, not an ARIA toolbar: children retain normal Tab order. */
export function Toolbar({ children, label }: { children: ReactNode; label: string }) { return <div className="n-toolbar" role="group" aria-label={label}>{children}</div> }
export function Divider() { return <hr className="n-divider" /> }
export function Kbd({ children }: { children: ReactNode }) { return <kbd className="n-kbd">{children}</kbd> }
export function Avatar({ name, size = 'md', tone = 'accent' }: { name: string; size?: 'sm' | 'md' | 'lg'; tone?: Tone }) {
  const initials = Array.from(name.trim().split(/\s+/).slice(0, 2).map((word) => Array.from(word)[0] ?? '').join('')).slice(0, 2).join('').toLocaleUpperCase() || '?'
  return <span className={cx('n-avatar', `n-avatar--${size}`)} data-tone={tone} aria-label={name} role="img">{initials}</span>
}
export function AvatarGroup({ names, max = 4 }: { names: readonly string[]; max?: number }) {
  const count = Math.max(1, Math.floor(max) || 1)
  return <div className="n-avatar-group" aria-label={names.join(', ')} role="img">{names.slice(0, count).map((name, index) => <span aria-hidden="true" key={`${name}-${index}`}><Avatar name={name} size="sm" /></span>)}
    {names.length > count && <span className="n-avatar n-avatar--sm" aria-hidden="true">+{names.length - count}</span>}</div>
}
export function MetricCard({ label, value, note, icon, tone = 'neutral' }: { label: string; value: string | number; note?: string; icon?: IconName; tone?: Tone }) {
  return <div className="n-metric" data-tone={tone}><div><span>{label}</span>{icon && <Icon name={icon} size={17} />}</div><strong>{value}</strong>{note && <small>{note}</small>}</div>
}
