import { InfoHint } from '../../shared/ui/InfoHint'
import { useEffect, useId, useRef, useState } from 'react'
import { AgentHarnessSchema, AgentEffortSchema, ClaudeEffortSchema, operatorChatSettings, type OperatorChatSettings } from '@foreman-code/contracts'
import type { ReactNode } from 'react'
import { useProviderHarnessModels } from '../provider-accounts/useProviderHarnessModels'
import { useHarnessDefaultsQuery } from '../../shared/api/query'
import { Button, Icon, SearchField, SegmentedControl, Slider, Switch } from '../../shared/ui/nocturne'
import { useFloatingSurface } from '../../shared/ui/nocturne/useFloatingSurface'
import { harnessNames } from '../settings/settingsPresentation'
import { supportedEfforts } from '../settings/harnessModelSelection'
import { ProviderAccountSelect } from '../provider-accounts/ProviderAccountSelect'

export function OperatorComposerSettings({ value, onChange, disabled, access, hideThinking = false }: {
  value: OperatorChatSettings; onChange(value: OperatorChatSettings): void; disabled: boolean;
  access?: ReactNode;
  /** Agent chats have no thinking display setting. */
  hideThinking?: boolean;
}) {
  const catalog = useProviderHarnessModels(value.harness, value.accountId)
  const defaults = useHarnessDefaultsQuery()
  const [open, setOpen] = useState(false)
  const [choosingModel, setChoosingModel] = useState(false)
  const [search, setSearch] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)
  const id = useId()
  const models = catalog.data?.models ?? []
  const model = models.find((item) => item.id === value.model)
  const modelName = model?.name || value.model.split('/').at(-1) || value.model
  const efforts: readonly string[] = value.harness === 'codex' ? supportedEfforts(model)
    : (model?.reasoningEfforts ?? []).filter((effort) => ClaudeEffortSchema.safeParse(effort).success)
  const effort = value.harness === 'codex' ? value.reasoningEffort : value.harness === 'claude' ? value.effort ?? '' : ''
  const fastSupported = model?.serviceTiers.includes('priority') === true
  // A native top-layer surface placed from the trigger, so it can never open outside the viewport or be clipped by the chat.
  useFloatingSurface(open, trigger, panel, 288, 'end')
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false) }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])
  useEffect(() => {
    if (disabled || !restoreFocus.current) return
    if (document.activeElement === document.body && restoreFocus.current.isConnected) restoreFocus.current.focus()
    restoreFocus.current = null
  }, [disabled])
  function update(next: OperatorChatSettings) {
    if (root.current?.contains(document.activeElement)) restoreFocus.current = document.activeElement as HTMLElement
    onChange(next)
  }
  function chooseModel(id: string) {
    const next = models.find((item) => item.id === id)
    if (!next) return
    if (value.harness === 'codex') {
      const allowed = supportedEfforts(next)
      update({ ...value, model: next.id, reasoningEffort: allowed.includes(value.reasoningEffort) ? value.reasoningEffort : allowed.includes('medium') ? 'medium' : allowed[0] ?? value.reasoningEffort,
        serviceTier: next.serviceTiers.includes(value.serviceTier) ? value.serviceTier : 'standard' })
    } else if (value.harness === 'claude') {
      const effort = ClaudeEffortSchema.safeParse(next.reasoningEfforts.includes(value.effort ?? '') ? value.effort
        : next.reasoningEfforts.includes('medium') ? 'medium' : next.reasoningEfforts.find((effort) => ClaudeEffortSchema.safeParse(effort).success))
      const settings = { ...value }
      delete settings.effort
      update({ ...settings, model: next.id, ...(effort.success ? { effort: effort.data } : {}) })
    }
    setChoosingModel(false)
  }
  return <div className="operator-agent-picker" ref={root} onKeyDown={(event) => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault(); event.stopPropagation()
    if (choosingModel) setChoosingModel(false)
    else { setOpen(false); trigger.current?.focus() }
  }}>
    <button ref={trigger} type="button" className="operator-agent-trigger" aria-label={`Agent settings: ${modelName}${value.harness === 'claude' && !effort ? '' : `, ${effort || 'default effort'}`}${value.harness === 'codex' && value.serviceTier === 'priority' ? ', Fast' : ''}`}
      aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="dialog" disabled={disabled}
      onClick={() => { setOpen(!open); setChoosingModel(false) }}>
      <span>{modelName}</span>{value.harness !== 'claude' || effort ? <small>{effort || 'default'}</small> : null}{value.harness === 'codex' && value.serviceTier === 'priority' ? <small className="operator-fast-indicator">Fast</small> : null}<Icon name="down" size={13} />
    </button>
    {open ? <div ref={panel} popover="manual" className="operator-agent-panel" id={id} role="dialog" aria-label="Agent settings">
      {choosingModel ? <>
        <Button size="sm" variant="ghost" leading={<Icon name="chevron" className="operator-chat-previous" size={14} />} onClick={() => setChoosingModel(false)}>Agent settings</Button>
        <SearchField autoFocus label="Search models" placeholder="Model name or ID" value={search} onChange={(event) => setSearch(event.target.value)} />
        <div className="operator-model-list" aria-label="Models">
          {models.filter((item) => `${item.id} ${item.name}`.toLowerCase().includes(search.toLowerCase())).map((item) =>
            <button type="button" key={item.id} disabled={disabled} aria-pressed={item.id === value.model} onClick={() => chooseModel(item.id)}>
              <span>{item.name || item.id}<small>{item.id}</small></span>{item.id === value.model ? <Icon name="check" size={14} /> : null}
            </button>)}
          {!models.some((item) => `${item.id} ${item.name}`.toLowerCase().includes(search.toLowerCase())) ? <p>No models match.</p> : null}
        </div>
      </> : <>
        <SegmentedControl label="Harness" value={value.harness}
          options={AgentHarnessSchema.options.map((harness) => ({ value: harness, label: harnessNames[harness], disabled: disabled || !defaults.data?.defaults[harness] }))}
          onValueChange={(harness) => {
            const selected = AgentHarnessSchema.safeParse(harness)
            const preset = selected.success ? defaults.data?.defaults[selected.data] : undefined
            if (preset) update(operatorChatSettings(preset, value.showThinking))
          }} />
        {value.harness === 'codex' || value.harness === 'claude' ? <ProviderAccountSelect
          provider={value.harness} value={value.accountId} disabled={disabled}
          onChange={accountId => {
            if (accountId) update({ ...value, accountId })
            else {
              const settings = { ...value }
              delete settings.accountId
              update(settings)
            }
          }} /> : null}
        <div className="n-field-label"><button className="operator-model-choice" type="button" aria-label={`${modelName} Choose model`} disabled={disabled || !catalog.isSuccess} onClick={() => { setChoosingModel(true); setSearch('') }}>
          <span>{modelName}</span><Icon name="chevron" size={14} />
        </button>{value.accountId ? <InfoHint label="Model">Options come from this account. Check the configuration before running.</InfoHint> : null}</div>
        {value.harness !== 'claude' || efforts.length > 0 || Boolean(effort) ? <Slider label="Effort" min={0} max={Math.max(0, efforts.length - 1)} step={1}
          value={Math.max(0, efforts.indexOf(effort))} disabled={disabled || !catalog.isSuccess || efforts.length < 2}
          format={(index) => efforts.includes(effort) ? efforts[index] ?? 'Default' : effort || 'Default'}
          onValueChange={(index) => {
            const next = efforts[index]
            if (!next) return
            if (value.harness === 'codex') {
              const effort = AgentEffortSchema.safeParse(next)
              if (effort.success) update({ ...value, reasoningEffort: effort.data })
            } else if (value.harness === 'claude') { const effort = ClaudeEffortSchema.safeParse(next); if (effort.success) update({ ...value, effort: effort.data }) }
          }} /> : null}
        {effort && !efforts.includes(effort) ? <p>Saved effort {effort} is unavailable for this model.</p> : null}
        {access}
        <div className="operator-agent-toggles">
        <Switch label="Fast mode" checked={value.harness === 'codex' && value.serviceTier === 'priority'}
          disabled={disabled || !catalog.isSuccess || value.harness !== 'codex' || (!fastSupported && value.serviceTier !== 'priority')}
          onChange={(event) => { if (value.harness === 'codex') update({ ...value, serviceTier: event.target.checked ? 'priority' : 'standard' }) }} />
        {hideThinking ? null : <Switch label="Show thinking" checked={value.showThinking} disabled={disabled} onChange={(event) => update({ ...value, showThinking: event.target.checked })} />}
        </div>
        {catalog.isPending ? <small role="status">Loading models…</small> : null}
        {catalog.isError || defaults.isError ? <div role="alert">Settings unavailable. <Button size="sm" onClick={() => { void catalog.refetch(); void defaults.refetch() }}>Retry</Button></div> : null}
      </>}
    </div> : null}
  </div>
}
