import { errorMessage } from '../../shared/errorMessage'
import { useEffect, useRef, useState } from 'react'
import { MAX_SKILL_INSTRUCTIONS_CHARS } from '@foreman-code/contracts'
import { SkillCreateInputSchema, type SkillSummary, type SkillVersion } from '@foreman-code/contracts/management'
import { ApiError } from '../../shared/api/client'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { useFileDrop } from '../../shared/ui/useFileDrop'
import { Alert, Button, Dialog, Icon, Select, Tabs, TextField, Textarea } from '../../shared/ui/nocturne'
import type { SelectOption } from '../../shared/ui/nocturne/Fields'
import { fieldMessage, focusFirstInvalid, validationIssues, type FieldIssue } from '../settings/fieldValidation'
import { readSkillFile } from './skillImport'
import { skillKeys, useCreateSkillMutation, useUpdateSkillMutation } from './skillsApi'
import { useQueryClient } from '@tanstack/react-query'

export interface SavedSkill { skill: SkillSummary; version: SkillVersion }
interface Draft { workspaceId: string; name: string; description: string; instructions: string }

function draftOf(saved: SavedSkill): Draft {
  return { workspaceId: saved.skill.workspaceId, name: saved.version.name, description: saved.version.description ?? '', instructions: saved.version.instructions }
}
const same = (left: Draft, right: Draft) => left.workspaceId === right.workspaceId && left.name.trim() === right.name.trim()
  && left.description.trim() === right.description.trim() && left.instructions === right.instructions

/** Instructions are shown exactly as stored. Nothing is rendered as HTML and nothing remote is loaded. */
export function SkillTextPreview({ text }: { text: string }) {
  return <pre className="skill-preview" tabIndex={0} aria-label="Instructions preview">{text || 'Nothing to preview yet.'}</pre>
}

/** Create or edit one logical skill. Each changed Save becomes a new immutable version on the server. */
export function SkillEditor({ saved, workspaceOptions, initialWorkspace, onSaved, onCancel, readOnly = false }: {
  saved?: SavedSkill | undefined
  workspaceOptions: SelectOption[]
  initialWorkspace?: string | undefined
  onSaved(result: SavedSkill, created: boolean): void
  onCancel(): void
  readOnly?: boolean
}) {
  const queryClient = useQueryClient()
  const create = useCreateSkillMutation()
  const update = useUpdateSkillMutation()
  const [base, setBase] = useState<SavedSkill | undefined>(saved)
  const [draft, setDraft] = useState<Draft>(() => saved ? draftOf(saved)
    : { workspaceId: initialWorkspace && workspaceOptions.some((option) => option.value === initialWorkspace) ? initialWorkspace
      : workspaceOptions.length === 1 ? workspaceOptions[0]!.value : '', name: '', description: '', instructions: '' })
  const [issues, setIssues] = useState<FieldIssue[]>([])
  const [error, setError] = useState<string>()
  const [conflict, setConflict] = useState<number>()
  const [view, setView] = useState('write')
  const [imported, setImported] = useState<{ name: string; text: string }>()
  const [importError, setImportError] = useState<string>()
  const [importing, setImporting] = useState(false)
  const readingFile = useRef(false)
  const [justSaved, setJustSaved] = useState(false)
  const attempt = useRef(new CommandAttempt<Record<string, unknown>>())
  const pending = useRef<Record<string, unknown>>(undefined)
  const [uncertain, setUncertain] = useState(false)
  const root = useRef<HTMLFormElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const baseline = base ? draftOf(base) : { workspaceId: draft.workspaceId, name: '', description: '', instructions: '' }
  const dirty = !same(draft, baseline)
  const saving = create.isPending || update.isPending
  const newer = saved && base && saved.skill.revision > base.skill.revision ? saved : undefined

  // Adopt a newer server head only while there are no local edits to lose.
  useEffect(() => {
    if (!newer || dirty || saving) return
    setBase(newer); setDraft(draftOf(newer)); setConflict(undefined)
  }, [newer, dirty, saving])
  useEffect(() => { if (issues.length) focusFirstInvalid(root.current) }, [issues])

  const change = (patch: Partial<Draft>) => { setDraft((current) => ({ ...current, ...patch })); setIssues([]); setError(undefined); setJustSaved(false) }

  async function save(expectedRevision = base?.skill.revision) {
    if (saving || readOnly) return
    setError(undefined)
    let body: Record<string, unknown> | undefined = uncertain ? pending.current : undefined
    if (!body) {
      const value = { workspaceId: draft.workspaceId, name: draft.name, instructions: draft.instructions,
        ...(draft.description.trim() ? { description: draft.description } : {}) }
      const parsed = SkillCreateInputSchema.safeParse({ ...value, commandId: 'validation-only' })
      const nextIssues = (parsed.success ? [] : validationIssues(parsed.error)).filter((issue) => issue.path[0] !== 'workspaceId')
      if (!draft.workspaceId) nextIssues.unshift({ path: ['workspaceId'], message: 'Choose the workspace that owns this skill.' })
      if (nextIssues.length) { setIssues(nextIssues); return }
      body = base ? { ...value, skillId: base.skill.skillId, expectedRevision } : value
    }
    let input: Record<string, unknown>
    try { input = attempt.current.input(body) } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); return }
    pending.current = body
    try {
      const result = base
        ? await update.mutateAsync(input as Parameters<typeof update.mutateAsync>[0])
        : await create.mutateAsync(input as Parameters<typeof create.mutateAsync>[0])
      attempt.current.succeeded(); pending.current = undefined; setUncertain(false); setConflict(undefined)
      const next = { skill: result.value.skill, version: result.value.version }
      setBase(next); setJustSaved(true)
      // Later keystrokes stay local; only the submitted values became the saved baseline.
      onSaved(next, !base)
    } catch (failure) {
      attempt.current.failed(failure)
      setUncertain(attempt.current.unresolved)
      if (!attempt.current.unresolved) pending.current = undefined
      if (ApiError.is(failure) && failure.code === 'SKILL_REVISION_CONFLICT') {
        setConflict(Number(failure.details?.currentRevision) || undefined)
        // Load the newer head so "load latest" shows it; the dirty draft is never replaced automatically.
        if (base) void queryClient.invalidateQueries({ queryKey: skillKeys.detail(base.skill.workspaceId, base.skill.skillId) }).catch(() => { /* ignore: a failed refresh leaves the conflict banner and draft intact */ })
        return
      }
      const fieldIssues = validationIssues(failure)
      if (fieldIssues.length) setIssues(fieldIssues)
      setError(errorMessage(failure, 'The skill could not be saved.'))
    }
  }
  const discard = () => { setDraft(baseline); setIssues([]); setError(undefined); setConflict(undefined) }
  const leave = useUnsavedChanges({ label: 'skill', dirty, busy: saving, uncertain, error, saveDisabled: readOnly || conflict !== undefined,
    save: () => save(), discard })

  async function chooseFile(file: File | undefined) {
    setImportError(undefined)
    if (!file || readOnly || saving || uncertain || imported || readingFile.current) return
    readingFile.current = true; setImporting(true)
    try {
      const result = await readSkillFile(file)
      if ('error' in result) setImportError(result.error); else setImported(result)
    } finally { readingFile.current = false; setImporting(false) }
  }
  const drop = useFileDrop({ disabled: readOnly || saving || uncertain || importing || Boolean(imported), maxFiles: 1,
    onFiles: (files) => { void chooseFile(files[0]) } })

  return <form ref={root} className="skill-editor" noValidate aria-label={base ? `Edit ${base.version.name}` : 'New skill'}
    onSubmit={(event) => { event.preventDefault(); void save() }}>
    {newer && dirty && conflict === undefined ? <Alert tone="warning" live title={`This skill was saved elsewhere as version ${newer.skill.version}. Your edits are kept.`}
      action={<Button size="sm" onClick={() => { setBase(newer); setDraft(draftOf(newer)); setConflict(undefined) }}>Discard my edits and load it</Button>} /> : null}
    <div className="skill-editor-fields">
      {base ? null : <Select label="Workspace" required value={draft.workspaceId} disabled={saving || uncertain}
        error={fieldMessage(issues, 'workspaceId')}
        options={[{ value: '', label: 'Choose a workspace', disabled: true }, ...workspaceOptions]} onChange={(event) => change({ workspaceId: event.target.value })} />}
      <TextField label="Name" required maxLength={200} value={draft.name} readOnly={readOnly} disabled={uncertain}
        error={fieldMessage(issues, 'name')} onChange={(event) => change({ name: event.target.value })} />
      <TextField label="Description" maxLength={1000} value={draft.description} readOnly={readOnly} disabled={uncertain} error={fieldMessage(issues, 'description')}
        onChange={(event) => change({ description: event.target.value })} />
      <div className="skill-instructions" {...drop.dropTargetProps}>
        <div className="skill-instructions-head">
          <span className="skill-instructions-label" id="skill-instructions-label">Instructions</span>
          {readOnly ? null : <>
            {/* eslint-disable-next-line no-restricted-syntax -- hidden single-file picker behind the Import button; FileDropzone is a full-page drop area. */}
            <input ref={fileInput} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden
              disabled={saving || uncertain || importing || Boolean(imported)}
              onChange={(event) => { drop.clearDropError(); void chooseFile(event.target.files?.[0]); event.target.value = '' }} />
            <Button size="sm" variant="ghost" disabled={saving || uncertain || importing || Boolean(imported)} leading={<Icon name="plus" size={14} />} onClick={() => fileInput.current?.click()}>Import Markdown file</Button>
          </>}
        </div>
        {importError ? <p className="n-field-error" role="alert">{importError}</p> : null}
        {drop.dropError ? <p className="n-field-error" role="alert">{drop.dropError}</p> : null}
        {importing && <p className="n-field-hint" role="status">Reading file…</p>}
        {/* // InfoHint: Import previews one Markdown or text file before replacing the draft. */}
        {drop.isDragging ? <p className="n-field-hint" role="status">Drop to import</p> : null}
        <Tabs label="Instructions view" value={view} onValueChange={setView} items={[
          { value: 'write', label: 'Write', content: <Textarea label="Instructions" className="skill-instructions-input" required rows={18}
            maxLength={MAX_SKILL_INSTRUCTIONS_CHARS} value={draft.instructions} readOnly={readOnly} disabled={uncertain} spellCheck={false}
            placeholder={'# When reviewing code\n\n- Check tests first\n- Explain each finding'} error={fieldMessage(issues, 'instructions')}
            hint={`${draft.instructions.length.toLocaleString()} / ${MAX_SKILL_INSTRUCTIONS_CHARS.toLocaleString()} characters`}
            onChange={(event) => change({ instructions: event.target.value })} /> },
          { value: 'preview', label: 'Preview', content: <SkillTextPreview text={draft.instructions} /> },
        ]} />
      </div>
    </div>
    {/* Save outcomes sit beside the Save button, where the user is looking. */}
    {conflict !== undefined ? <Alert tone="warning" live title="This skill changed since you opened it. Nothing was saved.">
      {/* // InfoHint: Load the saved version or publish these edits on top of it. */}
      <div className="skill-editor-actions-inline">
        <Button size="sm" disabled={!newer} onClick={() => { if (newer) { setBase(newer); setDraft(draftOf(newer)) } setConflict(undefined) }}>Discard my edits and load latest</Button>
        <Button size="sm" variant="primary" onClick={() => void save(conflict)}>Save my edits as a new version</Button>
      </div>
    </Alert> : null}
    {uncertain ? <Alert tone="warning" live title="The last save may have been stored. Retry save to confirm it; it will not create a duplicate." /> : null}
    {error && !uncertain ? <Alert tone="danger" live title="The skill was not saved.">{error} Your edits are still here.</Alert> : null}
    {justSaved && !dirty ? <p role="status" className="skill-saved">Saved as version {base?.skill.version}.</p> : <p role="status" className="n-sr-only" />}

    {readOnly ? null : <footer className="skill-editor-actions">
      <Button onClick={() => void leave(onCancel)} disabled={saving}>{dirty ? 'Cancel' : 'Close'}</Button>
      <Button type="submit" variant="primary" loading={saving} loadingLabel="Saving…" disabled={(!dirty && !uncertain) || conflict !== undefined}
        leading={<Icon name="check" size={14} />}>{uncertain ? 'Retry save' : base ? 'Save new version' : 'Create skill'}</Button>
    </footer>}
    <Dialog open={Boolean(imported)} onOpenChange={(open) => { if (!open) setImported(undefined) }} title="Use imported instructions?" size="lg"
      // InfoHint: Imported text replaces the draft; save separately to publish it.
      footer={<div className="n-actions"><Button onClick={() => setImported(undefined)}>Cancel</Button>
        <Button variant="primary" onClick={() => {
          if (imported) change({ instructions: imported.text, ...(draft.name.trim() ? {} : { name: imported.name }) })
          setImported(undefined); setView('write')
        }}>Use this text</Button></div>}>
      {imported ? <SkillTextPreview text={imported.text} /> : null}
    </Dialog>
  </form>
}
