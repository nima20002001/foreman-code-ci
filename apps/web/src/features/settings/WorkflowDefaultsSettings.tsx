import { WorkflowDefaultsSchema, type WorkflowDefaults } from '@foreman-code/contracts'

import { useUpdateWorkflowDefaultsMutation, useWorkflowDefaultsQuery } from '../../shared/api/query'
import { Alert, Button, LoadingState, Select } from '../../shared/ui/nocturne'
import { fieldMessage } from './fieldValidation'
import { SettingsFormActions, SettingsFormFeedback } from './SettingsFormActions'
import { useSettingsValidation } from './useSettingsValidation'
import { useRevisionedForm } from './revisionedForm'

const approvalOptions = [
  { value: 'orchestrator', label: 'Orchestrator' },
  { value: 'user', label: 'User' },
  { value: 'native', label: 'Native harness' },
] as const

export function WorkflowDefaultsSettings() {
  const query = useWorkflowDefaultsQuery()
  const mutation = useUpdateWorkflowDefaultsMutation()
  const form = useRevisionedForm<WorkflowDefaults>(query.data
    ? { value: query.data.value, revision: query.data.revision } : undefined, 'settings:workflows')
  const root = useSettingsValidation(form.issues)
  const handlerError = fieldMessage(form.issues ?? [], 'approvalHandler')
  const draft = form.draft
  if (query.isError && !draft) return <Alert live tone="danger" title={`Workflow defaults are unavailable. ${query.error.message}`} action={<Button onClick={() => void query.refetch()}>Retry</Button>} />
  if (!draft) return <LoadingState label="Loading workflow defaults…" />
  return <section className="settings-editor-page" aria-label="Workflow defaults">
    {query.isError ? <div className="settings-form-feedback"><Alert live tone="danger" title="The refresh failed. Your draft is preserved." action={<Button onClick={() => void query.refetch()}>Retry refresh</Button>} /></div> : null}
    <SettingsFormFeedback form={form} />
    <div ref={(node) => { root.current = node }} className="settings-editor-content settings-single-column settings-single-column--compact">
      <header className="settings-section-heading"><h2>Approval routing</h2></header>
      <Select label="Approval handler" value={draft.approvalHandler} error={handlerError} options={approvalOptions}
        onChange={(event) => form.setDraft({ approvalHandler: event.target.value as WorkflowDefaults['approvalHandler'] })} />
    </div>
    <SettingsFormActions form={form} saveLabel="Save workflow defaults" onSave={() => form.save(async (input) => {
      const response = await mutation.mutateAsync(input)
      return { value: response.value.value, revision: response.value.revision }
    }, (value) => WorkflowDefaultsSchema.parse(value))} />
  </section>
}
