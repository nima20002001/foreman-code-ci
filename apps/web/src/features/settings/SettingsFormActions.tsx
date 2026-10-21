import { useContext, useEffect, useRef, type ReactNode } from 'react'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { Alert, Button } from '../../shared/ui/nocturne'
import { ToastContext } from '../../shared/ui/nocturne/toastContext'
import type { SettingsChange } from './revisionedFormChanges'
import './settingsUsability.css'

interface SettingsFormState {
  isDirty: boolean
  isSaving: boolean
  uncertain: boolean
  conflicted: boolean
  error?: string
  savedRevision?: number
  serverChanges: SettingsChange[]
  localChanges: SettingsChange[]
  reset(): void
  reapply(): void
}

function ChangeList({ title, changes }: { title: string; changes: SettingsChange[] }) {
  return <details><summary>{title} ({changes.length})</summary>
    {changes.map((change) => <div key={change.path}><strong>{change.path}</strong>
      <p>Before</p><pre>{JSON.stringify(change.before, null, 2) ?? '(not set)'}</pre>
      <p>After</p><pre>{JSON.stringify(change.after, null, 2) ?? '(not set)'}</pre>
    </div>)}
  </details>
}

export function SettingsFormFeedback({ form, savedMessage }: {
  form: SettingsFormState; savedMessage?: string;
}) {
  return <>
    {form.conflicted ? <div className="settings-form-feedback settings-defaults-conflict" role="alert">
      <Alert tone="warning" title="These defaults changed elsewhere. Your edits are preserved.">
        <ChangeList title="Changes to current defaults" changes={form.serverChanges} />
        <ChangeList title="Your edits" changes={form.localChanges} />
        <p>Reapplying keeps your changed fields, including whole permission-rule lists, and loads current defaults for untouched fields. Your choices win where both changed. Review them before saving.</p>
        <div className="settings-defaults-conflict-actions">
          <Button disabled={form.isSaving || form.uncertain} onClick={form.reapply}>Reapply my edits to current defaults</Button>
          <Button disabled={form.isSaving || form.uncertain} onClick={form.reset}>Discard edits and load current defaults</Button>
        </div>
      </Alert>
    </div> : null}
    {form.uncertain ? <div className="settings-form-feedback"><Alert live tone="warning" title="The previous save may have committed. Retry resolves that exact command; edits made afterward remain unsaved. Discard and reapply are unavailable until its outcome is known." /></div> : null}
    {form.error && !form.conflicted && !form.uncertain ? <div className="settings-form-feedback"><Alert live tone="danger" title="Changes were not saved">
      {form.error} Your edits are still here.
    </Alert></div> : null}
    {form.savedRevision !== undefined && !form.error && !form.uncertain ? <div className="settings-form-feedback">
      <Alert live tone={form.isDirty ? 'warning' : 'success'} title={form.isDirty ? 'Earlier changes saved' : 'Changes saved to the server'}>
        {form.isDirty ? 'Newer edits are still unsaved.' : savedMessage}
      </Alert>
    </div> : null}
  </>
}

export function SettingsFormActions({ form, onSave, saveLabel = 'Save defaults', extra, canSave = true }: {
  form: SettingsFormState; onSave(): unknown | Promise<unknown>;
  saveLabel?: string; extra?: ReactNode; canSave?: boolean;
}) {
  const save = () => {
    if (!canSave) return false
    return onSave()
  }
  useUnsavedChanges({ label: saveLabel.replace(/^Save /, ''), dirty: form.isDirty, busy: form.isSaving,
    uncertain: form.uncertain, saveDisabled: !canSave || (form.conflicted && !form.uncertain),
    error: form.conflicted ? 'These settings changed elsewhere. Keep editing to review and resolve the conflict.' : form.error,
    save, discard: form.reset })
  const subject = saveLabel.replace(/^Save /, '')
  const subjectTitle = subject.charAt(0).toUpperCase() + subject.slice(1)
  const toasts = useContext(ToastContext)
  const previous = useRef({ revision: form.savedRevision, error: form.error, uncertain: form.uncertain,
    conflicted: form.conflicted, saving: form.isSaving })
  useEffect(() => {
    const before = previous.current
    if (toasts) {
      if (form.uncertain && !before.uncertain) toasts.notify({ tone: 'warning', title: 'Save not confirmed',
        description: 'Retry the original save to learn whether it committed.' })
      else if (form.conflicted && !before.conflicted) toasts.notify({ tone: 'warning', title: `${subjectTitle} changed elsewhere`,
        description: 'Review the changes before saving again.' })
      else if (form.error && !form.conflicted && (form.error !== before.error || before.saving)) {
        toasts.notify({ tone: 'danger', title: `Could not save ${subject}`, description: form.error })
      } else if (form.savedRevision !== undefined && form.savedRevision !== before.revision) {
        toasts.notify({ tone: 'success', title: `${subjectTitle} saved`,
          ...(form.isDirty ? { description: 'Newer edits are still unsaved.' } : {}) })
      }
    }
    previous.current = { revision: form.savedRevision, error: form.error, uncertain: form.uncertain,
      conflicted: form.conflicted, saving: form.isSaving }
  }, [form.savedRevision, form.error, form.uncertain, form.conflicted, form.isSaving, form.isDirty, subject, subjectTitle, toasts])
  if (!canSave) return null
  return <footer className="settings-save-actions">
    {extra ? <div className="settings-footer-options">{extra}</div> : null}
    {form.isDirty && !form.conflicted ? <Button disabled={!form.isDirty || form.isSaving || form.uncertain} onClick={form.reset}>Discard changes</Button> : null}
    <Button variant="primary" aria-label={saveLabel} disabled={form.isSaving || (!form.isDirty && !form.uncertain) || (form.conflicted && !form.uncertain)} onClick={save}>
      {form.isSaving ? 'Saving…' : form.uncertain ? 'Retry original save' : 'Save'}
    </Button>
  </footer>
}
