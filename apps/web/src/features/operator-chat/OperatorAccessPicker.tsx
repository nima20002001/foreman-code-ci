import { InfoHint } from '../../shared/ui/InfoHint'
import { retiredHarnessLabel } from '../settings/settingsPresentation'
import { changeCodexSandbox, withAdvancedDefaults, type HarnessConfiguration } from '@foreman-code/contracts'
import { Select } from '../../shared/ui/nocturne'
import { CLAUDE_FULL_ACCESS_REQUIRED } from '@foreman-code/contracts/claude'
import { claudeAccessOptions } from '../settings/claudeAccess'

const sandboxChoices = [
  { value: 'read-only', label: 'Read only' },
  { value: 'workspace-write', label: 'Workspace write' },
  { value: 'danger-full-access', label: 'Full access' },
] as const
/** Access shares the agent dialog and revisioned Operator defaults. */
function EditableOperatorAccessPicker({ value, disabled, saving = false, saveError, onChange }: {
  value: HarnessConfiguration; disabled: boolean; saving?: boolean; saveError?: string
  onChange(value: HarnessConfiguration): Promise<boolean>
}) {
  return <div className="operator-access-inline" role="group" aria-label="Operator access">
    <div className="n-field-label">Operator access<InfoHint label="Operator access">Access changes apply to new chats and harness handoffs. Existing chats keep their accepted access policy.</InfoHint></div>
    {saving ? <small role="status">Saving Operator access…</small> : null}
    {saveError ? <p role="alert">{saveError}</p> : null}
    {value.harness === 'codex' || value.harness === 'claude' ? <Select label="Sandbox" value={value.sandbox}
      options={value.harness === 'claude' ? claudeAccessOptions(value.sandbox) : sandboxChoices} disabled={disabled}
      error={value.harness === 'claude' && value.sandbox !== 'danger-full-access' ? CLAUDE_FULL_ACCESS_REQUIRED : undefined}
      onChange={(event) => {
        const choice = sandboxChoices.find((item) => item.value === event.target.value)
        if (choice) void onChange(value.harness === 'codex' ? changeCodexSandbox(value, choice.value) : { ...value, sandbox: choice.value })
      }} /> : null}
    {value.harness === 'codex' ? <Select label="Approval requests" value={withAdvancedDefaults(value).advanced?.approvalPolicy ?? 'on-request'} disabled={disabled}
      options={[{ value: 'on-request', label: 'Ask when needed' }, { value: 'never', label: 'Never request escalation' }]}
      onChange={(event) => {
        const current = withAdvancedDefaults(value)
        if (event.target.value === 'on-request' || event.target.value === 'never') void onChange({ ...current, advanced: { ...current.advanced!, approvalPolicy: event.target.value } })
      }} /> : null}
  </div>
}

export function OperatorAccessPicker(props: Parameters<typeof EditableOperatorAccessPicker>[0]) {
  if (props.value.harness === 'opencode') return <p role="status">{retiredHarnessLabel}</p>
  return <EditableOperatorAccessPicker {...props} />
}
