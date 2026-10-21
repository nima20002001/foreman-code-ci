import { InfoHint } from '../../shared/ui/InfoHint'
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { Button, Dialog, TextField } from '../../shared/ui/nocturne'

export interface WorkflowNameHandle { begin(): void }
/** Editing the name never applies it silently: leaving the field asks to rename or discard. */
export function WorkflowName({ name, disabled, onRename, ref }: { name: string; disabled: boolean; onRename(name: string): void;
  ref?: Ref<WorkflowNameHandle> }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(name)
  const [confirming, setConfirming] = useState<string>()
  const input = useRef<HTMLInputElement>(null)
  const title = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  const active = useRef(false)
  useEffect(() => {
    if (editing) { input.current?.focus(); input.current?.select() }
    else if (restoreFocus.current) { restoreFocus.current = false; title.current?.focus() }
  }, [editing])
  const finish = (save: boolean, keyboard = false) => {
    if (!active.current) return
    active.current = false
    restoreFocus.current = keyboard
    const next = value.trim()
    if (save && !disabled && next && next !== name) setConfirming(next)
    setEditing(false)
  }
  const decide = (rename: boolean) => {
    if (rename && confirming) onRename(confirming)
    setConfirming(undefined)
    restoreFocus.current = true
  }
  const begin = () => { if (!disabled) { setValue(name); active.current = true; setEditing(true) } }
  useImperativeHandle(ref, () => ({ begin }))
  return <><h2 className="board-name"><span className="board-name-sizing" aria-hidden="true">{name}</span>{editing ? <TextField ref={input} className="board-name-field" label="Workflow name" aria-label="Workflow name" value={value} disabled={disabled}
    onChange={(event) => setValue(event.target.value)} onBlur={() => finish(true)}
    onKeyDown={(event) => {
      if (!event.nativeEvent.isComposing && (event.key === 'Enter' || event.key === 'Escape')) {
        event.preventDefault(); event.stopPropagation(); finish(event.key === 'Enter', true)
      }
    }} /> : <button ref={title} className="board-name-button" title="Rename workflow" disabled={disabled}
      onClick={begin}>{name}</button>}</h2>
    {confirming !== undefined ? <Dialog open title="Rename workflow?" closeLabel="Discard new name" returnFocusRef={title}
      description={`Rename “${name}” to “${confirming}”?`}
      headerLeading={<InfoHint label="Rename">You can undo it with Ctrl+Z; Save keeps it.</InfoHint>}
      onOpenChange={(open) => { if (!open) decide(false) }}>
      <div className="n-actions">
        <Button onClick={() => decide(false)}>Discard</Button>
        <Button variant="primary" onClick={() => decide(true)}>Rename</Button>
      </div>
    </Dialog> : null}</>
}
