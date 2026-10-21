import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import { Dialog } from './Overlays'
import { Icon, type IconName } from './Icon'
import { nextEnabledIndex } from './utils'

export interface Command { id: string; label: string; description?: string; group?: string; keywords?: string; icon?: IconName; disabled?: boolean; onSelect: () => void }
export interface CommandPaletteProps { open: boolean; onOpenChange: (open: boolean) => void; commands: readonly Command[]; enableShortcut?: boolean }
export function CommandPalette({ open, onOpenChange, commands, enableShortcut = true }: CommandPaletteProps) {
  const input = useRef<HTMLInputElement>(null)
  const queued = useRef<(() => void) | undefined>(undefined)
  useEffect(() => {
    if (!enableShortcut) return
    function shortcut(event: KeyboardEvent) {
      const target = event.target instanceof HTMLElement ? event.target : null
      if (event.defaultPrevented || event.repeat || event.isComposing || target?.closest('input,textarea,select,[contenteditable="true"]')) return
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        if (document.querySelector('dialog[open]') && !open) return
        event.preventDefault()
        onOpenChange(!open)
      }
    }
    document.addEventListener('keydown', shortcut)
    return () => document.removeEventListener('keydown', shortcut)
  }, [enableShortcut, open, onOpenChange])
  return <Dialog open={open} onOpenChange={onOpenChange} title="Command center" description="Find a destination or an action." initialFocusRef={input} className="n-command-dialog" size="md"
    onAfterClose={() => { const action = queued.current; queued.current = undefined; action?.() }}>
    {open && <CommandContents commands={commands} inputRef={input} onChoose={(command) => { queued.current = command.onSelect; onOpenChange(false) }} />}
  </Dialog>
}
function CommandContents({ commands, inputRef, onChoose }: { commands: readonly Command[]; inputRef: RefObject<HTMLInputElement | null>; onChoose: (command: Command) => void }) {
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string>()
  const id = useId()
  const list = useRef<HTMLDivElement>(null)
  const filtered = commands.filter((command) => `${command.label} ${command.description ?? ''} ${command.keywords ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()))
  const explicit = filtered.findIndex((command) => command.id === activeId && !command.disabled)
  const active = explicit >= 0 ? explicit : filtered.findIndex((command) => !command.disabled)
  useEffect(() => { if (active >= 0) list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }) }, [active, query])
  function choose(index: number) { const command = filtered[index]; if (command && !command.disabled) onChoose(command) }
  return <><label className="n-sr-only" htmlFor={id}>Search commands</label><div className="n-command-search"><Icon name="search" size={21} />
    <input id={id} ref={inputRef} value={query} autoComplete="off" placeholder="Search workflows, agents, settings…" role="combobox" aria-autocomplete="list" aria-expanded="true"
      aria-controls={`${id}-list`} aria-activedescendant={active >= 0 ? `${id}-option-${active}` : undefined}
      onChange={(event) => { setQuery(event.currentTarget.value); setActiveId(undefined) }} onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Enter') { event.preventDefault(); choose(active) }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const next = nextEnabledIndex(active, event.key === 'ArrowDown' ? 1 : -1, filtered.map((command) => Boolean(command.disabled)))
          if (next >= 0) setActiveId(filtered[next].id)
        }
      }} /></div>
    <div ref={list} id={`${id}-list`} className="n-command-list" role="listbox" aria-label="Commands">
      {filtered.map((command, index) => <div key={command.id} role="option" id={`${id}-option-${index}`} aria-selected={index === active} aria-disabled={command.disabled || undefined}
        data-index={index} data-active={index === active} className="n-command-option" onMouseDown={(event) => event.preventDefault()} onClick={() => choose(index)}>
        <span className="n-command-icon"><Icon name={command.icon ?? 'arrow'} /></span><span><strong>{command.label}</strong>{command.description && <small>{command.description}</small>}</span>
        {command.group && <span className="n-command-group">{command.group}</span>}<Icon name="arrow" size={14} />
      </div>)}
    </div>{filtered.length === 0 && <p className="n-command-empty" role="status">No matching commands. Try a shorter search.</p>}
    <footer className="n-command-footer"><span><kbd>↑</kbd><kbd>↓</kbd> to navigate</span><span><kbd>Enter</kbd> to select</span><span><kbd>Esc</kbd> to close</span></footer>
  </>
}
