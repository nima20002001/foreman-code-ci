import { InfoHint } from '../../shared/ui/InfoHint'
import { CLAUDE_FULL_ACCESS_REQUIRED, ClaudeEffortSchema, type ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'
import { claudeAccessOptions } from './claudeAccess'
import type { HarnessOptions } from '@foreman-code/contracts/management'
import { Alert, Combobox, Select, TextField } from '../../shared/ui/nocturne'
import { fieldMessage, type FieldIssue } from './fieldValidation'
import { useProviderAccounts } from '../provider-accounts/providerAccountsQueries'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import './harnessModelFields.css'

type Props = {
  value: ClaudeHarnessConfiguration
  onChange(value: ClaudeHarnessConfiguration): void
  models: readonly (Pick<HarnessOptions['models'][number], 'id' | 'name'> & Partial<Pick<HarnessOptions['models'][number], 'reasoningEfforts'>>)[]
  qualified: boolean | undefined
  pending?: boolean
  error?: string
  issues?: readonly FieldIssue[]
  accountHost?: DeviceProvisioningTarget['hostRef'] | undefined
}
/** Discovery and saved state are provided by the shared settings query/command owner. */
export function ClaudeConfigurationFields({ value, onChange, models, qualified, pending = false, error, issues = [], accountHost }: Props) {
  const accounts = useProviderAccounts(Boolean(value.accountId), { provider: 'claude',
    ...(accountHost ? { hostRef: accountHost } : {}) })
  const selectedAccount = !accounts.isError ? accounts.data?.accounts.find(account => account.id === value.accountId) : undefined
  const managedAccount = Boolean(value.accountId)
  const options = models.map((model) => ({ value: model.id, label: model.name ?? model.id, description: model.id, disabled: false }))
  const selected = models.find(model => model.id === value.model)
  const efforts = selected?.reasoningEfforts?.filter(effort => ClaudeEffortSchema.safeParse(effort).success) ?? []
  if (!options.some((option) => option.value === value.model)) options.unshift({ value: value.model, label: value.model, description: 'Saved model · awaiting native qualification', disabled: true })
  return <div className="harness-basic-fields">
    <div className="harness-model-settings"><div className="harness-model-fields">
    {models.length ? <Combobox label="Model" value={value.model} options={options} error={fieldMessage(issues, 'model')}
      onValueChange={(model) => { const chosen = models.find(item => item.id === model); if (chosen) onChange({ ...value, model,
        ...(chosen.reasoningEfforts?.includes(value.effort ?? '') ? {} : chosen.reasoningEfforts?.includes('medium') ? { effort: 'medium' } : { effort: undefined }) }) }} />
      : <TextField label="Model" value={value.model} error={fieldMessage(issues, 'model')} labelHint={<InfoHint label="Model">An explicit model choice; saving it does not prove native model availability.</InfoHint>}
        onChange={event => onChange({ ...value, model: event.target.value })} />}
    <Select label="Effort" value={value.effort ?? ''} error={fieldMessage(issues, 'effort')}
      options={[{ value: '', label: 'Native default' }, ...[...new Set([...efforts, ...(value.effort ? [value.effort] : [])])].map(effort => ({
        value: effort, label: efforts.includes(effort) ? effort : `${effort} · saved, unavailable`, disabled: !efforts.includes(effort) }))]}
      onChange={event => onChange({ ...value, effort: event.target.value ? ClaudeEffortSchema.parse(event.target.value) : undefined })} />
    </div></div>
    {!managedAccount ? <TextField label="Local Claude profile directory" value={value.configDirectory} error={fieldMessage(issues, 'configDirectory')}
      labelHint={<InfoHint label="Local Claude profile directory">Sign in on the selected computer using this profile.</InfoHint>}
      onChange={(event) => onChange({ ...value, configDirectory: event.target.value })} />
      : <p>{selectedAccount?.name ?? 'Selected account'} <InfoHint label="Account profile">The selected account controls the Claude profile and authentication.</InfoHint></p>}
    <div className="harness-two-columns">
      {!managedAccount ? <Select label="Authentication" value={value.authMode} error={fieldMessage(issues, 'authMode')}
        options={[{ value: 'subscription', label: 'Local Claude subscription login' }, { value: 'api-key', label: 'Explicit API key · separate billing' }]}
        onChange={(event) => onChange({ ...value, authMode: event.target.value as ClaudeHarnessConfiguration['authMode'] })} /> : null}
      <Select label="Sandbox" value={value.sandbox} error={fieldMessage(issues, 'sandbox') ?? (value.sandbox !== 'danger-full-access' ? CLAUDE_FULL_ACCESS_REQUIRED : undefined)}
        options={claudeAccessOptions(value.sandbox)}
        onChange={(event) => onChange({ ...value, sandbox: event.target.value as ClaudeHarnessConfiguration['sandbox'] })} />
    </div>
    {pending ? <span className="harness-status" role="status">Checking the selected Claude configuration…</span> : null}
    {error ? <Alert tone="danger" live title={error} /> : qualified === false && !pending ? <Alert tone="warning" title="Claude profile is not verified">Check the saved profile in computer settings.</Alert> : null}
  </div>
}
