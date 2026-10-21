import { useId } from 'react'
import { MAX_FILE_RETENTION_SECONDS, MIN_FILE_RETENTION_SECONDS } from '@foreman-code/contracts/files'
import { secondsPerUnit } from './retentionDraft'
import { Button, Checkbox, Dialog, Icon, IconButton, Select, TextField, Tooltip } from '../../shared/ui/nocturne'
import { ApiError } from '../../shared/api/client'
import { useChatRetentionSettings } from './useChatRetentionSettings'
import './retentionSettings.css'

export function ChatRetentionSettings() {
  const validationId = useId()
  const settings = useChatRetentionSettings()
  const { query, form, preview, journal, draft, uncertain, busy, durationSeconds, confirmation } = settings
  const denied = query.isError && ApiError.is(query.error) && (query.error.status === 401 || query.error.status === 403)
  return <section className="chat-retention" aria-label="Chat retention" aria-busy={busy || query.isPending}>
    <header className="chat-retention-heading">
      <h2>Chat retention</h2>
      <Tooltip content="Temporary chat files only. Apply to existing uses each file’s original creation time. Expired files stay expired; project files never expire.">
        <IconButton label="About chat retention" size="sm" variant="ghost"><Icon name="info" size={16} /></IconButton>
      </Tooltip>
    </header>
    {!draft || !form.draft || !journal.ready || denied || journal.error ? <p role={query.isError || journal.error ? 'alert' : 'status'}>
      {journal.error ?? (query.isError ? 'Chat retention is unavailable.' : 'Loading…')}
      {(query.isError || journal.error) && <Button size="sm" onClick={() => void settings.refresh()}>Retry</Button>}
    </p> : <>
      <div className="chat-retention-controls">
        <TextField label="Duration" className="chat-retention-field" type="number" inputMode="decimal" step="any"
          min={MIN_FILE_RETENTION_SECONDS / secondsPerUnit[draft.unit]} max={MAX_FILE_RETENTION_SECONDS / secondsPerUnit[draft.unit]}
          value={draft.amount} disabled={busy || uncertain} aria-invalid={durationSeconds === undefined}
          aria-describedby={durationSeconds === undefined ? validationId : undefined}
          onChange={(event) => settings.edit({ ...draft, amount: event.currentTarget.value })} />
        <Select label="Unit" className="chat-retention-field" options={[{ value: 'hours', label: 'hours' }, { value: 'days', label: 'days' }]}
          value={draft.unit} disabled={busy || uncertain}
          onChange={(event) => settings.edit({ ...draft, unit: event.currentTarget.value === 'hours' ? 'hours' : 'days' })} />
        <Button size="sm" variant="primary" disabled={settings.saveDisabled} loading={busy}
          onClick={() => void settings.requestSave()}>{uncertain ? 'Retry save' : 'Save'}</Button>
      </div>
      <Checkbox label="Apply to existing" checked={draft.applyToExisting} disabled={busy || uncertain}
        onChange={(event) => settings.edit({ ...draft, applyToExisting: event.currentTarget.checked })} />
      {durationSeconds === undefined && <p id={validationId} role="alert">Use 1 hour–365 days.</p>}
      {uncertain ? <p role="alert">Save unconfirmed. Retry safely.</p> : form.conflicted ? <p role="alert">
        Changed elsewhere. Your edit is kept. <Button size="sm" onClick={settings.reapply} disabled={busy || query.isFetching || query.isError}>Use my value</Button>
      </p> : form.error ? <p role="alert">Could not save. Your edit is kept.</p> : null}
      {preview.isError && !form.conflicted && <p role="alert">Could not check existing files.</p>}
      {query.isError && <p role="alert">Could not refresh. <Button size="sm" onClick={() => void settings.refresh()}>Retry</Button></p>}
      {form.savedRevision !== undefined && !query.isError && <p role="status">Saved.</p>}
      <Dialog open={Boolean(confirmation)} onOpenChange={(open) => { if (!open) settings.dismissPreview() }}
        title="Apply to existing?" role="alertdialog" size="sm" busy={busy}
        description={`${confirmation?.expireNowCount ?? 0} ${confirmation?.expireNowCount === 1 ? 'file would' : 'files would'} expire now.`}
        footer={<><Button size="sm" disabled={busy} onClick={settings.dismissPreview}>Cancel</Button>
          <Button size="sm" variant="danger" disabled={busy || query.isFetching || query.isError} onClick={settings.confirm}>Apply and save</Button></>}>
        <Tooltip content="This count is a preview, not a reservation. The count may change before saving.">
          <IconButton label="About this preview" size="sm" variant="ghost"><Icon name="info" size={16} /></IconButton>
        </Tooltip>
      </Dialog>
    </>}
  </section>
}
