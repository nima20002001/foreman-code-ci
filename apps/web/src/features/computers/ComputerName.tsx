import { useRef, useState } from 'react'
import { Pencil } from 'lucide-react'
import { COMPUTER_NAME_MAX_LENGTH } from '@foreman-code/contracts/computer-activity'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { useRenameComputer } from '../../shared/api/computerActivity'
import { TextField } from '../../shared/ui/nocturne'

/** A computer's name; click it to rename. Enter or leaving the field saves, Esc cancels. */
export function ComputerName({ name, target }: { name: string; target: DeviceProvisioningTarget }) {
  const [draft, setDraft] = useState<string | null>(null)
  const settled = useRef(false)
  const rename = useRenameComputer()
  const finish = (save: boolean) => {
    if (settled.current) return
    settled.current = true
    const next = draft?.trim() ?? ''
    setDraft(null)
    if (save && next && next !== name) rename.mutate({ target, name: next })
  }
  if (draft === null) {
    return <>
      <h3><button type="button" className="computer-name" title="Rename" onClick={() => { settled.current = false; setDraft(name) }}>
        <span>{rename.isPending ? rename.variables.name : name}</span><Pencil size={12} aria-hidden="true" />
      </button></h3>
      {rename.isError ? <small role="alert">{rename.error.message}</small> : null}
    </>
  }
  return <TextField className="computer-name-field" label="Computer name" autoFocus value={draft} maxLength={COMPUTER_NAME_MAX_LENGTH}
    onChange={event => setDraft(event.target.value)} onFocus={event => event.target.select()} onBlur={() => finish(true)}
    onKeyDown={event => {
      if (event.key === 'Enter') finish(true)
      else if (event.key === 'Escape') finish(false)
    }} />
}
