import { useId, useRef, useState, type ReactNode } from 'react'
import { Button, IconButton } from './Button'
import { Icon } from './Icon'
import { Badge, EmptyState, Alert } from './Feedback'
import { SearchField, Checkbox } from './Fields'
import { fileSelectionErrors } from './advancedUtils'
import { type Tone } from './utils'
import { useFileDrop } from '../useFileDrop'

export function FilterChips({ filters, onRemove, onClear }: { filters: readonly { id: string; label: string }[]; onRemove: (id: string) => void; onClear?: () => void }) {
  if (!filters.length) return null
  return <div className="n-filter-chips" aria-label="Active filters">{filters.map(filter => <button key={filter.id} type="button" aria-label={`Remove filter: ${filter.label}`} onClick={() => onRemove(filter.id)}>{filter.label}<Icon name="close" size={12} /></button>)}
    {onClear && <Button variant="ghost" size="sm" onClick={onClear}>Clear filters</Button>}</div>
}
export function MultiSelect({ label, options, values, onValuesChange, disabled, hint, error }: {
  label: string; options: readonly { value: string; label: string; disabled?: boolean }[]; values: readonly string[]; onValuesChange: (values: string[]) => void; disabled?: boolean; hint?: string; error?: string
}) {
  const [query, setQuery] = useState('')
  const id = useId()
  const visible = options.filter(option => option.label.toLowerCase().includes(query.trim().toLowerCase()))
  return <fieldset className="n-multi-select" disabled={disabled} aria-describedby={hint || error ? `${id}-note` : undefined}><legend>{label}<Badge>{values.length} selected</Badge></legend>
    {(hint || error) && <p id={`${id}-note`} className={error ? 'n-field-error' : 'n-field-hint'}>{error ?? hint}</p>}
    <SearchField label={`Search ${label.toLowerCase()}`} value={query} onChange={event => setQuery(event.currentTarget.value)} />
    <div className="n-multi-select-options">{visible.map(option => <Checkbox key={option.value} label={option.label} disabled={option.disabled} checked={values.includes(option.value)}
      onChange={event => onValuesChange(event.currentTarget.checked ? [...new Set([...values, option.value])] : values.filter(value => value !== option.value))} />)}
      {!visible.length && <p role="status" className="n-field-hint">No matching options. Existing selections are kept.</p>}</div>
  </fieldset>
}
export function FileDropzone({ label = 'Add context files', onFiles, disabled = false, maxFiles = 5, maxBytes = 5 * 1024 * 1024, extensions = ['.txt', '.md', '.json'], hint }:
  { label?: string; onFiles: (files: readonly File[]) => void; disabled?: boolean; maxFiles?: number; maxBytes?: number; extensions?: readonly string[]; hint?: string }) {
  const [errors, setErrors] = useState<string[]>([])
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  function accept(list: FileList | readonly File[] | null) {
    if (disabled || !list?.length) return
    const files = Array.from(list)
    const failures = fileSelectionErrors(files, maxFiles, maxBytes, extensions)
    setErrors(failures)
    if (!failures.length) onFiles(files)
    if (input.current) input.current.value = ''
  }
  const drop = useFileDrop({ disabled, onFiles: accept })
  return <div className="n-stack"><div className="n-dropzone" data-dragging={drop.isDragging || undefined} aria-disabled={disabled}
    {...drop.dropTargetProps}>
    <Icon name="folder" size={28} /><h3>{label}</h3><p id={`${id}-hint`}>{hint ?? `Choose or drop up to ${maxFiles} files. Each file must be ${Math.round(maxBytes / 1024)} KB or smaller.`}</p>
    <Button disabled={disabled} onClick={() => input.current?.click()}>Choose files</Button><input ref={input} id={id} className="n-sr-only" type="file" aria-label={label} aria-describedby={`${id}-hint`} disabled={disabled}
      multiple={maxFiles > 1} accept={extensions.join(',')} onChange={event => { drop.clearDropError(); accept(event.currentTarget.files) }} />
    <small>Selection only. No upload or execution happens here.</small>
  </div>{drop.dropError && <Alert tone="danger" title="Files were not added" live>{drop.dropError}</Alert>}
    {errors.length > 0 && <Alert tone="danger" title="Files were not added" live><ul>{errors.map((error, index) => <li key={index}>{error}</li>)}</ul></Alert>}</div>
}
export interface NotificationItem { id: string; title: string; description: string; time: string; dateTime?: string; unread?: boolean; tone?: Tone; actionLabel?: string }
export function NotificationCenter({ items, onRead, onOpen, onClearRead }: { items: readonly NotificationItem[]; onRead: (id: string) => void; onOpen?: (id: string) => void; onClearRead?: () => void }) {
  const [unreadOnly, setUnreadOnly] = useState(false)
  const visible = items.filter(item => !unreadOnly || item.unread)
  return <section className="n-notification-center"><div className="n-between"><h3>Notifications <Badge>{items.filter(item => item.unread).length} unread</Badge></h3>
    {onClearRead && <Button size="sm" variant="ghost" onClick={onClearRead} disabled={!items.some(item => !item.unread)}>Clear read</Button>}</div>
    <Checkbox label="Unread only" checked={unreadOnly} onChange={event => setUnreadOnly(event.currentTarget.checked)} />
    {!visible.length && <EmptyState title="You’re all caught up" description="No notifications match this view." />}
    <ol>{visible.map(item => <li key={item.id} data-unread={item.unread || undefined} data-tone={item.tone ?? 'neutral'}><Icon name={item.tone === 'warning' ? 'shield' : item.tone === 'danger' ? 'warning' : 'bell'} size={18} />
      <div><strong>{item.title}</strong><p>{item.description}</p><time dateTime={item.dateTime}>{item.time}</time>{item.actionLabel && onOpen && <Button size="sm" variant="ghost" onClick={() => onOpen(item.id)}>{item.actionLabel}</Button>}</div>
      {item.unread && <IconButton label={`Mark as read: ${item.title}`} variant="ghost" size="sm" onClick={() => onRead(item.id)}><Icon name="check" size={14} /></IconButton>}</li>)}</ol>
  </section>
}
export function PermissionMatrix({ rows, canEdit = false, pending = false, onChange }: {
  rows: readonly { id: string; resource: string; scope: string; allowed: boolean; locked?: boolean; reason?: string }[];
  canEdit?: boolean; pending?: boolean; onChange?: (id: string, allowed: boolean) => void
}) {
  return <div className="n-permission-matrix"><table><caption>Effective permissions</caption><thead><tr><th scope="col">Capability</th><th scope="col">Scope</th><th scope="col">Access</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}>
    <th scope="row">{row.resource}{row.reason && <small>{row.reason}</small>}</th><td>{row.scope}</td><td>{onChange && canEdit ? <Checkbox label={row.resource} checked={row.allowed} disabled={row.locked || pending}
      onChange={event => { if (!row.locked && !pending) onChange(row.id, event.currentTarget.checked) }} /> : <Badge tone={row.allowed ? 'success' : 'neutral'}>{row.allowed ? 'Allowed' : 'Not allowed'}</Badge>}</td></tr>)}</tbody></table>
    <p className="n-field-hint">The server and harness enforce access. These controls cannot grant permissions by themselves.</p>
  </div>
}
export function KeyboardShortcuts({ groups }: { groups: readonly { title: string; shortcuts: readonly { label: string; keys: readonly string[] }[] }[] }) {
  return <div className="n-shortcuts">{groups.map(group => <section key={group.title}><h3>{group.title}</h3><dl>{group.shortcuts.map(shortcut => <div key={shortcut.label}><dt>{shortcut.label}</dt><dd>{shortcut.keys.map((key, index) => <kbd key={index}>{key}</kbd>)}</dd></div>)}</dl></section>)}</div>
}
export function DetailSection({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <section className="n-detail-section"><div className="n-between"><h3>{title}</h3>{action}</div>{children}</section>
}
