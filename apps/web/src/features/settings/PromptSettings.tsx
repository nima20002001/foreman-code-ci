import { InfoHint } from '../../shared/ui/InfoHint'
import { PromptTextSchema, type PromptText } from '@foreman-code/contracts/management'
import {
  usePromptSettingQuery,
  useUpdatePromptSettingMutation,
  type PromptSettingsPage,
} from '../../shared/api/promptSettings'
import { useLocalHumanAccessQuery } from '../../shared/api/settingsExperience'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { ProtectedAccessError } from '../../shared/ui/ProtectedAccessError'
import { Alert, Button, ErrorState, LoadingState, Textarea } from '../../shared/ui/nocturne'
import { fieldMessage } from './fieldValidation'
import { SettingsFormActions } from './SettingsFormActions'
import { useRevisionedForm } from './revisionedForm'
import './settingsExperience.css'
import './settingsHelp.css'

const presentation = {
  'system-prompt': {
    title: 'System prompt',
    label: 'System prompt',
    help: 'Newly started Agent sessions will use this revision.',
  },
  'operator-initial-prompt': {
    title: 'Operator',
    label: 'Initial prompt',
    help: 'New Operator conversations will use this revision.',
  },
}

export function PromptSettings({ page, onBack }: { page: PromptSettingsPage; onBack?(): void }) {
  const query = usePromptSettingQuery(page)
  const mutation = useUpdatePromptSettingMutation(page)
  const access = useLocalHumanAccessQuery()
  const form = useRevisionedForm<PromptText>(query.data, `settings:${page}`)
  const promptAccessError = useProtectedAccessError(query, mutation.error)
  const localAccessError = useProtectedAccessError(access)
  const info = presentation[page]
  const canEdit = Boolean(access.isSuccess && Date.parse(access.data.principal.expiresAt) > Date.now()
    && access.data.principal.grants.some(grant => grant.actions.includes('settings:update')
      && !grant.scope.workspaceIds && !grant.scope.workflowIds && !grant.scope.runIds))
  const accessError = promptAccessError ?? localAccessError
  const actions = <SettingsFormActions form={form} canSave={canEdit && !accessError}
    saveLabel={`Save ${info.label.toLowerCase()}`}
    onSave={() => form.save(async input => {
      const response = await mutation.mutateAsync(input)
      return response.value
    }, value => PromptTextSchema.parse(value))} />
  if (accessError) return <><ProtectedAccessError error={accessError} />{actions}</>
  if (query.isError && !form.draft) return <ErrorState title={`${info.label} is unavailable`}
    description={query.error.message} onRetry={() => void query.refetch()} />
  const draft = form.draft
  if (!draft) return <LoadingState label={`Loading ${info.label.toLowerCase()}…`} />

  return <section className="settings-editor-page" aria-label={`${info.label} settings`}>
    <header className="settings-experience-heading">
      {onBack ? <Button size="sm" onClick={onBack}>Back to Agents</Button> : null}
      <h1>{info.title}</h1>
      <p>Saved revision: {query.data?.revision ?? form.baseRevision}</p>
    </header>
    {query.isError ? <Alert tone="warning" title="Could not refresh the saved prompt. Your edits are kept." /> : null}
    {access.isError ? <Alert tone="warning" title="Could not verify editing access.">
      <Button size="sm" onClick={() => void access.refetch()}>Retry access check</Button>
    </Alert> : null}
    {form.conflicted ? <Alert tone="warning" title="This prompt changed elsewhere. Your edits are preserved.">
      <details><summary>Current saved prompt</summary><pre>{query.data?.value.text}</pre></details>
      <p>Review the saved prompt, then choose which text to keep before saving.</p>
      <Button disabled={!canEdit || form.uncertain} onClick={form.reapply}>Keep my text with the current revision</Button>
      <Button disabled={form.uncertain} onClick={form.reset}>Discard edits and load saved prompt</Button>
    </Alert> : null}
    {form.uncertain ? <Alert live tone="warning" title="Save not confirmed">
      Retry the original save to learn whether it committed. Your edits are kept.
    </Alert> : null}
    {form.error && !form.conflicted && !form.uncertain ? <Alert live tone="danger" title="Prompt was not saved">
      {form.error} Your edits are still here.
    </Alert> : null}
    {form.savedRevision !== undefined && !form.error ? <Alert live tone="success" title="Prompt saved" /> : null}
    <div className="settings-editor-content settings-single-column">
      <div className="settings-field-help"><Textarea label={info.label} rows={12} value={draft.text} maxLength={PromptTextSchema.shape.text.maxLength ?? undefined}
        readOnly={!canEdit} disabled={form.isSaving || form.uncertain}
        error={fieldMessage(form.issues ?? [], 'text')}
        onChange={event => form.setDraft({ text: event.target.value })} />
        <InfoHint label={info.label}>{info.help}</InfoHint></div>
      {!canEdit && !access.isPending ? <p role="status">You have read-only access to this prompt.</p> : null}
    </div>
    <Button size="sm" disabled={query.isFetching || form.isSaving || form.uncertain}
      onClick={() => void query.refetch()}>Refresh saved prompt</Button>
    {actions}
  </section>
}
