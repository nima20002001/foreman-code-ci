import { WorkspaceFolderPicker } from './WorkspaceFolderPicker'
import { ProtectedAccessError } from '../../shared/ui/ProtectedAccessError'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { WorkspaceDefaultsSchema, type WorkspaceDefaults } from '@foreman-code/contracts/management'
import { Button, ErrorState, LoadingState, TextField, Textarea } from '../../shared/ui/nocturne'
import { useWorkspaceDefaultsQuery, useUpdateWorkspaceDefaultsMutation } from '../../shared/api/settingsExperience'
import { SettingsFormActions, SettingsFormFeedback } from './SettingsFormActions'
import { fieldMessage } from './fieldValidation'
import { useRevisionedForm } from './revisionedForm'
import { useSettingsValidation } from './useSettingsValidation'
import './settingsExperience.css'

export function WorkspaceDefaultsSettings() {
  const query = useWorkspaceDefaultsQuery()
  const mutation = useUpdateWorkspaceDefaultsMutation()
  const form = useRevisionedForm<WorkspaceDefaults>(query.data ? { value: query.data.value, revision: query.data.revision } : undefined, 'settings:workspaces')
  const root = useSettingsValidation(form.issues)
  const accessError = useProtectedAccessError(query, mutation.error)
  if (accessError) return <ProtectedAccessError error={accessError} />
  if (query.isError && !form.draft) return <ErrorState title="Workspace defaults are unavailable" description={query.error.message} onRetry={() => void query.refetch()} />
  const draft = form.draft
  if (!draft) return <LoadingState label="Loading workspace defaults…" />
  return <section ref={root} className="settings-editor-page" aria-label="Workspace defaults">
    <header className="settings-experience-heading"><h1>Workspaces</h1></header>
    <SettingsFormFeedback form={form} />
    {query.isError ? <p role="alert">Could not refresh. Your edits are kept. <Button size="sm" onClick={() => void query.refetch()}>Retry</Button></p> : null}
    <div className="settings-editor-content settings-single-column">
      <TextField label="Suggested workspace name" maxLength={200} value={draft.suggestedName} error={fieldMessage(form.issues ?? [], 'suggestedName')}
        onChange={(event) => form.setDraft({ ...draft, suggestedName: event.target.value })} />
      <Textarea label="Starting description" rows={4} maxLength={10_000} value={draft.description} error={fieldMessage(form.issues ?? [], 'description')}
        placeholder="Optional context for new workspaces" onChange={(event) => form.setDraft({ ...draft, description: event.target.value })} />
      <WorkspaceFolderPicker value={draft.parentPath ?? ''} label="Default location"
        disabled={form.isSaving || form.uncertain} onSelect={(parentPath) => form.setDraft({ ...draft, parentPath })} />
      {fieldMessage(form.issues ?? [], 'parentPath') ? <p role="alert">{fieldMessage(form.issues ?? [], 'parentPath')}</p> : null}
    </div>
    <SettingsFormActions form={form} saveLabel="Save workspace defaults" onSave={() => form.save(async (input) => {
      const response = await mutation.mutateAsync({ ...input, value: WorkspaceDefaultsSchema.parse(input.value) })
      return { value: response.value.value, revision: response.value.revision }
    }, (value) => WorkspaceDefaultsSchema.parse(value))} />
  </section>
}
