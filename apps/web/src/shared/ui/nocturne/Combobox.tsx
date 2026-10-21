import { useId, useRef, useState, useEffect } from 'react'
import { nextEnabledIndex } from './utils'
import { Icon } from './Icon'
import type { SelectOption } from './Fields'
import { useFloatingSurface } from './useFloatingSurface'

export interface ComboboxProps {
  label: string
  value: string
  options: readonly (SelectOption & { description?: string })[]
  onValueChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  error?: string
  hint?: string
  name?: string
}
export function Combobox({ label, value, options, onValueChange, placeholder = 'Search options…', disabled, error, hint, name }: ComboboxProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeValue, setActiveValue] = useState<string>()
  const id = useId()
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const selected = options.find((option) => option.value === value)
  const filtered = options.filter((option) => `${option.label} ${option.description ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()))
  const explicit = filtered.findIndex((option) => option.value === activeValue && !option.disabled)
  const active = explicit >= 0 ? explicit : filtered.findIndex((option) => !option.disabled)
  const expanded = open && !disabled
  useFloatingSurface(expanded, input, surface, 'anchor')
  useEffect(() => {
    if (expanded && active >= 0) list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [expanded, active, query])
  function choose(index: number) {
    const option = filtered[index]
    if (!option || option.disabled || disabled) return
    onValueChange(option.value)
    setOpen(false)
    setQuery('')
  }
  return <div className="n-field n-combobox" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) { setOpen(false); setQuery('') } }}>
    <label htmlFor={id} onClick={(event) => event.preventDefault()}>{label}</label>
    {name && <input type="hidden" name={name} value={value} disabled={disabled} />}
    <div className="n-input-wrap" data-invalid={Boolean(error)}><span className="n-input-leading"><Icon name="search" size={16} /></span>
      <input ref={input} id={id} className="n-input" role="combobox" autoComplete="off" aria-autocomplete="list" aria-expanded={expanded} aria-controls={expanded ? `${id}-list` : undefined}
        aria-activedescendant={expanded && active >= 0 ? `${id}-option-${active}` : undefined} aria-invalid={Boolean(error) || undefined}
        aria-describedby={[hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined}
        value={expanded ? query : selected?.label ?? ''} placeholder={placeholder} disabled={disabled}
        onFocus={() => { setQuery(''); setActiveValue(value); setOpen(true) }}
        onClick={() => { if (!expanded) { setQuery(''); setOpen(true) } }}
        onChange={(event) => { setQuery(event.currentTarget.value); setActiveValue(undefined); setOpen(true) }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); setOpen(false); setQuery(''); return }
          if (event.key === 'Tab') { setOpen(false); setQuery(''); return }
          if (event.key === 'Enter' && expanded) { event.preventDefault(); choose(active); return }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (!expanded) { setQuery(''); setActiveValue(value); setOpen(true); return }
            const next = nextEnabledIndex(active, event.key === 'ArrowDown' ? 1 : -1, filtered.map((option) => Boolean(option.disabled)))
            if (next >= 0) setActiveValue(filtered[next].value)
          }
        }} /><span className="n-input-trailing"><Icon name="down" size={14} /></span>
    </div>
    {hint && <span className="n-field-hint" id={`${id}-hint`}>{hint}</span>}{error && <span className="n-field-error" id={`${id}-error`}>{error}</span>}
    {expanded && <div ref={surface} popover="manual" className="n-combobox-popup">
      <div id={`${id}-list`} role="listbox" aria-label={label} ref={list}>
        {filtered.map((option, index) => <div key={option.value} id={`${id}-option-${index}`} role="option" aria-selected={option.value === value} aria-disabled={option.disabled || undefined}
          data-index={index} data-active={index === active} className="n-combobox-option" onMouseDown={(event) => event.preventDefault()} onClick={() => choose(index)}>
          <span>{option.label}{option.description && <small>{option.description}</small>}</span>{option.value === value && <Icon name="check" size={16} />}
        </div>)}
      </div>
      {filtered.length === 0 && <p className="n-combobox-empty" role="status">No matching options. Try a different search.</p>}
    </div>}
  </div>
}
