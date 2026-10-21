import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Icon, type IconName } from './Icon'
import { useFloatingSurface } from './useFloatingSurface'
import { cx } from './utils'

interface BaseItem { id: string; label: string; description?: string; icon?: IconName; disabled?: boolean; shortcut?: string }
export type ActionMenuItem =
  | (BaseItem & { kind?: 'action'; danger?: boolean; onSelect: () => void })
  | (BaseItem & { kind: 'checkbox'; checked: boolean; onCheckedChange: (checked: boolean) => void })
  | (BaseItem & { kind: 'radio'; checked: boolean; onSelect: () => void })
  | (BaseItem & { kind: 'submenu'; items: readonly ActionMenuItem[] })
  | { id: string; kind: 'separator'; label?: string }
export interface ActionMenuProps { label: string; items: readonly ActionMenuItem[]; triggerLabel?: string; icon?: IconName; disabled?: boolean; children?: ReactNode; className?: string; width?: number }

/** Nested actions/check/radio groups. Disabled items stay discoverable but never activate. */
export function ActionMenu({ label, items, triggerLabel, icon = 'more', disabled, children, className, width }: ActionMenuProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const first = useRef<'first' | 'last'>('first')
  const id = useId()
  function close(restore = true) { setOpen(false); if (restore) trigger.current?.focus() }
  useEffect(() => {
    if (!open) return
    function outside(event: PointerEvent) { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false) }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open])
  function show(last = false) { if (disabled) return; first.current = last ? 'last' : 'first'; setOpen(true) }
  return <div ref={root} className={cx('n-action-menu', className)} onBlur={event => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) close(false)
  }} onContextMenu={children ? event => { event.preventDefault(); show() } : undefined}
    onKeyDown={children ? event => { if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') { event.preventDefault(); show() } } : undefined}>
    {children}
    <button ref={trigger} type="button" className={cx('n-button n-button--secondary', !triggerLabel && 'n-icon-button')} aria-label={label} disabled={disabled}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => open ? close(false) : show()} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(event.key === 'ArrowUp') }
      }}><Icon name={icon} size={16} />{triggerLabel && <><span>{triggerLabel}</span><Icon name="down" size={13} /></>}</button>
    {open && <MenuLevel width={width} id={id} label={label} items={items} anchor={trigger} initial={first.current} onClose={close} onBack={() => close()} />}
  </div>
}
export function ContextMenu(props: Omit<ActionMenuProps, 'triggerLabel'> & { children: ReactNode }) {
  return <ActionMenu {...props} />
}
function MenuLevel({ id, label, items, anchor, initial = 'first', onClose, onBack, nested = false, width = 286 }:
  { id: string; label: string; items: readonly ActionMenuItem[]; anchor: RefObject<HTMLElement | null>; initial?: 'first' | 'last'; onClose: (restore?: boolean) => void; onBack: () => void; nested?: boolean; width?: number }) {
  const surface = useRef<HTMLDivElement>(null)
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const [submenu, setSubmenu] = useState<string | null>(null)
  const submenuAnchor = useRef<HTMLButtonElement | null>(null)
  const typeahead = useRef({ text: '', at: 0 })
  useFloatingSurface(true, anchor, surface, width, nested ? 'start' : 'end', nested ? 'inline' : 'block')
  useEffect(() => {
    const buttons = refs.current.filter((node): node is HTMLButtonElement => Boolean(node))
    ;(initial === 'last' ? buttons.at(-1) : buttons[0])?.focus()
    if (!buttons.length) surface.current?.focus()
  }, [initial])
  function choose(item: ActionMenuItem, index: number) {
    if (item.kind === 'separator' || item.disabled) return
    if (item.kind === 'submenu') { submenuAnchor.current = refs.current[index]; setSubmenu(item.id); return }
    if (item.kind === 'checkbox') { item.onCheckedChange(!item.checked); return }
    onClose(); item.onSelect()
  }
  return <div ref={surface} id={id} role="menu" tabIndex={-1} aria-label={label} popover="manual" className="n-theme n-rich-menu" onKeyDown={event => {
    // A child menu owns its own key events.
    if ((event.target as HTMLElement).closest('[role="menu"]') !== event.currentTarget) return
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl'
    const index = refs.current.indexOf(document.activeElement as HTMLButtonElement)
    const order = items.map((item, i) => item.kind === 'separator' ? -1 : i).filter(i => i >= 0)
    const offset = order.indexOf(index)
    let next = -1
    if (event.key === 'Escape' || (nested && event.key === (rtl ? 'ArrowRight' : 'ArrowLeft'))) {
      event.preventDefault(); event.stopPropagation(); onBack(); return
    }
    if (event.key === 'Tab') {
      // Resolve a real adjacent focus target before removing the focused menu item.
      event.preventDefault(); event.stopPropagation()
      const root = anchor.current?.closest('.n-action-menu')
      const scope = root?.closest('dialog') ?? document.body
      const candidates = Array.from(scope.querySelectorAll<HTMLElement>('button,a[href],input,select,textarea,[tabindex="0"]'))
        .filter(el => !el.closest('[role="menu"],[hidden],[inert]') && !el.matches(':disabled') && el.getClientRects().length > 0)
      const button = root?.querySelector<HTMLElement>(':scope > button')
      const current = button ? candidates.indexOf(button) : -1
      onClose(false)
      ;(candidates[current + (event.shiftKey ? -1 : 1)] ?? button)?.focus()
      return
    }
    if (event.key === (rtl ? 'ArrowLeft' : 'ArrowRight') && index >= 0 && items[index].kind === 'submenu') {
      event.preventDefault(); event.stopPropagation(); choose(items[index], index); return
    }
    if (event.key === 'ArrowDown') next = order[(offset + 1) % order.length] ?? -1
    if (event.key === 'ArrowUp') next = order[(offset - 1 + order.length) % order.length] ?? -1
    if (event.key === 'Home') next = order[0] ?? -1
    if (event.key === 'End') next = order.at(-1) ?? -1
    if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.nativeEvent.isComposing) {
      const now = Date.now(); const char = event.key.toLocaleLowerCase()
      const previous = now - typeahead.current.at < 650 ? typeahead.current.text : ''
      const text = previous === char ? char : previous + char
      typeahead.current = { text, at: now }
      next = [...order.slice(offset + 1), ...order.slice(0, offset + 1)].find(i => items[i].label?.toLocaleLowerCase().startsWith(text)) ?? -1
    }
    if (next >= 0) { event.preventDefault(); setSubmenu(null); refs.current[next]?.focus() }
  }}>
    {items.length === 0 && <p className="n-menu-empty">No actions available.</p>}
    {items.map((item, index) => item.kind === 'separator' ? <div key={item.id} className="n-menu-section"><div role="separator" />{item.label && <span>{item.label}</span>}</div> :
      <div key={item.id} role="none"><button ref={element => { refs.current[index] = element }} type="button" tabIndex={-1}
        role={item.kind === 'checkbox' ? 'menuitemcheckbox' : item.kind === 'radio' ? 'menuitemradio' : 'menuitem'}
        aria-checked={item.kind === 'checkbox' || item.kind === 'radio' ? item.checked : undefined}
        aria-label={item.label} aria-describedby={item.description ? `${id}-description-${index}` : undefined}
        aria-disabled={item.disabled || undefined} aria-haspopup={item.kind === 'submenu' ? 'menu' : undefined}
        aria-expanded={item.kind === 'submenu' ? submenu === item.id : undefined} aria-controls={item.kind === 'submenu' && submenu === item.id ? `${id}-${index}` : undefined}
        data-danger={(!item.kind || item.kind === 'action') && item.danger || undefined}
        onClick={() => choose(item, index)}>
        <span className="n-menu-icon"><Icon name={item.kind === 'checkbox' || item.kind === 'radio' ? item.checked ? 'check' : 'minus' : item.icon ?? 'chevron'} size={15} /></span>
        <span className="n-menu-text">{item.label}{item.description && <small id={`${id}-description-${index}`}>{item.description}</small>}</span>
        {item.shortcut && <kbd>{item.shortcut}</kbd>}{item.kind === 'submenu' && <Icon className="n-inline-arrow" name="chevron" size={14} />}
      </button>{item.kind === 'submenu' && submenu === item.id && <MenuLevel key={item.id} id={`${id}-${index}`} nested label={item.label} items={item.items} anchor={submenuAnchor} onClose={onClose} onBack={() => { setSubmenu(null); refs.current[index]?.focus() }} />}</div>)}
  </div>
}
