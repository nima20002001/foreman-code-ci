import { useId, type ReactNode } from 'react'
import { Badge, Alert } from './Feedback'
import { Button } from './Button'
import { Icon } from './Icon'

export function SettingsSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const id = useId()
  return <section className="n-settings-section" aria-labelledby={id}><div className="n-settings-section-heading"><h2 id={id}>{title}</h2>{description && <p>{description}</p>}</div><div className="n-settings-section-body">{children}</div></section>
}
export function SettingRow({ title, description, children, source }: { title: string; description?: string; children: ReactNode; source?: ReactNode }) {
  return <div className="n-setting-row"><div><h3>{title}</h3>{description && <p>{description}</p>}{source}</div><div className="n-setting-control">{children}</div></div>
}
export function InheritedValue({ source, overridden = false, onReset, disabled = false }: { source: string; overridden?: boolean; onReset?: () => void; disabled?: boolean }) {
  return <div className="n-inherited"><Icon name={overridden ? 'settings' : 'workflow'} size={13} /><span>{overridden ? `Overrides ${source}` : `Inherited from ${source}`}</span>
    {overridden && onReset && <Button variant="ghost" size="sm" disabled={disabled} onClick={onReset}>Reset to inherited</Button>}</div>
}
export function SaveBar({ dirty, pending, onSave, onDiscard, error, conflict, disabled = false }: { dirty: boolean; pending?: boolean; onSave: () => void; onDiscard: () => void; error?: string; conflict?: string; disabled?: boolean }) {
  if (!dirty && !error && !conflict) return null
  return <div className="n-save-bar">{conflict && <Alert title="This configuration changed elsewhere" tone="warning" live>{conflict}</Alert>}
    {error && <Alert title="Changes were not saved" tone="danger" live>{error}</Alert>}
    <div className="n-save-bar-row"><span role="status"><span className="n-dirty-dot" aria-hidden="true" />{pending ? 'Saving changes…' : 'You have unsaved changes'}</span>
      <div className="n-actions"><Button disabled={pending} onClick={onDiscard}>Discard</Button><Button variant="primary" loading={pending} disabled={disabled || Boolean(conflict)} onClick={onSave}>Save changes</Button></div></div>
  </div>
}
export function PermissionNotice({ title = 'Read-only access', description = 'You can view this configuration. An authorized operator must make changes.' }: { title?: string; description?: string }) {
  return <Alert title={title} tone="neutral" action={<Badge><Icon name="lock" size={12} />Read only</Badge>}>{description}</Alert>
}
