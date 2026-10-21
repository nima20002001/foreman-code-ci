import { errorMessage } from '../../shared/errorMessage'
import { useEffect, useId, type SetStateAction } from 'react'
import { create } from 'zustand'

import { CommandAttempt } from '../../shared/api/commandAttempt'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { validationIssues, type FieldIssue } from './fieldValidation'
import { reapplySettingsEdits, settingsChanges } from './revisionedFormChanges'

export interface Snapshot<T> { value: T; revision: number }
interface Request<T> { value: T; expectedRevision: number; commandId: string }
interface Pending<T> {
  submitted: T
  request: Request<T>
  attempt: CommandAttempt<{ value: T; expectedRevision: number }>
  state: 'sending' | 'uncertain'
}
export interface Form<T> {
  value: T
  base: Snapshot<T>
  latest?: Snapshot<T>
  pending?: Pending<T>
  error?: string
  issues?: FieldIssue[]
  savedRevision?: number
}
const useForms = create<{ forms: Record<string, Form<unknown>> }>(() => ({ forms: {} }))
let epoch = 0
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right) }

export function clearRevisionedFormPersistence(): void {
  ++epoch
  useForms.setState({ forms: {} })
}

export function refreshRevisionedForm<T>(current: Form<T> | undefined, incoming: Snapshot<T>): Form<T> {
  if (current && incoming.revision < Math.max(current.base.revision, current.latest?.revision ?? 0)) return current
  if (!current || (!current.pending && same(current.value, current.base.value))) {
    return { value: incoming.value, base: incoming, latest: incoming,
      savedRevision: current?.base.revision === incoming.revision ? current.savedRevision : undefined }
  }
  return { ...current, latest: incoming }
}

function update<T>(key: string, change: (current: Form<T> | undefined) => Form<T> | undefined): void {
  useForms.setState((state) => {
    const current = state.forms[key] as Form<T> | undefined
    const next = change(current)
    if (next === current) return state
    const forms = { ...state.forms }
    if (next) forms[key] = next as Form<unknown>
    else delete forms[key]
    return { forms }
  })
}

function acknowledged<T>(current: Form<T> | undefined, submitted: T, value: T, revision: number): Form<T> {
  if (current && current.base.revision > revision) return { ...current, pending: undefined, error: undefined, issues: undefined, savedRevision: revision }
  const base = { value, revision }
  return {
    value: !current || same(current.value, submitted) ? value : current.value,
    base,
    latest: current?.latest && current.latest.revision > revision ? current.latest : base,
    savedRevision: revision,
  }
}

/** A command and its exact payload outlive the initiating component, but never its access session. */
export async function saveRevisionedForm<T>(
  key: string,
  perform: (request: Request<T>) => Promise<Snapshot<T>>,
  prepare: (value: T) => T = (value) => value,
): Promise<boolean> {
  const generation = sessionGeneration()
  const startedEpoch = epoch
  const current = useForms.getState().forms[key] as Form<T> | undefined
  if (!current || current.pending?.state === 'sending') return false
  if (!current.pending && current.latest && current.base.revision !== current.latest.revision) {
    update<T>(key, (form) => form && ({ ...form, error: 'These settings changed elsewhere. Review the changes, then reapply your edits or explicitly discard them.' }))
    return false
  }
  let pending: Pending<T> | undefined
  try {
    if (current.pending) pending = { ...current.pending, state: 'sending' }
    else {
      const attempt = new CommandAttempt<{ value: T; expectedRevision: number }>()
      const submitted = structuredClone(current.value)
      const request = attempt.input({ value: prepare(structuredClone(submitted)), expectedRevision: current.base.revision })
      pending = { submitted, request, attempt, state: 'sending' }
    }
    const active = pending
    update<T>(key, (form) => form && ({ ...form, pending: active, error: undefined, issues: undefined, savedRevision: undefined }))
    const response = await perform(active.request)
    if (generation !== sessionGeneration() || startedEpoch !== epoch) return false
    active.attempt.succeeded()
    update<T>(key, (form) => acknowledged(form, active.submitted, response.value, response.revision))
    return true
  } catch (error) {
    if (generation !== sessionGeneration() || startedEpoch !== epoch) return false
    pending?.attempt.failed(error)
    const retained = pending?.attempt.unresolved ? { ...pending, state: 'uncertain' as const } : undefined
    const issues = validationIssues(error)
    update<T>(key, (form) => form && ({
      ...form, pending: retained, issues, savedRevision: undefined,
      error: issues.length ? 'Review the marked fields before saving.' : errorMessage(error, 'Settings could not be saved.'),
    }))
    return false
  }
}

/** Zustand owns both the editable snapshot and the outstanding command across route mounts. */
export function useRevisionedForm<T>(incoming: Snapshot<T> | undefined, persistenceKey?: string) {
  const localId = useId()
  const generation = sessionGeneration()
  const key = `${generation}:${persistenceKey ?? localId}`
  const form = useForms((state) => state.forms[key]) as Form<T> | undefined
  const incomingKey = JSON.stringify(incoming)
  const isDirty = Boolean(form && !same(form.value, form.base.value))
  const hasPending = Boolean(form?.pending)
  useEffect(() => {
    if (!incoming || generation !== sessionGeneration()) return
    update<T>(key, (current) => {
      const next = refreshRevisionedForm(current, incoming)
      // Do not serialize the command tracker; it carries behavior, not form data.
      return current && same(current.value, next.value) && same(current.base, next.base)
        && same(current.latest, next.latest) ? current : next
    })
    // The serialized key tracks server content, not a newly allocated wrapper.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, incomingKey, generation, isDirty, hasPending])
  // A save refetch can arrive before its acknowledgement identifies the revision it wrote.
  const conflicted = Boolean(form?.pending?.state !== 'sending' && form?.latest
    && form.base.revision !== form.latest.revision && isDirty)
  return {
    draft: form?.value,
    baseRevision: form?.base.revision,
    isDirty,
    conflicted,
    isSaving: form?.pending?.state === 'sending',
    uncertain: form?.pending?.state === 'uncertain',
    pendingCommandId: form?.pending?.request.commandId,
    error: form?.error,
    issues: form?.issues,
    savedRevision: form?.savedRevision,
    serverChanges: conflicted && form?.latest ? settingsChanges(form.base.value, form.latest.value) : [],
    localChanges: conflicted && form ? settingsChanges(form.base.value, form.value) : [],
    setDraft: (next: SetStateAction<T | undefined>) => {
      if (generation !== sessionGeneration()) return
      update<T>(key, (current) => {
        if (!current) return current
        const value = typeof next === 'function' ? (next as (value: T) => T | undefined)(current.value) : next
        return value === undefined ? current : { ...current, value, issues: undefined, savedRevision: undefined,
          error: current.pending ? current.error : undefined }
      })
    },
    acknowledge: (submitted: T, value: T, revision: number) => {
      if (generation === sessionGeneration()) update<T>(key, (current) => acknowledged(current, submitted, value, revision))
    },
    save: (perform: (request: Request<T>) => Promise<Snapshot<T>>, prepare?: (value: T) => T) =>
      generation === sessionGeneration() ? saveRevisionedForm(key, perform, prepare) : Promise.resolve(false),
    reapply: () => {
      if (generation !== sessionGeneration()) return
      update<T>(key, (current) => {
        if (!current?.latest || current.pending || current.latest.revision === current.base.revision) return current
        return { value: reapplySettingsEdits(current.base.value, current.value, current.latest.value),
          base: current.latest, latest: current.latest }
      })
    },
    reset: () => {
      if (generation !== sessionGeneration()) return
      update<T>(key, (current) => {
        if (current?.pending) return current
        const latest = current?.latest ?? incoming
        return latest ? { value: latest.value, base: latest, latest } : current
      })
    },
  }
}
