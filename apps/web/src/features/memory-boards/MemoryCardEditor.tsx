import { useRef, useState } from 'react'
import type { MemoryBoardMutation } from '@foreman-code/contracts'
import { Button } from '../../shared/ui/nocturne/Button'
import { Select, Textarea, TextField } from '../../shared/ui/nocturne/Fields'
import type { CardDraft } from './drafts'
import type { MemoryNodeOption, MemoryReceipt } from './ports'
import { nodeKey, nodeLabel, statusLabels } from './presentation'
import { cardDraftCommand, cardDraftProblem } from './cardEditing'
import { MemoryWorkPicker } from './MemoryWorkPicker'

export interface MemoryCardEditorProps {
  boardId: string
  draft: CardDraft
  nodes: readonly MemoryNodeOption[]
  disabled: boolean
  pending: boolean
  onChange(draft: CardDraft): void
  onSave(command: MemoryBoardMutation): Promise<MemoryReceipt | undefined>
  onCancel(): void
}
export function MemoryCardEditor({ boardId, draft, nodes, disabled, pending, onChange, onSave, onCancel }: MemoryCardEditorProps) {
  const [problem, setProblem] = useState<ReturnType<typeof cardDraftProblem>>()
  const titleRef = useRef<HTMLInputElement>(null), reasonRef = useRef<HTMLTextAreaElement>(null)
  const change = (fields: Partial<CardDraft['fields']>) => onChange({ ...draft, dirty: true, fields: { ...draft.fields, ...fields } })
  const owner = draft.fields.assignee ? nodeKey(draft.fields.assignee) : ''
  const ownerMissing = draft.fields.assignee && !nodes.some((option) => nodeKey(option.node) === owner)
  return <form className="n-stack memory-editor" onSubmit={(event) => {
    event.preventDefault()
    const invalid = cardDraftProblem(draft)
    setProblem(invalid)
    if (invalid) { (invalid.field === 'title' ? titleRef.current : reasonRef.current)?.focus(); return }
    void onSave(cardDraftCommand(boardId, draft)).catch(() => {
      // The shared Query mutation displays the rejection and preserves this draft.
      titleRef.current?.focus()
    })
  }}>
    <h3>{draft.original ? 'Edit card' : 'New card'}</h3>
    <TextField ref={titleRef} label="Title" value={draft.fields.title} required maxLength={240} disabled={disabled}
      error={problem?.field === 'title' ? problem.message : undefined} onChange={(event) => change({ title: event.currentTarget.value })} />
    <Textarea label="Details" value={draft.fields.body} maxLength={8000} rows={4} disabled={disabled}
      onChange={(event) => change({ body: event.currentTarget.value })} />
    <Select label="Owner" value={owner} disabled={disabled} options={[
      { value: '', label: 'Unassigned' },
      ...(ownerMissing ? [{ value: owner, label: nodeLabel(draft.fields.assignee!, nodes), disabled: true }] : []),
      ...nodes.map((option) => ({ value: nodeKey(option.node), label: option.label, disabled: !option.available })),
    ]} onChange={(event) => change({ assignee: nodes.find((option) => nodeKey(option.node) === event.currentTarget.value)?.node ?? null })} />
    <Select label="Move to…" value={draft.fields.status} disabled={disabled}
      options={Object.entries(statusLabels).map(([value, label]) => ({ value, label }))}
      onChange={(event) => {
        const status = event.currentTarget.value as CardDraft['fields']['status']
        change({ status, completionKind: status === 'done' ? 'completed' : null,
          reason: status === 'blocked' || draft.original?.status === 'done' && status !== 'done' ? draft.fields.reason : null })
      }} />
    {draft.fields.status === 'done' && <Select label="Outcome" value={draft.fields.completionKind ?? 'completed'} disabled={disabled}
      options={[{ value: 'completed', label: 'Completed' }, { value: 'dropped', label: 'Dropped' }]}
      onChange={(event) => change({ completionKind: event.currentTarget.value as 'completed' | 'dropped', reason: event.currentTarget.value === 'completed' ? null : draft.fields.reason })} />}
    <Textarea ref={reasonRef} label={draft.fields.status === 'blocked' ? 'What is blocking this?' : draft.fields.completionKind === 'dropped' ? 'Why is this no longer needed?' : 'Reason'}
      hint={draft.original?.status === 'done' && draft.fields.status !== 'done' ? 'Explain why you are reopening this card.' : 'A reason is required for blocked, dropped, reopened or resolved work.'}
      value={draft.fields.reason ?? ''} maxLength={1000} disabled={disabled}
      error={problem?.field === 'reason' ? problem.message : undefined}
      onChange={(event) => change({ reason: event.currentTarget.value || null })} />
    <MemoryWorkPicker draft={draft} nodes={nodes} disabled={disabled} onChange={onChange} />
    {draft.sourcePostId && <p className="n-field-hint">This card will keep its source message link.</p>}
    <div className="n-actions">
      <Button type="submit" variant="primary" disabled={disabled} loading={pending} loadingLabel="Saving…">{draft.original ? 'Save changes' : 'Create card'}</Button>
      <Button onClick={onCancel} disabled={pending}>Back to Memory board</Button>
      {draft.dirty && <span>Not saved</span>}
    </div>
  </form>
}
