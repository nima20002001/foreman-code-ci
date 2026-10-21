import { useRef, useState } from 'react'
import type { MemoryBoardMutation } from '@foreman-code/contracts'
import { Button } from '../../shared/ui/nocturne/Button'
import { Textarea, TextField } from '../../shared/ui/nocturne/Fields'
import type { NoteDraft } from './drafts'
import type { MemoryReceipt } from './ports'
import { noteDraftCommand } from './noteEditing'

export function MemoryNoteEditor({ boardId, draft, disabled, pending, onChange, onSave, onCancel }: {
  boardId: string; draft: NoteDraft; disabled: boolean; pending: boolean
  onChange(draft: NoteDraft): void; onSave(command: MemoryBoardMutation): Promise<MemoryReceipt | undefined>; onCancel(): void
}) {
  const [error, setError] = useState<string>()
  const textRef = useRef<HTMLTextAreaElement>(null), rankRef = useRef<HTMLInputElement>(null)
  return <form className="n-stack memory-editor" onSubmit={(event) => {
    event.preventDefault()
    if (!draft.text.trim()) { setError('Write a note, or archive it.'); textRef.current?.focus(); return }
    const rank = draft.rank === '' ? undefined : Number(draft.rank)
    if (rank !== undefined && (!Number.isSafeInteger(rank) || rank < 0)) { setError('Display order must be a nonnegative whole number.'); rankRef.current?.focus(); return }
    setError(undefined)
    void onSave(noteDraftCommand(boardId, draft)).catch(() => {
      // Query owns the error display; keep the note and focus available for correction.
      textRef.current?.focus()
    })
  }}>
    <h3>{draft.original ? 'Edit note' : 'Add note'}</h3>
    <Textarea ref={textRef} label="Note" value={draft.text} required maxLength={4000} rows={5} disabled={disabled}
      onChange={(event) => onChange({ ...draft, text: event.currentTarget.value, dirty: true })} />
    <details><summary>More options</summary><TextField ref={rankRef} label="Display order" type="number" min={0} step={1} value={draft.rank} disabled={disabled}
      hint="Lower numbers appear first; equal numbers keep a stable order. Leave blank to append a new note."
      onChange={(event) => onChange({ ...draft, rank: event.currentTarget.value, dirty: true })} /></details>
    {error && <p role="alert">{error}</p>}
    <div className="n-actions"><Button type="submit" variant="primary" disabled={disabled} loading={pending} loadingLabel="Saving…">Save note</Button>
      <Button disabled={pending} onClick={onCancel}>Back to Memory board</Button>{draft.dirty && <span>Not saved</span>}</div>
  </form>
}
