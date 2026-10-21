import { InfoHint } from '../../shared/ui/InfoHint'
import { useRef, useState } from 'react'
import {
  WorkflowWorktreeSettingsSchema, type WorkflowWorktreeSettings,
} from '@foreman-code/contracts/worktree-settings'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { useWorktreeChoices, type WorktreeOption } from '../../shared/api/worktreeChoices'
import { useWorkspaceRepository } from '../../shared/api/workspaceGit'
import { Alert, Button, Dialog, Select, TextField } from '../../shared/ui/nocturne'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { worktreeLabel } from './worktreePresentation'

export function WorkflowWorktreeField({ workspaceId, value, savedValue, disabled, onChange }: {
  workspaceId: string
  value?: WorkflowWorktreeSettings
  savedValue?: WorkflowWorktreeSettings
  disabled?: boolean
  onChange(value: WorkflowWorktreeSettings | undefined): void
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const choices = useWorktreeChoices(workspaceId)
  const project = useWorkspaceRepository(workspaceId)
  const options = choices.isError ? [] : choices.data ?? []
  const draft = !sameWorkflowValue(value, savedValue)
  const label = worktreeLabel(value, options)
  // Plain text under the workflow name; the Board's Save state already covers an unsaved change.
  return <div className="workflow-worktree-field">
    <button ref={trigger} type="button" className="workflow-worktree-link" disabled={disabled}
      aria-label={`Worktree: ${label}${draft ? ' (unsaved)' : ''}`} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => setOpen(true)}>Worktree: <span>{label}</span>{draft ? <em> · unsaved</em> : null}</button>
    {open && <WorktreeEditor key={JSON.stringify(value ?? null)} value={value} options={options}
        optionsState={choices.isError ? 'unavailable' : choices.isPending ? 'loading' : 'ready'}
        workspaceProject={project.isError || project.data?.state !== 'ready' ? undefined : project.data.rootBinding}
        disabled={disabled} onChange={onChange} close={() => setOpen(false)} returnFocusRef={trigger} />}
  </div>
}

function WorktreeEditor({ value, options, optionsState, workspaceProject, disabled, onChange, close, returnFocusRef }: {
  value?: WorkflowWorktreeSettings
  options: readonly WorktreeOption[]
  optionsState: 'ready' | 'loading' | 'unavailable'
  workspaceProject?: WorkflowWorktreeSettings['rootBinding']
  disabled?: boolean
  onChange(value: WorkflowWorktreeSettings | undefined): void
  close(): void
  returnFocusRef: React.RefObject<HTMLButtonElement | null>
}) {
  const [rootBinding, setRootBinding] = useState(value?.rootBinding)
  const [prefix, setPrefix] = useState(value?.branchPrefix ?? '')
  const [error, setError] = useState<string>()
  const selected = rootBinding ? options.findIndex(option => sameWorkflowValue(option.rootBinding, rootBinding)) : -1
  const current = options[selected]
  let selection = 'workspace'
  if (rootBinding) selection = selected < 0 ? 'retained' : String(selected)
  const input = rootBinding ? { rootBinding, ...(prefix.trim() ? { branchPrefix: prefix.trim() } : {}) } : undefined
  const dirty = !sameWorkflowValue(input, value)
  const apply = () => {
    const parsed = WorkflowWorktreeSettingsSchema.optional().safeParse(input)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Review the worktree settings.')
      return false
    }
    onChange(parsed.data)
    close()
    return true
  }
  const leave = useUnsavedChanges({ scope: 'surface', label: 'default worktree', dirty, busy: disabled,
    error, save: apply, discard: close })
  return <Dialog open onOpenChange={open => { if (!open) void leave(close) }} title="Default worktree"
    closeLabel="Close default worktree" busy={disabled} returnFocusRef={returnFocusRef}
    headerLeading={<InfoHint label="Worktree">Each Agent gets its own worktree and unique branch at the selected approved commit. Apply changes the Board draft. Save changes persists the setting for a later Run.</InfoHint>}>
    <div className="worktree-editor">
    <Select label="Approved source root" value={selection} disabled={disabled}
      options={[
        { value: 'workspace', label: 'Use workspace default' },
        ...(rootBinding && selected < 0 ? [{ value: 'retained', label: 'Configured source — retained', disabled: true }] : []),
        ...options.map((option, index) => ({ value: String(index), label: option.label,
          disabled: Boolean(option.unavailableReason) })),
      ]} onChange={event => {
        if (event.target.value === 'workspace') {
          setRootBinding(undefined)
          setPrefix('')
        } else {
          const option = options[Number(event.target.value)]
          if (option && !option.unavailableReason) setRootBinding(option.rootBinding)
        }
        setError(undefined)
      }} />
    {workspaceProject && <Button disabled={disabled || !options.some(option =>
      sameWorkflowValue(option.rootBinding, workspaceProject) && !option.unavailableReason)}
      onClick={() => { setRootBinding(workspaceProject); setError(undefined) }}>Use workspace project</Button>}
    <TextField label="Agent branch prefix" value={prefix} placeholder="foreman/site"
      disabled={disabled || !rootBinding} onChange={event => { setPrefix(event.target.value); setError(undefined) }}
      labelHint={<InfoHint label="Agent branch prefix">Optional. A unique suffix is added for every Agent execution.</InfoHint>} />
    {current && <dl><dt>Computer</dt><dd>{current.computer}</dd><dt>Repository</dt><dd>{current.repository ?? 'Unavailable'}</dd>
      <dt>Approved commit</dt><dd><code>{current.commit ?? 'Unavailable'}</code></dd>
      <dt>Project root</dt><dd>{current.projectRoot ?? 'Unavailable'}</dd><dt>Access</dt><dd>{current.accessMode}</dd></dl>}
    {rootBinding && (!current || current.unavailableReason) && <Alert tone="warning" title={current?.unavailableReason
      ?? 'The configured source is unavailable. Choose an available approved source to run.'} />}
    {optionsState !== 'ready' && <p role="status">{optionsState === 'loading'
      ? 'Reading authorized worktree choices…' : 'Authorized worktree choices are unavailable. The saved setting is retained.'}</p>}
    {error && <Alert tone="danger" title={error} />}
    <div className="worktree-editor-actions">
      <Button disabled={disabled} onClick={() => void leave(close)}>Cancel</Button>
      <Button variant="primary" disabled={disabled || !dirty} onClick={apply}>Apply worktree</Button>
    </div>
    </div>
  </Dialog>
}
