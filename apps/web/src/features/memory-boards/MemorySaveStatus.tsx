import { MemoryCardSchema, MemoryNoteSchema, MemoryCardWorkBindingSchema, type MemoryCardWorkBinding } from '@foreman-code/contracts'
import { Button } from '../../shared/ui/nocturne/Button'
import { Textarea } from '../../shared/ui/nocturne/Fields'
import { ApiError } from '../../shared/api/client'
import type { useMemorySave } from './commandRecovery'
import { editCardDraft, editNoteDraft, type MemoryDraft } from './drafts'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { bindingLabel, errorMessage } from './presentation'

interface Props {
  save: ReturnType<typeof useMemorySave>
  draft?: MemoryDraft
  online: boolean
  onChangeDraft(draft: MemoryDraft): void
  onOpenCard(cardId: string): void
  onOpenWork(binding: MemoryCardWorkBinding): void
}
export function MemorySaveStatus({ save, draft, online, onChangeDraft, onOpenCard, onOpenWork }: Props) {
  const error = ApiError.is(save.error) ? save.error : undefined
  return <div className="n-stack memory-recovery">
    {save.retained.error && <p role="alert">{save.retained.error}</p>}
    {save.retained.command && !save.isPending && <section aria-label="Save recovery" className="n-stack">
      <h3>One save needs confirmation</h3><p>Could not confirm delivery. Check status before sending another change.</p>
      <div className="n-actions"><Button disabled={!online} onClick={save.check}>Check status</Button>
        <Button disabled={!online} onClick={save.retryOriginal}>Retry original save</Button></div>
      <details><summary>Copy retained save</summary><Textarea label="Original save" readOnly value={JSON.stringify(save.retained.command, null, 2)} rows={6} /></details>
    </section>}
    {save.isPending && <p role="status">{save.variables?.kind === 'check' ? 'Checking save status…' : 'Saving…'}</p>}
    {save.error && <p role="alert">{error?.code === 'ACTIVE_WORK_UNRESOLVED' ? 'This card still has unfinished work.'
      : error?.code.includes('CAPACITY') ? 'Memory board is full. Finish or drop open work, or archive notes, then try again.'
        : 'Couldn’t save. Your changes are still here.'} {errorMessage(save.error)}</p>}
    {error?.code === 'ACTIVE_WORK_UNRESOLVED' && Array.isArray(error.details?.bindings) && <ul>{error.details.bindings.map((value) => {
      const parsed = MemoryCardWorkBindingSchema.safeParse(value)
      return parsed.success ? <li key={parsed.data.id}>{bindingLabel(parsed.data)} · Run {parsed.data.work.runId.slice(0, 8)}
        <Button size="sm" onClick={() => onOpenWork(parsed.data)}>Open work</Button></li> : null
    })}</ul>}
    {error?.code === 'DUPLICATE_CARD_TITLE' && typeof error.details?.cardId === 'string' && <Button onClick={() => onOpenCard(error.details!.cardId as string)}>Open existing card</Button>}
    {error?.code === 'REVISION_CONFLICT' && draft && <Conflict error={error} draft={draft} onChange={(next) => { onChangeDraft(next); save.reset() }} />}
    {save.data && <p role="status">{save.data.outcome === 'unchanged' ? 'No changes' : save.data.outcome === 'existing' ? 'A card with this title already exists. Your draft is kept below.'
      : save.data.outcome === 'created' ? save.data.card ? 'Card created' : 'Note saved' : 'Changes saved'}</p>}
    {save.data?.outcome === 'existing' && save.data.card && <Button onClick={() => onOpenCard(save.data!.card!.id)}>Open existing card</Button>}
  </div>
}
function Conflict({ error, draft, onChange }: { error: ApiError; draft: MemoryDraft; onChange(draft: MemoryDraft): void }) {
  const parsed = draft.kind === 'card' ? MemoryCardSchema.safeParse(error.details?.current) : MemoryNoteSchema.safeParse(error.details?.current)
  if (!parsed.success) return <p>Read the latest saved item before revising this draft.</p>
  const useLatest = () => {
    if ('title' in parsed.data) onChange(editCardDraft(parsed.data))
    else onChange(editNoteDraft(parsed.data))
  }
  const keepDraft = () => {
    if (draft.kind === 'card' && 'title' in parsed.data) {
      const latest = editCardDraft(parsed.data), fields = { ...latest.fields }
      for (const key of Object.keys(draft.fields) as Array<keyof typeof fields>) {
        if (!draft.original || !sameWorkflowValue(draft.fields[key], draft.original[key])) Object.assign(fields, { [key]: draft.fields[key] })
      }
      onChange({ ...draft, original: parsed.data, fields, dirty: true })
    } else if (draft.kind === 'note' && 'text' in parsed.data) {
      onChange({ ...draft, original: parsed.data, dirty: true,
        text: draft.original?.text === draft.text ? parsed.data.text : draft.text,
        rank: String(draft.original?.rank) === draft.rank ? String(parsed.data.rank) : draft.rank })
    }
  }
  return <section className="n-stack memory-conflict" aria-label="Edit conflict">
    <h3>This {draft.kind} changed while you were editing.</h3>
    <Textarea label="Your draft" readOnly value={draft.kind === 'card' ? `${draft.fields.title}\n${draft.fields.body}\n${draft.fields.reason ?? ''}` : draft.text} />
    <Textarea label="Latest saved" readOnly value={'title' in parsed.data ? `${parsed.data.title}\n${parsed.data.body}\n${parsed.data.reason ?? ''}` : parsed.data.text} />
    <div className="n-actions"><Button onClick={useLatest}>Use latest</Button><Button onClick={keepDraft}>Keep editing my draft</Button></div>
  </section>
}
