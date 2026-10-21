import { InfoHint } from '../../shared/ui/InfoHint'
import type { ReactNode } from 'react'
import { changeCodexSandbox, withAdvancedDefaults, type CodexAdvancedConfiguration, type HarnessConfiguration } from '@foreman-code/contracts'
import type { HarnessSettingsSection } from '@foreman-code/contracts/management'
import { Button, Checkbox, Select } from '../../shared/ui/nocturne'
import type { HarnessEditor } from './harnessEditor'
import { fieldMessage, type FieldIssue } from './fieldValidation'
import { HarnessDirectoryPicker } from './HarnessDirectoryPicker'
import { HarnessBasicFields, HarnessSandboxField } from './HarnessBasicFields'
import { HarnessMcpPolicies } from './HarnessMcpPolicies'
import { HarnessMcpManager } from './HarnessMcpManager'
import { McpDetectionSettings } from './McpDetectionSettings'
import { ClaudeMcpConfiguration } from './ClaudeMcpConfiguration'

export function HarnessSectionFields({ editor, onChange, section, issues = [], routedApproval = false, allowAutoReview = false, requiresResume = false, workspaceId, writableDirectories, qualified = false, checking = false, checkError }: {
  editor: HarnessEditor; onChange(editor: HarnessEditor): void; section: HarnessSettingsSection;
  issues?: readonly FieldIssue[]; routedApproval?: boolean; allowAutoReview?: boolean; requiresResume?: boolean; workspaceId?: string; writableDirectories?: ReactNode; qualified?: boolean; checking?: boolean; checkError?: string;
}) {
  const value = withAdvancedDefaults(editor.configuration)
  const error = (path: string) => fieldMessage(issues, path)
  const change = (configuration: HarnessConfiguration) => onChange({ ...editor, configuration })
  const codex = (advanced: CodexAdvancedConfiguration) => { if (value.harness === 'codex') change({ ...value, advanced }) }
  if (value.harness === 'opencode') return null
  if (value.harness === 'claude') return <div className="harness-section-fields">
    {section === 'model' || section === 'permissions' ? <HarnessBasicFields value={value} onChange={change} issues={issues}
      qualified={qualified} checking={checking} checkError={checkError} /> : section === 'session' ? <>
      <p>Accepted instructions <InfoHint label="Accepted instructions">Claude sessions use the accepted profile. Native hooks, plugins and agents are excluded.</InfoHint>: {value.instructions || 'None'}</p>
    </> : section === 'connections' ? <ClaudeMcpConfiguration value={value} onChange={change} />
      : section === 'tools' ? <HarnessMcpPolicies editor={editor} onChange={onChange} /> : <>
      <h4>Access &amp; approvals <InfoHint label="Access & approvals">Claude uses the tools, approval rules and MCP servers pinned in this configuration. App approval routing is preserved.</InfoHint></h4>
      <p>Enabled tools: {value.tools.join(', ') || 'None'}</p>
      {value.permissionRules.map((rule) => <p key={rule.tool}>{rule.tool}: {rule.effect}</p>)}
      {Object.entries(value.mcpServers).map(([name, server]) => <p key={name}>{name}: {server.url}</p>)}
      {!Object.keys(value.mcpServers).length ? <p>No MCP servers are configured.</p> : null}
    </>}
  </div>
  return <div className="harness-section-fields">
    {section === 'model' ? <HarnessBasicFields value={value} onChange={change} issues={issues} includeSandbox={false} /> : null}
            {value.harness === 'codex' && section === 'permissions' ? <>
              <HarnessSandboxField value={value} onChange={change} issues={issues} />
              <div className="harness-two-columns">
                <Select label="Approval policy" value={value.advanced!.approvalPolicy} error={error('advanced.approvalPolicy')}
                  options={[{ value: 'on-request', label: 'Ask when needed' }, { value: 'never', label: 'Never request escalation' }]}
                  onChange={(event) => codex({ ...value.advanced!, approvalPolicy: event.target.value as CodexAdvancedConfiguration['approvalPolicy'] })} />
                <Select label="Approval reviewer" value={value.advanced!.approvalsReviewer} error={error('advanced.approvalsReviewer')}
                  options={[{ value: 'user', label: 'User / app routing' }, { value: 'auto_review', label: 'Codex automatic review', disabled: routedApproval && !allowAutoReview }]}
                  labelHint={allowAutoReview || routedApproval ? <InfoHint label="Approval reviewer">{allowAutoReview
                    ? 'Codex reviews this Agent’s native requests. Other Agents keep their own approval settings.'
                    : 'This workflow uses app approval routing.'}</InfoHint> : undefined}
                  onChange={(event) => codex({ ...value.advanced!, approvalsReviewer: event.target.value as CodexAdvancedConfiguration['approvalsReviewer'] })} />
              </div>
              {value.sandbox === 'workspace-write' ? <>
                {writableDirectories ?? <HarnessDirectoryPicker value={value.advanced!.additionalWritableDirectories} error={error('advanced.additionalWritableDirectories')}
                  onChange={(directories) => codex({ ...value.advanced!, additionalWritableDirectories: directories })} />}
                <div className="harness-switch-list">{([
                  ['networkAccess', 'Workspace network access'],
                  ['excludeTmpdirEnvVar', 'Exclude TMPDIR from writable roots'],
                  ['excludeSlashTmp', 'Exclude /tmp from writable roots'],
                ] as const).map(([key, label]) => <Checkbox key={key} label={label} checked={value.advanced!.workspaceWrite?.[key] ?? false}
                  error={error(`advanced.workspaceWrite.${key}`)} onChange={(event) => codex({ ...value.advanced!, workspaceWrite: {
                    networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false,
                    ...value.advanced!.workspaceWrite, [key]: event.target.checked,
                  } })} />)}</div>
              </> : <div className="harness-empty"><span>Leaving workspace-write removes additional writable directories and workspace-write options.</span><Button size="sm" onClick={() => change(changeCodexSandbox(value, 'workspace-write'))}>Use Workspace write</Button></div>}
            </> : null}
            {value.harness === 'codex' && section === 'session' ? <div className="harness-two-columns">
              <Select label="Web search" value={value.advanced!.webSearch} error={error('advanced.webSearch')}
                options={[{ value: 'disabled', label: 'Disabled' }, { value: 'cached', label: 'Cached' }, { value: 'live', label: 'Live' }]}
                onChange={(event) => codex({ ...value.advanced!, webSearch: event.target.value as CodexAdvancedConfiguration['webSearch'] })} />
              <Select label="Session history" value={value.advanced!.sessionPersistence} error={error('advanced.sessionPersistence') ?? error('requiresResume')}
                options={[{ value: 'persistent', label: 'Keep history · supports recovery' }, { value: 'ephemeral', label: 'Ephemeral · no resume', disabled: requiresResume || routedApproval }]}
                onChange={(event) => codex({ ...value.advanced!, sessionPersistence: event.target.value as CodexAdvancedConfiguration['sessionPersistence'] })} />
            </div> : null}
    {section === 'tools' ? <HarnessMcpPolicies key={`policies-${value.harness}`} editor={editor} onChange={onChange} /> : null}
    {section === 'connections' ? <HarnessMcpManager key={value.harness} harness={value.harness} /> : null}
    {section === 'workspace' ? <McpDetectionSettings workspaceId={workspaceId} harness={value.harness} /> : null}
  </div>
}
