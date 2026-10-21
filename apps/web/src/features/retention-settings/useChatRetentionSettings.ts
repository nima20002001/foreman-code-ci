import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError } from '../../shared/api/client'
import { assertSession, sessionGeneration, sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { useRevisionedForm } from '../settings/revisionedForm'
import { pendingRetentionCommand, useRetentionCommand, type RetentionCommand } from './retentionCommand'
import { matchesRetentionPreview, retentionDraft, retentionSeconds, type RetentionDraft } from './retentionDraft'
import {
  readRetentionPreference, useRetentionPreferenceQuery, useRetentionPreviewMutation, useRetentionSaveMutation,
} from './retentionQueries'

/** Query owns requests/readbacks; the existing Zustand revisioned form owns edits and exact retries. */
export function useChatRetentionSettings() {
  const client = useQueryClient()
  const generation = sessionGeneration()
  const query = useRetentionPreferenceQuery()
  const preference = query.data?.preference
  const journal = useRetentionCommand(preference?.ownerPrincipalId)
  const form = useRevisionedForm<RetentionDraft>(preference ? {
    value: retentionDraft(preference), revision: preference.revision,
  } : undefined, `settings:file-retention:${preference?.ownerPrincipalId ?? 'loading'}`)
  const preview = useRetentionPreviewMutation()
  const mutation = useRetentionSaveMutation()
  const previewGeneration = useRef(0)
  useEffect(() => () => { ++previewGeneration.current }, [])
  const draft = journal.pending?.draft ?? form.draft
  const uncertain = form.uncertain || Boolean(journal.pending && !form.isSaving)
  const durationSeconds = draft ? retentionSeconds(draft) : undefined
  const busy = form.isSaving || mutation.isPending || preview.isPending
  const blocked = sessionIsSwitching() || query.isError || query.isFetching || form.conflicted
  const previewMatches = matchesRetentionPreview(preview.data, form.draft, preference?.ownerPrincipalId, form.baseRevision)
    && preference?.revision === form.baseRevision && !form.conflicted

  function dismissPreview() {
    ++previewGeneration.current
    preview.reset()
  }

  function edit(draft: RetentionDraft) {
    if (busy || uncertain || !journal.ready || journal.error || sessionIsSwitching()) return
    dismissPreview()
    form.setDraft(draft)
  }

  async function refresh() {
    journal.reload()
    try { await readRetentionPreference(client, generation) } catch { /* Query exposes the error; edits stay put. */ }
  }

  async function save(pinned?: RetentionCommand) {
    // The shared form provides synchronous admission and keeps edits on errors.
    // After a hard reload its new local tracker must still send the ORIGINAL HTTP
    // command, not the tracker's newly allocated id or the freshly fetched revision.
    await form.save(async ({ value, commandId, expectedRevision }) => {
      assertSession(generation)
      const seconds = retentionSeconds(value)
      if (seconds === undefined || !preference) throw new ApiError({ code: 'INVALID_REQUEST', message: 'Use 1 hour–365 days.' })
      try {
        const current = await mutation.mutateAsync({
          input: pinned?.input ?? { commandId, expectedRevision, durationSeconds: seconds, applyToExisting: value.applyToExisting },
          draft: pinned?.draft ?? value,
          ownerPrincipalId: preference.ownerPrincipalId,
        })
        return { value: retentionDraft(current.preference), revision: current.preference.revision }
      } catch (error) {
        if (ApiError.is(error) && error.code === 'REVISION_CONFLICT') await refresh()
        throw error
      }
    })
  }

  async function requestSave() {
    if (busy || !form.draft || !journal.ready || journal.error || sessionIsSwitching() || generation !== sessionGeneration()) return
    const pending = journal.key ? pendingRetentionCommand(journal.key) : undefined
    if (pending) {
      dismissPreview()
      // Rebase ONLY the local tracker so it can resolve an already issued command.
      // The retained HTTP payload still carries its original expectedRevision.
      form.reapply()
      form.setDraft(pending.draft)
      await save(pending)
      return
    }
    // Never run a new preview or mint a new command when the original result is unknown.
    if (form.uncertain) { await save(); return }
    if (blocked || durationSeconds === undefined || !form.isDirty || !preference || form.baseRevision === undefined) return
    dismissPreview()
    if (!form.draft?.applyToExisting) { await save(); return }
    const attempt = previewGeneration.current
    try {
      // Preview ALL apply-to-existing changes, even extensions: older files may
      // have a longer creation snapshot than the current preference.
      const result = await preview.mutateAsync({
        input: { durationSeconds }, ownerPrincipalId: preference.ownerPrincipalId, expectedRevision: form.baseRevision,
      })
      assertSession(generation)
      if (attempt !== previewGeneration.current) return
      if (result.expireNowCount === 0) { dismissPreview(); await save() }
    } catch (error) {
      if (attempt === previewGeneration.current && ApiError.is(error) && error.code === 'REVISION_CONFLICT') await refresh()
    }
  }

  function confirm() {
    if (!journal.ready || journal.pending || journal.error || !previewMatches || busy || blocked || !preview.data?.expireNowCount) return
    dismissPreview()
    void save()
  }

  function reapply() {
    if (busy || uncertain || query.isFetching || query.isError) return
    dismissPreview()
    form.reapply()
  }

  return {
    query, form, preview, journal, draft, uncertain, busy, durationSeconds, edit, refresh, requestSave, reapply, confirm, dismissPreview,
    confirmation: previewMatches && !journal.pending && !form.uncertain && !form.isSaving && (preview.data?.expireNowCount ?? 0) > 0
      ? preview.data : undefined,
    saveDisabled: busy || !form.draft || !journal.ready || Boolean(journal.error) || sessionIsSwitching() || (!uncertain && (blocked || !form.isDirty || durationSeconds === undefined)),
  }
}
