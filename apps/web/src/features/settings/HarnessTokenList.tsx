import { useState, type ReactNode } from 'react'
import { Button, TextField } from '../../shared/ui/nocturne'

/** Token entry keeps an unfinished token local; separators are not eaten on every keystroke. */
export function HarnessTokenList({ label, labelHint, values, onChange }: { label: string; labelHint?: ReactNode; values: string[]; onChange(values: string[]): void }) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const next = draft.split(',').map((token) => token.trim()).filter(Boolean)
    if (next.length) { onChange([...new Set([...values, ...next])]); setDraft('') }
  }
  return <div className="harness-form-stack"><div className="harness-token-list" aria-label={label}>
    {values.map((value) => <span key={value} className="harness-token">{value}<Button size="sm" variant="ghost" aria-label={`Remove ${value} from ${label}`}
      onClick={() => onChange(values.filter((item) => item !== value))}>×</Button></span>)}
  </div><div className="harness-token-entry"><TextField label={label} labelHint={labelHint} value={draft} onChange={(event) => setDraft(event.target.value)}
    onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); add() } }} />
    <Button size="sm" disabled={!draft.trim()} onClick={add}>Add</Button></div></div>
}
