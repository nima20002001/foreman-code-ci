import { InfoHint } from '../../shared/ui/InfoHint'
import { useEffect, useId, useRef, type RefObject } from 'react'
import { useStore } from 'zustand'
import type { ScheduleGetInput } from '@foreman-code/contracts/schedules'
import { Button, Dialog, Select, Switch, TextField } from '../../shared/ui/nocturne'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import {
  buildScheduleCommand, draftIdentity, weeklyCalendarChanged,
  type ScheduleEditorStore, type ScheduleMode,
} from './editorStore'
import { useScheduleCommand, useWorkflowSchedule } from './queries'
import { recordScheduleUndo } from './undo'
import { useQueryClient } from '@tanstack/react-query'
import { ScheduleLastAttempt } from './ScheduleLastAttempt'

const modes: readonly { value: ScheduleMode; label: string }[] = [
  { value: 'weekly', label: 'Weekly' }, { value: 'interval', label: 'Interval' }, { value: 'once', label: 'Once' },
]
const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const

export function ScheduleModal({ scope, store, returnFocusRef }: {
  scope: ScheduleGetInput; store: ScheduleEditorStore; returnFocusRef: RefObject<HTMLButtonElement | null>
}) {
  const state = useStore(store)
  const query = useWorkflowSchedule(scope, state.open)
  const write = useScheduleCommand(scope)
  const client = useQueryClient()
  const id = useId()
  const form = useRef<HTMLFormElement>(null)
  const draft = state.draft
  const locked = write.pending || write.unconfirmed
  const conflict = write.conflict && state.expectedRevision === write.command?.input.expectedRevision
  const dirty = !!draft && draftIdentity(draft) !== state.initialIdentity

  useEffect(() => {
    // A fresh GET is required on every open. Never initialize from a failed/stale
    // read, and never copy a background read over an already-edited draft.
    if (!state.open || draft || query.isFetching || !query.isSuccess) return
    const value = query.data.schedule
    if (write.unconfirmed && write.command?.kind === 'save') {
      store.getState().initialize(write.command.input.schedule, write.command.input.expectedRevision)
    } else {
      store.getState().initialize(value, value?.revision ?? 0)
      if (write.unconfirmed && write.command?.kind === 'disable') store.getState().edit({ enabled: false })
    }
  }, [state.open, draft, query.isFetching, query.isSuccess, query.data, write.unconfirmed, write.command, store])

  useEffect(() => {
    if (!Object.keys(state.errors).length) return
    const invalid = form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')
    if (invalid instanceof HTMLFieldSetElement) invalid.querySelector('button')?.focus()
    else invalid?.focus()
  }, [state.errors])

  async function save(): Promise<boolean> {
    if (write.pending) return false
    try {
      if (write.unconfirmed) {
        const result = await write.retry()
        if (result) store.getState().hide()
        return !!result
      }
      if (conflict) return false
      const validated = buildScheduleCommand(scope, store.getState())
      if (validated.errors) { store.getState().setErrors(validated.errors); return false }
      const previous = query.data?.schedule ?? null
      const result = await write.submit(validated.command)
      if (result) { recordScheduleUndo(scope, previous, result.value, client); store.getState().hide() }
      return !!result
    } catch {
      // TanStack retains the normalized error and original command, not this form.
      return false
    }
  }

  const requestLeave = useUnsavedChanges({
    scope: 'surface', label: 'Schedule', dirty: state.open && dirty,
    busy: state.open && write.pending, uncertain: state.open && write.unconfirmed,
    // The command cache survives remounts, not a document reload. The existing guard
    // therefore must not advertise a recoverable reload/navigation for an unknown save.
    canResume: () => false,
    saveDisabled: (!draft && !write.unconfirmed) || conflict,
    save: async () => { if (!await save()) throw new Error('Schedule not saved.') },
    discard: () => store.getState().hide(),
  })
  function close() {
    if (!locked) void requestLeave(() => store.getState().hide())
  }
  function reload() {
    if (!locked) void requestLeave(() => {
      store.getState().show()
      void query.refetch()
    })
  }

  const persisted = query.data?.schedule
  const nextAt = !query.isError ? persisted?.nextOccurrenceAt : null
  const nextLabel = nextAt && persisted ? new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    ...(persisted.mode === 'interval' && persisted.unit === 'second' ? { second: '2-digit' as const } : {}), timeZoneName: 'short',
  }).format(new Date(nextAt)) : null
  const failure = write.unconfirmed ? 'Save unconfirmed.' : conflict ? 'Schedule changed.'
    : write.error && write.command?.input.expectedRevision === state.expectedRevision ? 'Not saved.' : null

  return <Dialog open={state.open} onOpenChange={(open) => { if (!open) close() }} title="Schedule" size="sm"
    headerLeading={<InfoHint label="Schedule">Runs latest saved workflow</InfoHint>}
    className="schedule-dialog" closeLabel="Close schedule" busy={write.pending} dismissible={!write.unconfirmed}
    closeOnOutsideClick returnFocusRef={returnFocusRef}
    footer={<>
      <Button size="sm" disabled={locked} onClick={close}>Cancel</Button>
      <Button size="sm" variant="primary" type="submit" form={`${id}-form`} loading={write.pending}
        disabled={!write.unconfirmed && (!draft || conflict)}>{write.unconfirmed ? 'Retry' : 'Save'}</Button>
    </>}>
    <form id={`${id}-form`} ref={form} className="schedule-form" noValidate onSubmit={(event) => { event.preventDefault(); void save() }}>
      {state.open && !draft && query.isFetching && <p role="status" className="schedule-note">Loading…</p>}
      {state.open && !draft && query.isError && <div className="schedule-feedback"><p role="alert">Could not load.</p>
        <Button size="sm" onClick={() => { void query.refetch() }}>Retry load</Button></div>}
      {draft && <fieldset className="schedule-fields" disabled={locked}>
        <legend className="schedule-sr-only">Schedule settings</legend>
        <div role="tablist" aria-label="Schedule mode" className="schedule-tabs">
          {modes.map((mode, index) => <button type="button" role="tab" key={mode.value} id={`${id}-${mode.value}`}
            aria-selected={draft.mode === mode.value} aria-controls={`${id}-panel`} tabIndex={draft.mode === mode.value ? 0 : -1}
            onClick={() => state.edit({ mode: mode.value })} onKeyDown={(event) => {
              const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? modes.length - 1 : (index + offset + modes.length) % modes.length
              if (!offset && event.key !== 'Home' && event.key !== 'End') return
              event.preventDefault()
              const target = modes[next]
              if (target) { state.edit({ mode: target.value }); document.getElementById(`${id}-${target.value}`)?.focus() }
            }}>{mode.label}</button>)}
        </div>
        <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${draft.mode}`} className="schedule-panel">
          {draft.mode === 'weekly' && <>
            {draft.weeklyOriginal && draft.weeklyOriginal.timezone !== draft.timezone && <p className="schedule-note">
              Saved: {draft.weeklyOriginal.weekdays.map((day) => weekdays[day - 1]?.slice(0, 2)).join(', ')} at {draft.weeklyOriginal.time} ({draft.weeklyOriginal.timezone}).
              {' '}{weeklyCalendarChanged(draft) ? `Changes use this device (${draft.timezone}).` : 'Time shown for the next occurrence. Editing days or time uses this device.'}
            </p>}
            <fieldset className="schedule-days" aria-invalid={!!state.errors.weekdays} aria-describedby={state.errors.weekdays ? `${id}-days-error` : undefined}>
              <legend>Days</legend>
              <div className="schedule-day-grid">{weekdays.map((day, index) => {
                const value = index + 1
                return <button key={day} type="button" aria-label={day} title={day} aria-pressed={draft.weekdays.includes(value)}
                  onClick={() => state.edit({ weekdays: draft.weekdays.includes(value) ? draft.weekdays.filter((item) => item !== value)
                    : [...draft.weekdays, value].sort((a, b) => a - b) })}>{day.slice(0, 2)}</button>
              })}</div>
              {state.errors.weekdays && <span id={`${id}-days-error`} className="n-field-error">{state.errors.weekdays}</span>}
            </fieldset>
            <TextField label="Time" type="time" value={draft.time} error={state.errors.time} onChange={(event) => state.edit({ time: event.currentTarget.value })} />
          </>}
          {draft.mode === 'interval' && <div className="schedule-pair">
            <TextField label="Every" type="number" inputMode="numeric" min={1} step={1} value={draft.every} error={state.errors.every}
              onChange={(event) => state.edit({ every: event.currentTarget.value })} />
            <Select label="Unit" value={draft.unit} options={[{ value: 'second', label: 'Seconds' }, { value: 'minute', label: 'Minutes' }, { value: 'hour', label: 'Hours' }]}
              onChange={(event) => {
                const unit = event.currentTarget.value
                if (unit === 'second' || unit === 'minute' || unit === 'hour') state.edit({ unit })
              }} />
          </div>}
          {draft.mode === 'once' && <div className="schedule-pair schedule-once">
            <TextField label="Date" type="date" value={draft.localDate} error={state.errors.localDate}
              onChange={(event) => state.edit({ localDate: event.currentTarget.value })} />
            <TextField label="Time" type="time" value={draft.time} error={state.errors.time}
              onChange={(event) => state.edit({ time: event.currentTarget.value })} />
          </div>}
        </div>
        {state.errors.timezone && <p role="alert" className="n-field-error">{state.errors.timezone}</p>}
        <Switch label="Enabled" checked={draft.enabled} onChange={(event) => state.edit({ enabled: event.currentTarget.checked })} />
      </fieldset>}
      <p className="schedule-next" role="status">Next {query.isError ? 'unavailable' : nextAt
        ? <time dateTime={nextAt} title={nextLabel ?? undefined}>{nextLabel}</time>
        : query.isFetching && !query.data ? '…' : '—'}</p>
      <ScheduleLastAttempt scope={scope} open={state.open} />
      {(failure || state.errors.form) && <div className="schedule-feedback"><p role="alert">{state.errors.form ?? failure}</p>
        {conflict && <Button size="sm" onClick={reload}>Reload</Button>}</div>}
    </form>
  </Dialog>
}
