import { useEffect, useRef, useState, type ReactNode } from 'react'
import { IconButton, Icon } from '../../shared/ui/nocturne'
import { useFloatingSurface } from '../../shared/ui/nocturne/useFloatingSurface'
import { raiseFloating, useFloatingZ } from '../../shared/ui/floatingStack'
import './activitiesPopover.css'

const STACK_ID = 'board-activities'

/** A small non-modal popover anchored to the toolbar's Activities button. Outside click, Escape or a second press on the button close it. */
export function ActivitiesPopover({ open, onClose, findAnchor, children }: {
  open: boolean; onClose(): void; findAnchor(): HTMLElement | null; children: ReactNode
}) {
  return open ? <PopoverSurface onClose={onClose} findAnchor={findAnchor}>{children}</PopoverSurface> : null
}

function PopoverSurface({ onClose, findAnchor, children }: { onClose(): void; findAnchor(): HTMLElement | null; children: ReactNode }) {
  const surface = useRef<HTMLElement>(null)
  const anchor = useRef<HTMLElement | null>(null)
  const close = useRef(onClose)
  close.current = onClose
  // The toolbar button may mount after the popover (a deep link opens it), so it is looked up again on every event.
  const find = useRef(findAnchor)
  find.current = findAnchor
  // A deep link can open the popover before the toolbar button exists; show it as soon as the button appears.
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  anchor.current = anchorEl
  useEffect(() => {
    const found = find.current()
    if (found) { setAnchorEl(found); return }
    const watch = new MutationObserver(() => {
      const next = find.current()
      if (next) { setAnchorEl(next); watch.disconnect() }
    })
    watch.observe(document.body, { childList: true, subtree: true })
    return () => watch.disconnect()
  }, [])
  // Not a top-layer popover: Activities stacks with the other Board containers, newest or focused on top.
  const zIndex = useFloatingZ(STACK_ID)
  useFloatingSurface(anchorEl !== null, anchor, surface, 420, 'end', 'block', false)
  useEffect(() => {
    const onButton = (target: EventTarget | null) => target instanceof Node && !!find.current()?.contains(target)
    const outside = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && !surface.current?.contains(target) && !onButton(target)) close.current()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const target = event.target
      if (target instanceof Element && !surface.current?.contains(target) && target !== document.body && !onButton(target)) return
      event.preventDefault()
      close.current()
      find.current()?.focus()
    }
    // A second press on the button closes the popover instead of reopening it.
    const toggle = (event: MouseEvent) => {
      if (!onButton(event.target)) return
      event.stopPropagation()
      close.current()
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape)
    document.addEventListener('click', toggle, true)
    surface.current?.focus()
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape)
      document.removeEventListener('click', toggle, true)
    }
  }, [])
  return <section ref={surface} tabIndex={-1} aria-label="Activities popover" className="n-theme board-activities-popover" style={{ zIndex }}
    onPointerDownCapture={() => raiseFloating(STACK_ID)} onFocusCapture={() => raiseFloating(STACK_ID)}>
    <header className="board-activities-popover-header">
      <h2>Activities</h2>
      <IconButton label="Close Activities" onClick={() => { close.current(); find.current()?.focus() }}><Icon name="close" size={14} /></IconButton>
    </header>
    <div className="board-activities-popover-body">{children}</div>
  </section>
}
