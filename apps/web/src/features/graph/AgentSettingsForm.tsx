import { InfoHint } from '../../shared/ui/InfoHint'
import { errorMessage } from '../../shared/errorMessage'
import { nativeToolsSummary } from '@foreman-code/contracts'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { SavedNodePlacementSchema, type SavedNodePlacement } from '@foreman-code/contracts/node-placement'
import {
  AgentWorktreeSettingsSchema, type AgentWorktreeSettings, type WorkflowWorktreeSettings,
} from '@foreman-code/contracts/worktree-settings'
import { NodePlacementField, type NodePlacementOption } from '../node-placement/NodePlacementField'
import type { AgentForm } from './nextDraft/agentForm'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  AgentHarnessSchema, CodexSessionCompatibilitySchema, DEFAULT_HARNESS_DEFAULTS, legacyEffortForHarness,
  validateHarnessWorkflowCompatibility, withAdvancedDefaults,
  type Agent, type ApprovalHandler, type AssignedSkill, type GraphqlToolOverride, type HarnessDefaults, type WorkflowExecutionPolicy,
} from '@foreman-code/contracts'

import { Alert, Button, Icon, IconButton, Select, Textarea, TextField } from '../../shared/ui/nocturne'
import { configuredHarness, initialModel } from '../agents/agentSettings'
import { useHarnessDefaultsQuery, useManagedHarnessCatalogQuery } from '../../shared/api/query'
import { ClaudeFullAccessConfigurationSchema } from '@foreman-code/contracts/claude'
import { harnessNames, retiredHarnessLabel } from '../settings/settingsPresentation'
import { HarnessConfigurationFields } from '../settings/HarnessConfigurationFields'
import { HarnessBasicFields } from '../settings/HarnessBasicFields'
import { createHarnessEditor, prepareHarnessEditor, switchHarnessEditor } from '../settings/harnessEditor'
import { FieldValidationError, fieldMessage, focusFirstInvalid, issuesAt, validationIssues, type FieldIssue } from '../settings/fieldValidation'
import { GraphqlToolsFields } from './GraphqlToolsFields'
import { AgentSkillsField } from '../skills/AgentSkillsField'
import './agentSettingsPanel.css'

type EditableAgentSettingsFormProps = {
  /** Inside an agent popover: the popover owns the title and close button. */
  embedded?: boolean
  /** Explicit new-Agent authoring uses the same fields before any graph node is staged. */
  creationLabel?: string
  additionalDirty?: boolean
  additionalFields?: ReactNode
  nodePlacement?: SavedNodePlacement
  nodeWorktree?: AgentWorktreeSettings
  workflowWorktree?: WorkflowWorktreeSettings
  workflowWorktreeLabel?: string
  worktreeDisabled?: boolean
  placementOptions?: readonly NodePlacementOption[]
  /** Placement access was denied: hide its details but keep the retained draft base and edits. */
  placementHidden?: boolean
  placementOptionsState?: 'ready' | 'loading' | 'unavailable'
  placementStage?: 'draft' | 'saved'
  retainedForm?: AgentForm
  onFormChange?(form: AgentForm): void
  onDiscardForm?(): void
  canResume?(): boolean
  agent: Agent
  initialPrompt?: string
  /** This workflow node's change to the Agent's default Foreman Code MCP tools. */
  nodeGraphqlTools?: GraphqlToolOverride
  creationDefaults?: HarnessDefaults
  onClose(): void
  onRemove?(): void
  onSave(agent: Agent, initialPrompt: string | undefined, executionPolicy: WorkflowExecutionPolicy,
    nodeGraphqlTools: GraphqlToolOverride | undefined, placement?: SavedNodePlacement, worktree?: AgentWorktreeSettings): void
  executionPolicy?: WorkflowExecutionPolicy
  workflowNodeCount?: number
  workspaceId?: string
  workflowApprovalHandler?: ApprovalHandler
  designatedOrchestrator?: boolean
}

function useAgentSettingsForm({ agent, initialPrompt, nodeGraphqlTools, creationDefaults, onClose, onSave, retainedForm, onFormChange, onDiscardForm, canResume, additionalDirty = false,
  nodePlacement, nodeWorktree,
  executionPolicy = { maxNodeExecutions: 1, maxParallelism: 1 },
  workflowApprovalHandler, designatedOrchestrator = false,
}: EditableAgentSettingsFormProps) {
  const [localName, setLocalName] = useState(agent.name)
  const [localPrompt, setLocalPrompt] = useState(initialPrompt ?? '')
  const [localGraphqlTools, setLocalGraphqlTools] = useState<NonNullable<AgentForm['graphqlTools']>>(() => ({
    ...(agent.graphqlTools ? { defaults: agent.graphqlTools } : {}), ...(nodeGraphqlTools ? { override: nodeGraphqlTools } : {}) }))
  const [localInstructions, setLocalInstructions] = useState(agent.prompt?.system ?? '')
  const [localSkills, setLocalSkills] = useState<AssignedSkill[]>(agent.assignedSkills ?? [])
  const [error, setError] = useState<string>()
  const [issues, setIssues] = useState<FieldIssue[]>([])
  const [view, setView] = useState<'general' | 'advanced'>('general')
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { if (issues.length) focusFirstInvalid(root.current) }, [issues])
  const [localEditor, setLocalEditor] = useState(() => {
    const harness = agent.harnessConfiguration?.harness ?? agent.harness ?? 'codex'
    return createHarnessEditor(agent.harnessConfiguration ?? configuredHarness(agent, harness,
      initialModel(agent, harness), agent.effort ?? 'medium', agent.fastMode ?? false, 'read-only', creationDefaults))
  })
  const [localPlacement, setLocalPlacement] = useState(nodePlacement)
  const [localPrefix, setLocalPrefix] = useState(nodeWorktree?.branchPrefix ?? '')
  const base = JSON.stringify({ agent, initialPrompt, nodeGraphqlTools, nodePlacement, nodeWorktree })
  const retained = retainedForm && sameWorkflowValue(JSON.parse(retainedForm.base), JSON.parse(base)) ? retainedForm : undefined
  const name = retained?.name ?? localName, prompt = retained?.prompt ?? localPrompt, editor = retained?.editor ?? localEditor
  const placement = retained ? retained.placement : localPlacement
  const branchPrefix = retained?.branchPrefix ?? localPrefix
  const graphqlTools = retained?.graphqlTools ?? localGraphqlTools
  const instructions = retained?.instructions ?? localInstructions, skills = retained?.skills ?? localSkills
  const changeForm = (patch: Partial<AgentForm>) => onFormChange?.({ base, name, prompt, editor, graphqlTools,
    instructions, skills, branchPrefix, ...(placement ? { placement } : {}), ...patch })
  const setName = (value: string) => { if (onFormChange) changeForm({ name: value }); else setLocalName(value) }
  const setPrompt = (value: string) => { if (onFormChange) changeForm({ prompt: value }); else setLocalPrompt(value) }
  const setGraphqlTools = (value: NonNullable<AgentForm['graphqlTools']>) => { if (onFormChange) changeForm({ graphqlTools: value }); else setLocalGraphqlTools(value) }
  const setInstructions = (value: string) => { if (onFormChange) changeForm({ instructions: value }); else setLocalInstructions(value) }
  const setSkills = (value: AssignedSkill[]) => { if (onFormChange) changeForm({ skills: value }); else setLocalSkills(value) }
  const setEditor = (update: typeof editor | ((current: typeof editor) => typeof editor)) => {
    const value = typeof update === 'function' ? update(editor) : update
    if (onFormChange) changeForm({ editor: value }); else setLocalEditor(value)
  }
  const initialSnapshot = useRef<string | undefined>(undefined)
  if (!initialSnapshot.current) initialSnapshot.current = JSON.stringify({ name: agent.name, prompt: initialPrompt ?? '', editor: localEditor, graphqlTools: localGraphqlTools,
    instructions: agent.prompt?.system ?? '', skills: agent.assignedSkills ?? [], placement: nodePlacement,
    branchPrefix: nodeWorktree?.branchPrefix ?? '' })
  const defaultsQuery = useHarnessDefaultsQuery({ enabled: !creationDefaults })
  const catalogQuery = useManagedHarnessCatalogQuery(!creationDefaults)
  const providerDefaults = creationDefaults ?? defaultsQuery.data?.defaults
  const configuration = withAdvancedDefaults(editor.configuration)
  const harnessOptions = AgentHarnessSchema.options.map((harness) => {
    const draft = editor.drafts?.[harness]
    const preset = draft?.configuration ?? providerDefaults?.[harness]
    let reason: string | undefined
    if (!draft) {
      if (!creationDefaults && defaultsQuery.isError) reason = defaultsQuery.error.message
      else if (!creationDefaults && defaultsQuery.isPending) reason = 'Provider presets are loading.'
      else if (!preset) reason = `Configure ${harnessNames[harness]} in Settings > Harnesses before selecting it.`
      else if (!creationDefaults) {
        const discoveryError = catalogQuery.data?.find((entry) => entry.harness === harness)?.discoveryError
        if (discoveryError && ['HARNESS_MODEL_DEFAULT_UNAVAILABLE', 'CLAUDE_FULL_ACCESS_REQUIRED',
          'CLAUDE_EXTERNAL_MCP_UNSUPPORTED'].includes(discoveryError.code)) {
          reason = discoveryError.message
        }
      }
    }
    if (!reason && preset?.harness === 'claude') {
      const supported = ClaudeFullAccessConfigurationSchema.safeParse(preset)
      if (!supported.success) reason = supported.error.issues[0]?.message
    }
    return { value: harness, label: reason ? `${harnessNames[harness]} · ${reason}` : harnessNames[harness],
      disabled: Boolean(reason), reason }
  })
  const harnessReason = harnessOptions.find((option) => option.value === configuration.harness)?.reason
  const currentSnapshot = JSON.stringify({ name, prompt, editor, graphqlTools, instructions, skills, placement, branchPrefix })
  const isDirty = additionalDirty || currentSnapshot !== initialSnapshot.current
  const nameError = fieldMessage(issues, 'name')
  const clearErrors = () => { setError(undefined); setIssues([]) }
  const updateConfiguration = (next: typeof configuration) => {
    setEditor((current) => ({ ...current, configuration: next }))
    clearErrors()
  }
  const save = () => {
    const previousSnapshot = initialSnapshot.current
    try {
      if (!name.trim()) throw new FieldValidationError([{ path: ['name'], message: 'Enter an agent name.' }])
      const nextConfiguration = (() => {
        try {
          const next = prepareHarnessEditor(editor)
          validateHarnessWorkflowCompatibility(next, workflowApprovalHandler, designatedOrchestrator)
          if (next.harness === 'codex' && workflowApprovalHandler) CodexSessionCompatibilitySchema.parse({ configuration: next, requiresResume: true })
          return next
        } catch (failure) {
          const harnessIssues = validationIssues(failure)
          if (harnessIssues.length) throw new FieldValidationError(harnessIssues.map((issue) => ({ ...issue,
            path: ['harness', ...(issue.path[0] === 'configuration' ? issue.path.slice(1) : issue.path)] })), { cause: failure })
          throw failure
        }
      })()
      if (placement) SavedNodePlacementSchema.parse(placement)
      const worktree = branchPrefix.trim() ? AgentWorktreeSettingsSchema.parse({ branchPrefix: branchPrefix.trim() }) : undefined
      initialSnapshot.current = currentSnapshot
      onSave({ ...agent, name: name.trim(), harness: nextConfiguration.harness, model: nextConfiguration.model,
        effort: legacyEffortForHarness(nextConfiguration), fastMode: nextConfiguration.harness === 'codex' ? nextConfiguration.serviceTier === 'priority' : undefined,
        harnessConfiguration: nextConfiguration,
        ...(graphqlTools.defaults ? { graphqlTools: graphqlTools.defaults } : {}),
        prompt: instructions.trim() ? { system: instructions.trim() } : {}, assignedSkills: skills,
      }, prompt.trim() || undefined, executionPolicy, graphqlTools.override, placement, worktree)
    } catch (failure) {
      initialSnapshot.current = previousSnapshot
      const nextIssues = validationIssues(failure)
      setIssues(nextIssues)
      setError(nextIssues.length ? 'Review the marked fields before saving.' : errorMessage(failure, 'Agent settings are invalid.'))
    }
  }
  const leave = useUnsavedChanges({ scope: 'surface', label: 'agent settings', canResume, get dirty() { return additionalDirty || currentSnapshot !== initialSnapshot.current },
    error, save, discard: () => { initialSnapshot.current = currentSnapshot; onDiscardForm?.(); onClose() },
  })
  return {
    error, issues, view, setView, root, setLocalPlacement, setLocalPrefix, name, prompt, editor, placement,
    branchPrefix, graphqlTools, instructions, skills, changeForm, setName, setPrompt, setGraphqlTools,
    setInstructions, setSkills, setEditor, providerDefaults, configuration, harnessOptions, harnessReason,
    isDirty, nameError, clearErrors, updateConfiguration, save, leave,
  }
}

function EditableAgentSettingsForm({ agent, initialPrompt, nodeGraphqlTools, creationDefaults, onClose, onRemove, onSave, retainedForm, onFormChange, onDiscardForm, canResume,
  nodePlacement, nodeWorktree, workflowWorktree, workflowWorktreeLabel, worktreeDisabled,
  placementOptions, placementHidden, placementOptionsState, placementStage,
  executionPolicy = { maxNodeExecutions: 1, maxParallelism: 1 }, workspaceId,
  workflowApprovalHandler, designatedOrchestrator = false, embedded = false, creationLabel, additionalDirty, additionalFields,
}: EditableAgentSettingsFormProps) {
  const {
    error, issues, view, setView, root, setLocalPlacement, setLocalPrefix, name, prompt, editor, placement,
    branchPrefix, graphqlTools, instructions, skills, changeForm, setName, setPrompt, setGraphqlTools,
    setInstructions, setSkills, setEditor, providerDefaults, configuration, harnessOptions, harnessReason,
    isDirty, nameError, clearErrors, updateConfiguration, save, leave,
  } = useAgentSettingsForm({
    agent, initialPrompt, nodeGraphqlTools, creationDefaults, onClose, onRemove, onSave, retainedForm,
    onFormChange, onDiscardForm, canResume, nodePlacement, nodeWorktree, workflowWorktree,
    workflowWorktreeLabel, worktreeDisabled, placementOptions, placementHidden, placementOptionsState,
    placementStage, executionPolicy, workspaceId, workflowApprovalHandler, designatedOrchestrator, embedded, additionalDirty,
  })
  return <div ref={root} className={`agent-settings-panel${embedded ? ' agent-settings-panel-embedded' : ''}`}>
    {embedded ? view === 'advanced' ? <header className="agent-settings-heading">
      <div className="agent-settings-title">
        <IconButton size="sm" variant="ghost" className="agent-settings-back" label="Back to general settings" onClick={() => setView('general')}><Icon name="chevron" size={15} /></IconButton>
        <strong>Advanced settings</strong>
      </div>
    </header> : null : <header className="agent-settings-heading">
      <div className="agent-settings-title">
        {view === 'advanced' ? <IconButton size="sm" variant="ghost" className="agent-settings-back" label="Back to general settings" onClick={() => setView('general')}><Icon name="chevron" size={15} /></IconButton> : null}
        <strong>{view === 'advanced' ? 'Advanced settings' : 'Agent settings'}<InfoHint label="Agent settings">Save updates this graph draft. Use Save graph to persist it.</InfoHint></strong>
      </div>
      <div className="agent-settings-header-actions">
      <Button size="sm" variant="primary" className="agent-settings-save" aria-label="Save agent settings" disabled={!isDirty} onClick={save} leading={<Icon name="check" size={13} />}>Save</Button>
      <IconButton size="sm" variant="ghost" label="Close agent settings" onClick={() => void leave(onClose)}><Icon name="close" size={15} /></IconButton>
      </div>
    </header>}
    {view === 'general' ? <div className="agent-settings-general">
      <div className="agent-settings-row agent-settings-row-primary">
        <TextField label="Name" aria-label="Name" value={name} error={nameError} onChange={(event) => { setName(event.target.value); clearErrors() }} />
        <Select label="Harness" aria-label="Harness" value={configuration.harness} options={harnessOptions}
          hint={harnessReason ? `Provider preset unavailable: ${harnessReason} Saved agent settings are kept.` : undefined}
          onChange={(event) => {
          const next = AgentHarnessSchema.parse(event.target.value)
          if (harnessOptions.find((option) => option.value === next)?.disabled) return
          const fallback = providerDefaults?.[next] ?? DEFAULT_HARNESS_DEFAULTS[next]
          setEditor((current) => switchHarnessEditor(current, next, fallback))
          clearErrors()
        }} />
      </div>
      <div className={`agent-settings-row agent-settings-row-runtime agent-settings-row-${configuration.harness}`}>
        <HarnessBasicFields value={configuration} issues={issuesAt(issues, ['harness'])} onChange={updateConfiguration}
          accountHost={placement?.hostRef} />
      </div>
      {creationLabel ? <Textarea label="Initial prompt" aria-label="Initial prompt" className="agent-settings-prompt" rows={3} value={prompt}
        labelHint={<InfoHint label="Initial prompt">The task this node starts with.</InfoHint>}
        onChange={event => { setPrompt(event.target.value); clearErrors() }} /> : null}
      <p>Native tools: {nativeToolsSummary(agent.nativeTools)}</p>
      {additionalFields}
      {Boolean(workspaceId || nodePlacement || placementOptions) && <section className="agent-worktree-fields" aria-label="Worktree">
        <h3>Worktree</h3>
        <Button size="sm" variant="secondary" disabled={worktreeDisabled || (!placement && !branchPrefix)}
          onClick={() => {
            if (onFormChange) changeForm({ placement: undefined, branchPrefix: '' })
            else { setLocalPlacement(undefined); setLocalPrefix('') }
            clearErrors()
          }}>Use workflow default</Button>
        {!placementHidden && (nodePlacement || placementOptions) && <NodePlacementField value={placement}
          options={placementOptions ?? []} optionsState={placementOptionsState} disabled={worktreeDisabled}
          inheritedWorktree={workflowWorktreeLabel} stage={!sameWorkflowValue(placement, nodePlacement) ? 'editing' : placementStage}
          onChange={next => {
            if (onFormChange) changeForm({ placement: next })
            else setLocalPlacement(next)
            clearErrors()
          }} />}
        <TextField label="Agent branch prefix" value={branchPrefix} placeholder={workflowWorktree?.branchPrefix ?? 'Generated automatically'}
          disabled={worktreeDisabled} error={fieldMessage(issues, 'branchPrefix')}
          labelHint={<InfoHint label="Agent branch prefix">Optional override. Each execution adds a unique suffix.</InfoHint>}
          onChange={event => {
            if (onFormChange) changeForm({ branchPrefix: event.target.value })
            else setLocalPrefix(event.target.value)
            clearErrors()
          }} />
      </section>}
      {workspaceId ? <AgentSkillsField workspaceId={workspaceId} value={skills} onChange={(next) => { setSkills(next); clearErrors() }} /> : null}
    </div> : <div className="agent-settings-advanced-view">
      <Textarea label="Agent instructions" className="agent-settings-prompt" rows={4} value={instructions}
        labelHint={<InfoHint label="Agent instructions">Given to this Agent before its skills on every turn. Not part of the task.</InfoHint>}
        onChange={(event) => { setInstructions(event.target.value); clearErrors() }} />
      <Textarea label="Initial prompt" aria-label="Initial prompt" className="agent-settings-prompt" rows={3} value={prompt}
        labelHint={<InfoHint label="Initial prompt">The task this node starts with.</InfoHint>}
        onChange={(event) => { setPrompt(event.target.value); clearErrors() }} />
      <GraphqlToolsFields role={agent.productRole === 'master' ? 'master' : agent.productRole === 'orchestrator' ? 'orchestrator' : 'coder'} defaults={graphqlTools.defaults} override={graphqlTools.override}
        executionReadOnly={configuration.harness === 'codex' && configuration.sandbox === 'read-only'}
        readOnly={configuration.harness === 'opencode' || configuration.sandbox === 'read-only'}
        onChange={(defaults, override) => { setGraphqlTools({ ...(defaults ? { defaults } : {}), ...(override ? { override } : {}) }); clearErrors() }} />
      <HarnessConfigurationFields editor={editor} issues={issuesAt(issues, ['harness'])} onChange={(next) => { setEditor(next); clearErrors() }} allowHarnessChange={false} harnessDefaults={providerDefaults} workspaceId={workspaceId} routedApproval={Boolean(workflowApprovalHandler)} allowAutoReview={workflowApprovalHandler === 'orchestrator'} compact advancedOnly />
    </div>}
    {error ? <Alert tone="danger" live title={error} /> : null}
    <footer className="agent-settings-footer">
      {view === 'general' ? <Button size="sm" variant="ghost" className="agent-settings-advanced-link" onClick={() => setView('advanced')} trailing={<Icon name="chevron" size={13} />}>Advanced settings</Button> : null}
      {onRemove ? embedded ? <Button size="sm" variant="ghost" className="agent-settings-trash" aria-label={`Remove ${agent.name} from workflow`} onClick={() => void leave(onRemove)}>Remove from workflow</Button>
        : <IconButton size="sm" variant="ghost" className="agent-settings-trash" label={`Remove ${agent.name} from workflow`} onClick={() => void leave(onRemove)}><Icon name="minus" size={15} /></IconButton> : null}
      {creationLabel ? <Button size="sm" variant="ghost" onClick={() => void leave(onClose)}>Cancel</Button>
        : embedded ? <Button size="sm" variant="ghost" onClick={() => { onDiscardForm?.(); onClose() }}>Cancel</Button> : null}
      {embedded ? <Button size="sm" variant="primary" className="agent-settings-save" aria-label={creationLabel ?? 'Apply agent settings to draft'}
        disabled={!creationLabel && !isDirty} onClick={save}>{creationLabel ?? 'Apply to draft'}</Button> : null}
    </footer>
  </div>
}

export function AgentSettingsForm(props: Parameters<typeof EditableAgentSettingsForm>[0]) {
  if (props.agent.harness === 'opencode' || props.agent.harnessConfiguration?.harness === 'opencode') {
    return <div className="harness-form-stack"><p role="status">{retiredHarnessLabel}</p>
      <p>{props.agent.name}</p><p>Model: {props.agent.harnessConfiguration?.model ?? props.agent.model ?? 'Not set'}</p>
      {props.agent.prompt?.system ? <p>{props.agent.prompt.system}</p> : null}
      {props.initialPrompt ? <p>{props.initialPrompt}</p> : null}
    </div>
  }
  return <EditableAgentSettingsForm {...props} />
}
