import { Button } from '../../../shared/ui/nocturne'
import { useId, useState, type KeyboardEvent } from 'react'

export function useSlashCommandMenu(value: string, setValue: (value: string) => void,
  send: (value: string) => void, allowNew = false, enabled = true) {
  const id = useId()
  const [selected, setSelected] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const options = ['/compact', '/plan', ...(allowNew ? ['/new'] : [])].filter(command => command.startsWith(value.trim()))
  const open = enabled && !dismissed && /^\/\w*$/.test(value.trim()) && options.length > 0
  const active = Math.min(selected, Math.max(0, options.length - 1))
  const choose = (command: string) => { setValue(command); send(command) }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false
    if (event.key === 'Escape') { event.preventDefault(); setDismissed(true); return true }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); setSelected((active + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length); return true
    }
    if (event.key === 'Tab') { event.preventDefault(); setValue(options[active]!); return true }
    if (event.key === 'Enter') { event.preventDefault(); choose(options[active]!); return true }
    return false
  }
  return { onKeyDown, reset: () => { setDismissed(false); setSelected(0) },
    inputProps: { 'aria-controls': open ? id : undefined, 'aria-expanded': open,
      'aria-autocomplete': 'list' as const, 'aria-activedescendant': open ? `${id}-${active}` : undefined },
    menu: open ? <div id={id} role="listbox" aria-label="Chat commands" className="session-command-menu">
      {options.map((command, index) => <Button variant="secondary" size="sm" key={command} id={`${id}-${index}`} type="button" role="option"
        aria-selected={index === active} tabIndex={-1} onMouseDown={event => event.preventDefault()} onClick={() => choose(command)}>{command}</Button>)}
    </div> : null }
}
