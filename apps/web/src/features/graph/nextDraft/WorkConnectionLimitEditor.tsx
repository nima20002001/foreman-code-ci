import { InfoHint } from '../../../shared/ui/InfoHint'
import { useEffect, useState } from 'react'
import { Button, TextField } from '../../../shared/ui/nocturne'

const MAX_HANDOFFS = 2_147_483_647

/** Edits only the local Board draft. The existing Save/Discard and protected
 * Stop-and-save flow remains the sole durable publication path. */
export function WorkConnectionLimitEditor({ value, onApply, onCancel, disabled = false, compact = false }: {
  value?: number; onApply(value?: number): void; onCancel?(): void; disabled?: boolean; compact?: boolean
}) {
  const [raw, setRaw] = useState(value === undefined ? '' : String(value))
  const [error, setError] = useState<string>()
  useEffect(() => { setRaw(value === undefined ? '' : String(value)); setError(undefined) }, [value])
  const reset = () => {
    setRaw(value === undefined ? '' : String(value)); setError(undefined)
    onCancel?.()
  }
  const apply = () => {
    const text = raw.trim()
    if (text === '') { setError(undefined); onApply(undefined); return }
    if (!/^[1-9][0-9]*$/.test(text) || Number(text) > MAX_HANDOFFS) {
      setError('Enter a whole number from 1 to 2,147,483,647, or leave blank for no cap.')
      return
    }
    setError(undefined)
    onApply(Number(text))
  }
  return <form className={`work-connection-limit-editor${compact ? ' is-compact' : ''}`}
    onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); apply() }}
    onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
      event.stopPropagation()
      if (event.key === 'Escape') { event.preventDefault(); reset() }
    }}>
    <TextField label="Maximum work handoffs per Run" type="text" inputMode="numeric" autoComplete="off"
      value={raw} disabled={disabled} placeholder="Unlimited" error={error}
      labelHint={<InfoHint label="Maximum work handoffs per Run">Includes the first work submission. Its return and permission questions use no extra slot. Leave blank for no connection cap.</InfoHint>}
      onChange={(event) => { setRaw(event.currentTarget.value); setError(undefined) }} />
    <div className="work-connection-limit-actions">
      <Button size="sm" type="submit" disabled={disabled}>Apply to draft</Button>
      <Button size="sm" type="button" variant="ghost" disabled={disabled} onClick={reset}>{onCancel ? 'Cancel' : 'Reset'}</Button>
    </div>
  </form>
}
