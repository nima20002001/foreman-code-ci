import { useId, useRef, useState, useEffect, type ReactNode } from 'react'
import { cx, nextEnabledIndex } from './utils'
import { Icon, type IconName } from './Icon'
import { Button } from './Button'
import { useFloatingSurface } from './useFloatingSurface'

export interface TabItem { value: string; label: string; content: ReactNode; disabled?: boolean; badge?: string | number }
export function Tabs({ label, value, onValueChange, items, className, keepMounted = true }:
  { label: string; value: string; onValueChange: (value: string) => void; items: readonly TabItem[]; className?: string; keepMounted?: boolean }) {
  const id = useId()
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const selectedIndex = items.findIndex((item) => item.value === value && !item.disabled)
  const active = selectedIndex < 0 ? items.findIndex((item) => !item.disabled) : selectedIndex
  return <div className={cx('n-tabs', className)}>
    <div role="tablist" aria-label={label} className="n-tab-list" onKeyDown={(event) => {
      const index = refs.current.indexOf(document.activeElement as HTMLButtonElement)
      if (index < 0) return
      const rtl = getComputedStyle(event.currentTarget).direction === 'rtl'
      let next = -1
      if (event.key === 'ArrowRight') next = nextEnabledIndex(index, rtl ? -1 : 1, items.map((item) => Boolean(item.disabled)))
      if (event.key === 'ArrowLeft') next = nextEnabledIndex(index, rtl ? 1 : -1, items.map((item) => Boolean(item.disabled)))
      if (event.key === 'Home') next = items.findIndex((item) => !item.disabled)
      if (event.key === 'End') next = nextEnabledIndex(0, -1, items.map((item) => Boolean(item.disabled)))
      if (next < 0) return
      event.preventDefault()
      refs.current[next]?.focus()
      onValueChange(items[next].value)
    }}>
      {items.map((item, index) => <button key={item.value} type="button" role="tab" id={`${id}-tab-${index}`} aria-controls={`${id}-panel-${index}`}
        aria-selected={active === index} tabIndex={active === index ? 0 : -1} disabled={item.disabled}
        ref={(element) => { refs.current[index] = element }} onClick={() => onValueChange(item.value)}>
        {item.label}{item.badge !== undefined && <span className="n-count">{item.badge}</span>}
      </button>)}
    </div>
    {items.map((item, index) => (keepMounted || active === index) && <div key={item.value} role="tabpanel" className="n-tab-panel" id={`${id}-panel-${index}`}
      aria-labelledby={`${id}-tab-${index}`} hidden={active !== index} tabIndex={0}>{item.content}</div>)}
  </div>
}

export function SegmentedControl({ label, value, options, onValueChange }:
  { label: string; value: string; options: readonly { value: string; label: string; icon?: IconName; disabled?: boolean }[]; onValueChange: (value: string) => void }) {
  const id = useId()
  return <fieldset className="n-segmented"><legend className="n-sr-only">{label}</legend>{options.map((option) =>
    <label key={option.value} data-selected={option.value === value} data-disabled={option.disabled || undefined}>
      <input type="radio" name={id} checked={option.value === value} value={option.value} disabled={option.disabled} onChange={() => onValueChange(option.value)} />
      {option.icon && <Icon name={option.icon} size={15} />}<span>{option.label}</span></label>)}</fieldset>
}

export function Breadcrumbs({ items, label = 'Breadcrumb' }: { items: readonly { label: string; href?: string }[]; label?: string }) {
  return <nav aria-label={label} className="n-breadcrumbs"><ol>{items.map((item, index) => <li key={`${item.label}-${index}`}>
    {index > 0 && <Icon name="chevron" size={13} />}{index === items.length - 1 ? <span aria-current="page">{item.label}</span> : item.href ? <a href={item.href}>{item.label}</a> : <span>{item.label}</span>}
  </li>)}</ol></nav>
}

export function NavItem({ href, active, icon, children, count }: { href: string; active?: boolean; icon: IconName; children: ReactNode; count?: number }) {
  return <a href={href} className="n-nav-item" aria-current={active ? 'page' : undefined}><Icon name={icon} /><span>{children}</span>{count !== undefined && <span className="n-count">{count}</span>}</a>
}

export function Accordion({ items }: { items: readonly { id: string; title: string; content: ReactNode; defaultOpen?: boolean }[] }) {
  return <div className="n-accordion">{items.map((item) => <AccordionItem key={item.id} title={item.title} defaultOpen={item.defaultOpen}>{item.content}</AccordionItem>)}</div>
}
function AccordionItem({ title, defaultOpen, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  // `open` is initialized once; subsequent native toggles belong to the element.
  const [initial] = useState(defaultOpen)
  return <details open={initial}><summary>{title}<Icon name="down" size={16} /></summary><div>{children}</div></details>
}

export interface MenuItem { id: string; label: string; icon?: IconName; shortcut?: string; disabled?: boolean; danger?: boolean; onSelect: () => void }
export function DropdownMenu({ label, items, icon = 'more' }: { label: string; items: readonly MenuItem[]; icon?: IconName }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  useFloatingSurface(open, trigger, surface, 260, 'end')
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const initialIndex = useRef(0)
  const typeahead = useRef({ value: '', time: 0 })
  const id = useId()
  useEffect(() => {
    if (!open) return
    refs.current[initialIndex.current]?.focus()
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open])
  function show(last = false) {
    const index = last ? nextEnabledIndex(0, -1, items.map((item) => Boolean(item.disabled))) : items.findIndex((item) => !item.disabled)
    if (index < 0) return
    initialIndex.current = index
    setOpen(true)
  }
  function close(restore = false) { setOpen(false); if (restore) trigger.current?.focus() }
  return <div ref={root} className="n-menu" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) close() }}>
    <button type="button" ref={trigger} className="n-button n-button--ghost n-icon-button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? id : undefined} onClick={() => open ? close() : show()} onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(event.key === 'ArrowUp') }
      }}><Icon name={icon} /></button>
    {open && <div ref={surface} popover="manual" id={id} role="menu" aria-label={label} className="n-menu-list" onKeyDown={(event) => {
      const index = refs.current.indexOf(document.activeElement as HTMLButtonElement)
      const disabled = items.map((item) => Boolean(item.disabled))
      let next = -1
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
      if (event.key === 'ArrowDown') next = nextEnabledIndex(index, 1, disabled)
      if (event.key === 'ArrowUp') next = nextEnabledIndex(index, -1, disabled)
      if (event.key === 'Home') next = nextEnabledIndex(-1, 1, disabled)
      if (event.key === 'End') next = nextEnabledIndex(0, -1, disabled)
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== ' ') {
        const now = Date.now()
        const previous = now - typeahead.current.time < 600 ? typeahead.current.value : ''
        const search = previous === event.key.toLowerCase() ? previous : previous + event.key.toLowerCase()
        typeahead.current = { value: search, time: now }
        for (let offset = 1; offset <= items.length; offset += 1) {
          const candidate = (index + offset) % items.length
          if (!items[candidate].disabled && items[candidate].label.toLowerCase().startsWith(search)) { next = candidate; break }
        }
      }
      if (next >= 0) { event.preventDefault(); refs.current[next]?.focus() }
    }}>
      {items.map((item, index) => <button key={item.id} type="button" role="menuitem" tabIndex={-1} disabled={item.disabled} data-danger={item.danger || undefined}
        ref={(element) => { refs.current[index] = element }} onClick={() => { close(true); item.onSelect() }}>
        {item.icon && <Icon name={item.icon} size={16} />}<span>{item.label}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}</button>)}
    </div>}
  </div>
}

export function Pagination({ page, totalPages, onPageChange }: { page: number; totalPages: number; onPageChange: (page: number) => void }) {
  const total = Number.isFinite(totalPages) ? Math.max(1, Math.floor(totalPages)) : 1
  const current = Math.min(total, Math.max(1, Math.floor(page) || 1))
  return <nav aria-label="Pagination" className="n-pagination"><Button size="sm" disabled={current === 1} onClick={() => onPageChange(current - 1)}>Previous</Button>
    <span>Page <strong>{current}</strong> of {total}</span><Button size="sm" disabled={current === total} onClick={() => onPageChange(current + 1)}>Next</Button></nav>
}
