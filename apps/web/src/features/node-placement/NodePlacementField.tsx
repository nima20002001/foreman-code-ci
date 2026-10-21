import { InfoHint } from '../../shared/ui/InfoHint'
import type { SavedNodePlacement } from '@foreman-code/contracts/node-placement'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { Select } from '../../shared/ui/nocturne'

/** Presentation only. The caller supplies authorized, revision-pinned choices;
 * this control never discovers hosts, validates remote paths or creates pins. */
export type NodePlacementOption = Readonly<{
  placement: SavedNodePlacement
  label: string
  unavailableReason?: string
  commit?: string
}>
export type NodePlacementFieldProps = {
  value?: SavedNodePlacement
  options: readonly NodePlacementOption[]
  onChange(value: SavedNodePlacement | undefined): void
  disabled?: boolean
  optionsState?: 'ready' | 'loading' | 'unavailable'
  stage?: 'editing' | 'draft' | 'saved'
  inheritedWorktree?: string
}
const stageMessages = {
  editing: 'Editing computer choice',
  draft: 'Applied to draft',
  saved: 'Persisted Board placement',
}
export function NodePlacementField({ value, options, onChange, disabled, optionsState = 'ready', stage,
  inheritedWorktree }: NodePlacementFieldProps) {
  const selected = value ? options.findIndex((option) => sameWorkflowValue(option.placement, value)) : -1
  const current = selected >= 0 ? options[selected] : undefined
  let selection = 'inherited'
  if (value) selection = selected < 0 ? 'retained' : String(selected)
  return <div className="node-placement-field">
    <Select label="Computer" aria-label="Computer"
      labelHint={<InfoHint label="Computer">Agents inherit the workflow’s selected source and computer. Start records every Agent’s authorized source, root and harness in the Run. Apply changes this node’s draft. Save graph persists it for a later Run. An accepted Run keeps its original placement.</InfoHint>} value={selection} disabled={disabled}
      options={[
        { value: 'inherited', label: inheritedWorktree ? 'Workflow default' : 'Main (default)' },
        ...(value && selected < 0 ? [{ value: 'retained', label: 'Configured computer — retained', disabled: true }] : []),
        ...options.map((option, index) => ({ value: String(index), label: option.unavailableReason ? `${option.label} — ${option.unavailableReason}` : option.label, disabled: !!option.unavailableReason })),
      ]} onChange={(event) => {
        if (event.target.value === 'inherited') {
          onChange(undefined)
          return
        }
        const option = options[Number(event.target.value)]
        if (option && !option.unavailableReason) onChange(structuredClone(option.placement))
      }} />
    {stage && (value || stage !== 'saved') ? <p role="status">{stageMessages[stage]}</p> : null}
    {value ? <>
      <dl>
        <dt>Override for next Run</dt><dd>{current?.label ?? (optionsState === 'ready' ? 'Unavailable configured choice' : 'Configured choice retained')}</dd>
        <dt>Approved commit</dt><dd><code>{current?.commit ?? 'Unavailable'}</code></dd>
        <dt>Execution root</dt><dd>{value.projectRoot}</dd>
      </dl>
      <details><summary>Computer and harness identities</summary><dl>
        <dt>Computer identity</dt><dd><code>{value.hostRef.kind === 'device' ? value.hostRef.deviceId : value.hostRef.mainId}</code></dd>
        <dt>Harness instance</dt><dd>{value.instanceId} · revision {value.instanceRevision}</dd>
        <dt>Harness installation</dt><dd>{value.harnessInstallationId}</dd>
        <dt>Root policy</dt><dd>{value.rootPolicyId} · revision {value.rootPolicyRevision}</dd>
      </dl></details>
    </> : <p>Inherited from workflow: {inheritedWorktree ?? 'Main through existing workspace placement'}.</p>}
    {optionsState === 'loading' ? <p role="status">Reading authorized computer choices…</p> : optionsState === 'unavailable' ? <p role="status">Authorized computer choices are unavailable. Configured placement is retained.</p> : null}
    {optionsState === 'ready' && value && (!current || current.unavailableReason) ? <p role="status">{current?.unavailableReason ?? 'This configured choice is no longer available. It is retained until you explicitly replace it.'}</p> : null}
  </div>
}
