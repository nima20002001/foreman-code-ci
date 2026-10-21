import { retiredHarnessLabel } from './settingsPresentation'
import { useEffect, useRef, useState } from 'react'
import { AgentHarnessSchema, DEFAULT_HARNESS_DEFAULTS, type HarnessConfiguration, type HarnessDefaults } from '@foreman-code/contracts'
import type { HarnessSettingsSection } from '@foreman-code/contracts/management'
import { Alert, Button, ConfirmDialog, Select } from '../../shared/ui/nocturne'
import { useHarnessDefaultsQuery } from '../../shared/api/query'
import { useAutomaticHarnessCheck, useRefreshNativeHarness } from '../../shared/api/harnessSettings'
import { prepareHarnessEditor, resetHarnessEditor, switchHarnessEditor, type HarnessEditor } from './harnessEditor'
import { focusFirstInvalid, type FieldIssue } from './fieldValidation'
import { HarnessSectionFields } from './HarnessSectionFields'
import { harnessNames, harnessSections, sectionForHarnessIssue } from './settingsPresentation'
import './harnessWorkbench.css'
import './settingsExperience.css'

function EditableHarnessConfigurationFields({ editor, onChange, routedApproval = false, allowAutoReview = false, requiresResume = false,
  allowHarnessChange = true, compact = false, advancedOnly = false, workspaceId, harnessDefaults, issues = [],
  section: selectedSection, onSectionChange, frameless = false,
}: {
  editor: HarnessEditor; onChange(editor: HarnessEditor): void; routedApproval?: boolean; allowAutoReview?: boolean; requiresResume?: boolean;
  allowHarnessChange?: boolean; compact?: boolean; advancedOnly?: boolean; workspaceId?: string;
  harnessDefaults?: HarnessDefaults; issues?: readonly FieldIssue[];
  section?: HarnessSettingsSection; onSectionChange?(section: HarnessSettingsSection): void; frameless?: boolean;
}) {
  const value = editor.configuration
  const harness = AgentHarnessSchema.parse(value.harness)
  const [localSection, setLocalSection] = useState<HarnessSettingsSection>(advancedOnly ? 'permissions' : 'model')
  const section = selectedSection ?? localSection
  const root = useRef<HTMLDivElement>(null)
  const sectionChange = useRef(onSectionChange)
  sectionChange.current = onSectionChange
  const [resetChoice, setResetChoice] = useState<'saved' | 'builtin'>()
  const presetsQuery = useHarnessDefaultsQuery({ enabled: allowHarnessChange && !harnessDefaults })
  const presets = harnessDefaults ?? presetsQuery.data?.defaults
  const refresh = useRefreshNativeHarness(value.harness)
  let candidate: HarnessConfiguration | undefined
  try { candidate = prepareHarnessEditor(editor) } catch { /* Incomplete drafts are validated on Save, never sent as valid configurations. */ }
  const configurationSection = section !== 'connections' && section !== 'workspace' && section !== 'plugins'
  const check = useAutomaticHarnessCheck(configurationSection ? candidate : undefined)
  const issuePath = issues[0]?.path.join('.') ?? ''
  useEffect(() => {
    if (!issuePath) return
    const next = sectionForHarnessIssue(issuePath.split('.'))
    setLocalSection(next)
    sectionChange.current?.(next)
    const frame = requestAnimationFrame(() => focusFirstInvalid(root.current))
    return () => cancelAnimationFrame(frame)
  }, [issuePath])
  const status = check.current && check.result.isFetching ? 'Checking…' : check.current && check.result.isSuccess ? 'Ready' : ''
  if (value.harness === 'opencode') return null
  const sections = harnessSections.filter((entry) => entry.id !== 'plugins' && (!compact || !['connections', 'workspace'].includes(entry.id)) && (!advancedOnly || entry.id !== 'model'))
  return <div className={`harness-workbench${frameless ? ' harness-workbench--page' : ''}`} ref={root} role="group" aria-label={harnessNames[value.harness]}>
    {!frameless ? <nav className="harness-section-nav" aria-label="Harness sections">{sections.map((item) => <Button key={item.id} size="sm"
      variant={section === item.id ? 'secondary' : 'ghost'} aria-pressed={section === item.id} onClick={() => {
        setLocalSection(item.id); onSectionChange?.(item.id)
      }}>{item.label}</Button>)}</nav> : null}
    {allowHarnessChange && section === 'model' ? <>
      <Select label="Harness" value={value.harness} options={AgentHarnessSchema.options.map((harness) => ({ value: harness,
        label: harnessNames[harness], disabled: harness !== value.harness && !editor.drafts?.[harness] && !presets?.[harness],
      }))} onChange={(event) => {
        const next = AgentHarnessSchema.parse(event.target.value)
        onChange(switchHarnessEditor(editor, next, presets?.[next]))
      }} />
      {presetsQuery.isError && !harnessDefaults ? <Alert tone="danger" title="Provider presets could not be loaded."
        action={<Button size="sm" onClick={() => void presetsQuery.refetch()}>Retry</Button>}>Your draft is kept. Presets were not replaced.</Alert> : null}
    </> : null}
    <HarnessSectionFields editor={editor} onChange={onChange} section={section} issues={issues}
      routedApproval={routedApproval} allowAutoReview={allowAutoReview} requiresResume={requiresResume} workspaceId={workspaceId}
      qualified={check.current && check.result.isSuccess} checking={check.current && check.result.isFetching}
      checkError={check.current && check.result.isError ? check.result.error.message : undefined} />
    {check.current && check.result.isError && !(value.harness === 'claude' && (section === 'model' || section === 'permissions')) ? <Alert live tone="danger" title={check.result.error.message} /> : null}
    {refresh.isError ? <Alert live tone="danger" title={refresh.error.message} /> : null}
    {issues.length ? <p className="n-field-error" role="alert">{[...new Set(issues.map((issue) => issue.message))].join(' ')}</p> : null}
    {configurationSection ? <div className="settings-check-row"><span role="status" className={status === 'Ready' ? 'harness-success' : 'harness-muted'}>{status}</span>
      <Button size="sm" variant="ghost" disabled={refresh.isPending} onClick={() => refresh.mutate()}>{refresh.isPending ? 'Checking…' : 'Refresh checks'}</Button>
      {allowHarnessChange && section === 'model' && presets?.[harness] ? <Button size="sm" variant="ghost" onClick={() => setResetChoice('saved')}>Use provider preset</Button> : null}
      {allowHarnessChange && section === 'model' && DEFAULT_HARNESS_DEFAULTS[harness] ? <Button size="sm" variant="ghost" onClick={() => setResetChoice('builtin')}>Use built-in defaults</Button> : null}
    </div> : null}
    <ConfirmDialog open={Boolean(resetChoice)} onOpenChange={(open) => { if (!open) setResetChoice(undefined) }} title={resetChoice === 'builtin' ? 'Use built-in defaults?' : 'Use the provider preset?'} description="This replaces only the selected harness draft. Other harness drafts are kept."
      confirmLabel="Use preset" onConfirm={() => {
        const preset = resetChoice === 'builtin' ? DEFAULT_HARNESS_DEFAULTS[harness] : presets?.[harness]
        if (preset) onChange(resetHarnessEditor(editor, preset))
        setResetChoice(undefined)
      }} />
  </div>
}

export function HarnessConfigurationFields(props: Parameters<typeof EditableHarnessConfigurationFields>[0]) {
  if (props.editor.configuration.harness === 'opencode') return <p role="status">{retiredHarnessLabel}</p>
  return <EditableHarnessConfigurationFields {...props} />
}
