import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Dialog, ConfirmDialog, type DialogProps } from './Overlays'
import { Button } from './Button'
import { Icon } from './Icon'
import { Alert, Badge, EmptyState, Progress } from './Feedback'
import { SearchField, TextField, Textarea, Select, Switch } from './Fields'
import { InheritedValue } from './Settings'
import { displaySetting, matchingSettings, validateSetting, frameAt, type SettingDefinition, type SettingValue } from './advancedUtils'

export interface SettingsDialogProps {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string
  fields: readonly SettingDefinition[]; values: Readonly<Record<string, SettingValue>>
  onValueChange: (id: string, value: SettingValue) => void; onSave: () => void
  onResetField?: (id: string) => void; dirty: boolean; pending?: boolean; readOnly?: boolean
  error?: string; conflict?: string; errors?: Readonly<Record<string, string | undefined>>
  footerNote?: ReactNode
}
/** Search/navigation are local. Drafts, schema, errors, permissions and mutations belong to the feature. */
export function SettingsDialog({ open, onOpenChange, title, description, fields, values, onValueChange, onSave, onResetField, dirty, pending, readOnly, error, conflict, errors = {}, footerNote }: SettingsDialogProps) {
  const [query, setQuery] = useState('')
  const [section, setSection] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  useEffect(() => { if (!open) setDiscardOpen(false) }, [open])
  const id = useId()
  const sections = [...new Set(fields.map(field => field.section))]
  const activeSection = sections.includes(section) ? section : sections[0]
  const matches = matchingSettings(fields, query, advanced)
  const visible = query.trim() ? matches : matches.filter(field => field.section === activeSection)
  const validation = fields.map(field => errors[field.id] ?? validateSetting(field, values[field.id])).filter(Boolean)
  function close() { if (pending) return; if (dirty) setDiscardOpen(true); else onOpenChange(false) }
  return <><Dialog open={open} onOpenChange={next => { if (next) onOpenChange(true); else close() }} title={title} description={description}
    size="xl" className="n-settings-dialog" dismissible={!pending} busy={pending} footer={<>
      <span className="n-modal-footer-note">{pending ? 'Saving…' : dirty ? 'Unsaved changes' : 'All changes saved'}{footerNote}</span>
      <Button disabled={pending} onClick={close}>Close</Button><Button variant="primary" loading={pending} disabled={readOnly || !dirty || Boolean(conflict) || validation.length > 0}
        onClick={() => { if (!pending && !readOnly && dirty && !conflict && validation.length === 0) onSave() }}>Save changes</Button></>}>
      <div className="n-settings-layout"><aside className="n-settings-rail"><p className="n-eyebrow">Configuration</p>
        <nav aria-label="Settings sections">{sections.map(name => <button type="button" key={name} aria-current={!query.trim() && name === activeSection ? 'page' : undefined}
          onClick={() => { setSection(name); setQuery('') }}><Icon name={name.toLowerCase().includes('security') ? 'shield' : 'settings'} size={16} /><span>{name}</span>
          {fields.some(field => field.section === name && (errors[field.id] || validateSetting(field, values[field.id]))) && <span className="n-settings-error-mark" aria-label="Contains errors">!</span>}</button>)}</nav>
        <div className="n-settings-rail-note"><Icon name="workflow" /><p>Global → workspace → workflow → agent</p><small>Inherited values stay visible. Overrides stay explicit.</small></div>
      </aside><div className="n-settings-editor"><div className="n-settings-search"><SearchField label="Search settings" value={query} onChange={event => setQuery(event.currentTarget.value)} placeholder="Find a setting, limit, or permission…" />
        <Switch label="Advanced" checked={advanced} onChange={event => setAdvanced(event.currentTarget.checked)} /></div>
        {conflict && <Alert tone="warning" title="Newer configuration available" live>{conflict} Your draft has been kept.</Alert>}
        {error && <Alert tone="danger" title="Changes were not saved" live>{error}</Alert>}
        {readOnly && <Alert tone="neutral" title="Read-only configuration">Your current permission does not allow editing.</Alert>}
        <div className="n-between"><h3>{query.trim() ? 'Search results' : activeSection ?? 'Settings'}</h3><Badge>{visible.length} settings</Badge></div>
        {validation.length > 0 && <p className="n-field-error" role="status">{validation.length} {validation.length === 1 ? 'field needs' : 'fields need'} attention before saving. Check the marked sections.</p>}
        {!visible.length && <EmptyState title="No settings found" description="Try another search or turn on advanced settings." />}
        {visible.map(field => {
          const value = values[field.id]
          const fieldError = errors[field.id] ?? validateSetting(field, value)
          const disabled = Boolean(pending || readOnly || field.readOnly || field.unavailableReason)
          const change = (next: SettingValue) => { if (!disabled) onValueChange(field.id, next) }
          const shared = { id: `${id}-${field.id}`, label: field.label, hint: field.description, disabled }
          return <div key={field.id} className="n-advanced-setting" data-setting-id={field.id}>
            <div className="n-advanced-setting-meta"><span className="n-eyebrow">{field.section}</span>{field.advanced && <Badge tone="accent">Advanced</Badge>}</div>
            {field.type === 'switch' ? <Switch {...shared} aria-invalid={Boolean(fieldError) || undefined} aria-describedby={fieldError ? `${id}-${field.id}-error` : undefined} checked={value === true} onChange={event => change(event.currentTarget.checked)} /> :
              field.type === 'textarea' ? <Textarea {...shared} value={typeof value === 'string' ? value : ''} error={fieldError} required={field.required} maxLength={field.maxLength} onChange={event => change(event.currentTarget.value)} /> :
              field.type === 'select' ? <Select {...shared} value={typeof value === 'string' ? value : ''} options={[{ value: '', label: 'Select…', disabled: true }, ...(field.options ?? [])]} error={fieldError} required={field.required} onChange={event => change(event.currentTarget.value)} /> :
              <TextField {...shared} type={field.secret ? 'password' : field.type === 'number' ? 'number' : 'text'} autoComplete={field.secret ? 'new-password' : undefined}
                value={typeof value === 'string' ? value : ''} required={field.required} min={field.min} max={field.max} step={field.step} maxLength={field.maxLength} error={fieldError} onChange={event => change(event.currentTarget.value)} />}
            {field.type === 'switch' && fieldError && <p id={`${id}-${field.id}-error`} className="n-field-error">{fieldError}</p>}
            {field.source && <InheritedValue source={field.source} overridden={field.overridden} disabled={disabled} onReset={onResetField ? () => { if (!disabled) onResetField(field.id) } : undefined} />}
            {field.unavailableReason && <p className="n-field-hint"><Icon name="lock" size={12} /> {field.unavailableReason}</p>}
          </div>
        })}
      </div></div>
    </Dialog><ConfirmDialog open={open && discardOpen} onOpenChange={setDiscardOpen} title="Close with unsaved changes?" description="Closing does not save this configuration. Your feature owns whether the draft is retained or discarded."
      confirmLabel="Close without saving" pending={pending} onConfirm={() => { if (!pending) { setDiscardOpen(false); onOpenChange(false) } }} /></>
}

export interface WizardStep { id: string; title: string; description?: string; content: ReactNode; error?: string; canContinue?: boolean }
export function Stepper({ steps, current, onStepChange }: { steps: readonly Pick<WizardStep, 'id' | 'title'>[]; current: number; onStepChange?: (index: number) => void }) {
  const active = frameAt(current, steps.length)
  return <ol className="n-stepper" aria-label="Setup progress">{steps.map((step, index) => <li key={step.id} aria-current={index === active ? 'step' : undefined} data-complete={index < active || undefined}>
    <button type="button" disabled={!onStepChange || index >= active} onClick={() => onStepChange?.(index)}><span>{index < active ? <Icon name="check" size={14} /> : index + 1}</span>{step.title}</button>
  </li>)}</ol>
}
export function WizardDialog({ open, onOpenChange, title, description, steps, current, onStepChange, onComplete, pending, completeLabel = 'Create', error }:
  Pick<DialogProps, 'open' | 'onOpenChange' | 'title' | 'description'> & { steps: readonly WizardStep[]; current: number; onStepChange: (index: number) => void; onComplete: () => void; pending?: boolean; completeLabel?: string; error?: string }) {
  const active = frameAt(current, steps.length)
  const panels = useRef<(HTMLDivElement | null)[]>([])
  const heading = useRef<HTMLHeadingElement>(null)
  const step = steps[active]
  useEffect(() => { if (open) heading.current?.focus() }, [active, open])
  function advance() {
    if (!step || pending || step.canContinue === false || step.error) return
    const fields = panels.current[active]?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,select,textarea')
    if (fields && Array.from(fields).some(field => !field.reportValidity())) return
    if (active < steps.length - 1) onStepChange(active + 1); else onComplete()
  }
  return <Dialog open={open} onOpenChange={onOpenChange} title={title} description={description} size="lg" dismissible={!pending} busy={pending} footer={<>
    <Button disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button><div className="n-spacer" />
    {active > 0 && <Button disabled={pending} onClick={() => onStepChange(active - 1)}>Back</Button>}
    <Button variant="primary" loading={pending} disabled={!step || step.canContinue === false || Boolean(step.error)} onClick={advance}>{active === steps.length - 1 ? completeLabel : 'Continue'}</Button></>}>
    <Stepper steps={steps} current={active} onStepChange={pending ? undefined : onStepChange} />
    <h3 ref={heading} tabIndex={-1} className="n-wizard-title">{step?.title ?? 'No steps available'}</h3>{step?.description && <p className="n-field-hint">{step.description}</p>}
    {steps.map((item, index) => <div key={item.id} hidden={index !== active} ref={element => { panels.current[index] = element }}><fieldset disabled={pending} className="n-plain-fieldset">{item.content}</fieldset>{item.error && <Alert title="Check this step" tone="danger" live>{item.error}</Alert>}</div>)}
    {error && <Alert tone="danger" title="Could not finish" live>{error} Your inputs are still here.</Alert>}
  </Dialog>
}
export interface ChangeItem { id: string; label: string; before?: SettingValue; after?: SettingValue; secret?: boolean }
export function ChangeReview({ changes }: { changes: readonly ChangeItem[] }) {
  return <div className="n-change-review">{changes.length === 0 ? <EmptyState title="Nothing to review" description="There are no proposed changes." /> :
    <table><caption className="n-sr-only">Proposed configuration changes</caption><thead><tr><th scope="col">Setting</th><th scope="col">Current</th><th scope="col">Proposed</th></tr></thead>
      <tbody>{changes.map(change => <tr key={change.id}><th scope="row">{change.label}</th><td><span className="n-change-before">{displaySetting(change.before, change.secret)}</span></td><td><span className="n-change-after">{displaySetting(change.after, change.secret)}</span></td></tr>)}</tbody></table>}</div>
}
export function ReviewChangesDialog({ changes, onApply, pending, error, conflict, canApply = false, ...props }:
  Pick<DialogProps, 'open' | 'onOpenChange' | 'title' | 'description'> & { changes: readonly ChangeItem[]; onApply: () => void; pending?: boolean; error?: string; conflict?: string; canApply?: boolean }) {
  return <Dialog {...props} size="lg" dismissible={!pending} busy={pending} footer={<><Button disabled={pending} onClick={() => props.onOpenChange(false)}>Back</Button><Button variant="primary" loading={pending} disabled={!canApply || Boolean(conflict) || !changes.length}
    onClick={() => { if (canApply && !pending && !conflict && changes.length) onApply() }}>Apply changes</Button></>}>
    {conflict && <Alert tone="warning" title="Configuration conflict" live>{conflict}</Alert>}<ChangeReview changes={changes} />{error && <Alert tone="danger" title="Apply failed" live>{error}</Alert>}
  </Dialog>
}
export function ProgressDialog({ open, onOpenChange, title, description, value, status, steps, onCancel, cancelPending, done = false, error }:
  Pick<DialogProps, 'open' | 'onOpenChange' | 'title' | 'description'> & { value?: number; status: string; steps?: readonly { id: string; label: string; complete: boolean }[]; onCancel?: () => void; cancelPending?: boolean; done?: boolean; error?: string }) {
  return <Dialog open={open} onOpenChange={onOpenChange} title={title} description={description} size="sm" footer={<>
    {!done && onCancel && <Button variant="danger" loading={cancelPending} onClick={onCancel}>Request cancellation</Button>}
    <Button onClick={() => onOpenChange(false)}>{done ? 'Done' : 'Hide progress'}</Button></>}>
    <div className="n-stack"><Progress label={status} value={value} tone={error ? 'danger' : done ? 'success' : 'accent'} />
      <p className="n-field-hint">Hiding this window does not cancel the operation.</p>{steps && <ol className="n-progress-checklist">{steps.map(step => <li key={step.id} data-complete={step.complete}><Icon name={step.complete ? 'check' : 'clock'} size={16} />{step.label}</li>)}</ol>}
      {error && <Alert tone="danger" title="Operation needs attention" live>{error}</Alert>}</div>
  </Dialog>
}
export interface ResourceItem { id: string; title: string; description?: string; meta?: string; disabled?: boolean }
export function ResourcePickerDialog({ open, onOpenChange, title, resources, selectedId, onSelect, onConfirm, pending, error }:
  Pick<DialogProps, 'open' | 'onOpenChange' | 'title'> & { resources: readonly ResourceItem[]; selectedId?: string; onSelect: (id: string) => void; onConfirm: (id: string) => void; pending?: boolean; error?: string }) {
  const [query, setQuery] = useState('')
  const id = useId()
  const selected = resources.find(resource => resource.id === selectedId && !resource.disabled)
  const filtered = resources.filter(resource => `${resource.title} ${resource.description ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
  return <Dialog open={open} onOpenChange={onOpenChange} title={title} size="md" dismissible={!pending} busy={pending} footer={<>
    <Button disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" loading={pending} disabled={!selected}
      onClick={() => { if (selected && !pending) onConfirm(selected.id) }}>Use selected</Button></>}><div className="n-stack">
    <SearchField label="Search resources" value={query} onChange={event => setQuery(event.currentTarget.value)} />
    <fieldset className="n-resource-options" disabled={pending}><legend className="n-sr-only">Choose one resource</legend>{filtered.map(resource => <label key={resource.id} data-selected={selectedId === resource.id}>
      <input type="radio" name={id} disabled={resource.disabled} checked={selectedId === resource.id} onChange={() => onSelect(resource.id)} /><Icon name="folder" />
      <span><strong>{resource.title}</strong><small>{resource.description}</small></span>{resource.meta && <Badge>{resource.meta}</Badge>}</label>)}</fieldset>
    {!filtered.length && <EmptyState title="No matching resources" description="Try a different search. The previous selection is preserved." />}{selected && <p className="n-field-hint">Selected: {selected.title}</p>}
    {error && <Alert title="Selection not applied" tone="danger" live>{error}</Alert>}
  </div></Dialog>
}
