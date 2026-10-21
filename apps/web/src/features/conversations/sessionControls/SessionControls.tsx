import { InfoHint } from '../../../shared/ui/InfoHint'
import { useFloatingSurface } from '../../../shared/ui/nocturne/useFloatingSurface'
import { useEffect, useId, useRef, useState } from 'react'
import { compactionBlocksSend, type SessionPreferences } from '@foreman-code/contracts'
import { Button, TextField, Select } from '../../../shared/ui/nocturne'
import type { ComposerSessionControls } from './useSessionControls'
import './sessionControls.css'

// ignore: a failed control change is shown from the mutation error state.
const ignoreRejection = () => undefined

export function SessionContext({ controls }: { controls: ComposerSessionControls }) {
  const state = controls.state
  const id = useId()
  const [open, setOpen] = useState(false)
  const budgetOwner = JSON.stringify([controls.scope, state?.conversationId, state?.profileKey])
  const [budgetDraft, setBudgetDraft] = useState<{ owner: string; value: string }>()
  const budgetEdited = budgetDraft?.owner === budgetOwner
  const budget = budgetEdited ? budgetDraft.value : String(state?.desired.autoCompactTokens ?? '')
  const saveDefault = useRef<HTMLButtonElement>(null)
  const anchor = useRef<HTMLButtonElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  useFloatingSurface(open, anchor, surface, 320, 'end')
  useEffect(() => { setOpen(false) }, [budgetOwner])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !surface.current?.contains(event.target) && !anchor.current?.contains(event.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  const close = () => {
    setOpen(false)
    anchor.current?.focus()
  }
  if (!state) return null
  const context = state.context
  // Before the first turn nothing is used yet; the window is whatever the model advertises.
  const capacity = context?.capacityTokens ?? state.capabilities.modelCapacity ?? state.capabilities.nativeDefaultCapacity ?? null
  const used = context ? context.usedTokens : 0
  const percentage = used !== null && capacity !== null ? Math.round(used / capacity * 100) : null
  const estimated = context?.accuracy === 'estimated'
  const percentagePrefix = estimated ? 'About ' : ''
  const usagePrefix = estimated ? 'Estimated usage: ' : ''
  const compactReason = state.busyReason ?? (compactionBlocksSend(state.compaction) ? 'Compaction is still unconfirmed. Refresh its status.'
    : state.capabilities.compact.reason)
  const pending = controls.mutation.isPending
  const update = (preferences: SessionPreferences) => { void controls.change({ kind: 'preferences', preferences }).catch(ignoreRejection) }
  // A window or usage that is not known yet shows nothing rather than an "unknown" meter.
  if (percentage === null) return null
  const meterLabel = `${percentagePrefix}${percentage}% context${context?.stale ? ' · stale' : ''}`
  return <div className="session-context">
      <Button ref={anchor} size="sm" variant="ghost" className="session-context-meter" aria-label={meterLabel} title={meterLabel}
        aria-expanded={open} aria-controls={`${id}-context`} data-stale={context?.stale ? 'true' : undefined}
        onClick={() => setOpen(value => !value)}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" opacity=".2" strokeWidth="2.5" />
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.5"
            strokeDasharray={`${Math.min(100, percentage) * .5655} 56.55`} transform="rotate(-90 12 12)" />
        </svg>
        <span aria-hidden="true">{context ? `${percentage}%`
          : `${capacity!.toLocaleString()} of ${capacity!.toLocaleString()} left`}</span>
      </Button>
      {open ? <div ref={surface} popover="manual" id={`${id}-context`} className="session-context-popover" onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
      }}>
        <h3 className="session-context-title">Context</h3>
        <div className="session-context-bar" aria-hidden="true"><span style={{ width: `${Math.min(100, percentage)}%` }} /></div>
        <div className="session-context-facts">
        <p>{`${usagePrefix}${used!.toLocaleString()} tokens in context`}
          {` / ${capacity!.toLocaleString()} native context window`}</p>
        {state.applied?.contextBudget ? <p>Configured budget: {state.applied.contextBudget.toLocaleString()}</p> : null}
        {state.capabilities.modelCapacity !== null ? <p>Model capacity: {state.capabilities.modelCapacity.toLocaleString()}</p> : null}
        {state.capabilities.nativeDefaultCapacity != null ? <p>
          Native default window: {state.capabilities.nativeDefaultCapacity.toLocaleString()} tokens
        </p> : null}
        {context?.stale ? <p>Last known usage. Waiting for a native update.</p> : null}
        {context?.lifetimeTokens != null ? <p>Total processed: {context.lifetimeTokens.toLocaleString()}</p> : null}
        {context?.cost != null ? <p>Total cost: {context.cost}</p> : null}
        <p>Automatic compaction: {state.applied?.autoCompact ?? 'Native default'}</p>
        {state.applied?.autoCompactTokens ? <p>Automatic budget: {state.applied.autoCompactTokens.toLocaleString()}</p> : null}
        </div>
        <details><summary>Context options for this chat
          {!state.capabilities.contextBudgets.length && !state.capabilities.contextBudgetReason &&
            <InfoHint label="Context options">Context size follows the native model/profile.</InfoHint>}
          </summary>
          {state.capabilities.contextBudgets.length ? <Select label="Context budget" value={String(state.desired.contextBudget ?? '')}
            options={[{ value: '', label: 'Native default' }, ...state.capabilities.contextBudgets.map(value => ({ value: String(value), label: value.toLocaleString() }))]}
            disabled={pending} onChange={event => update({ ...state.desired, contextBudget: event.target.value ? Number(event.target.value) : null })} /> : null}
          {!state.capabilities.contextBudgets.length && state.capabilities.contextBudgetReason
            ? <p>{state.capabilities.contextBudgetReason}</p> : null}
          {state.capabilities.contextProfiles.length ? <Select label="Context profile" options={[{ value: '', label: 'Native default' }, ...state.capabilities.contextProfiles.map(profile => ({ value: profile.id, label: profile.label }))]} value={state.desired.contextProfile ?? ''} disabled={pending}
            onChange={event => update({ ...state.desired, contextProfile: event.target.value || null })} /> : null}
          {state.capabilities.autoCompact.supported ? <Select label="Auto compact" options={[{ value: 'default', label: 'Default' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} value={state.desired.autoCompact} disabled={pending}
            onChange={event => update({ ...state.desired, autoCompact: event.target.value as SessionPreferences['autoCompact'] })} /> : null}
          {state.capabilities.autoCompactBudget.supported ? <TextField label="Auto-compaction budget" type="number" min="100000" max={state.capabilities.modelCapacity ?? 1000000}
              placeholder="Native default" value={budget} disabled={pending}
              onChange={event => setBudgetDraft({ owner: budgetOwner, value: event.target.value })}
              onBlur={event => {
                if (pending) return
                if (event.relatedTarget instanceof Node && saveDefault.current?.contains(event.relatedTarget)) return
                if (!budgetEdited) return
                setBudgetDraft(undefined)
                const tokens = budget ? Number(budget) : null
                if (tokens !== state.desired.autoCompactTokens) update({ ...state.desired, autoCompactTokens: tokens })
              }} /> : null}
          <p>{state.applicability === 'applied' ? 'Applied now' : `Applies ${state.applicability.replace('-', ' ')}`}</p>
          <Button ref={saveDefault} size="sm" variant="secondary" disabled={pending}
            onMouseDown={event => { if (budgetEdited) event.preventDefault() }} onClick={() => {
              const autoCompactTokens = budget ? Number(budget) : null
              const preferences = budgetEdited ? { ...state.desired, autoCompactTokens } : state.desired
              void controls.change({ kind: 'save-default', preferences }).then(() => {
                setBudgetDraft(draft => draft?.owner === budgetOwner && draft.value === budget ? undefined : draft)
              }).catch(ignoreRejection)
          }}>Save as default for future chats</Button>
        </details>
        {compactReason ? <p className="session-context-note">{compactReason}</p> : null}
        {state.compaction ? <p className="session-context-note" role="status">{state.compaction.message}</p> : null}
        <div className="session-context-actions">
          <Button size="sm" disabled={pending || !!compactReason} title={compactReason ?? undefined}
            onClick={() => { void controls.change({ kind: 'compact' }).catch(ignoreRejection) }}>Compact context</Button>
          <Button size="sm" variant="ghost" onClick={() => { void controls.query.refetch() }}>Refresh status</Button>
          <Button size="sm" variant="ghost" onClick={close}>Close context details</Button>
        </div>
      </div> : null}
    </div>
}
