import { useEffect, useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Icon, IconButton } from '../../shared/ui/nocturne'

export function SubagentPopover({ anchor, title, description, busy, onClose, children, footer }: {
  anchor: RefObject<HTMLElement | null>
  title: string
  description: string | undefined
  busy: boolean
  onClose: () => void
  children: ReactNode
  footer: ReactNode
}) {
  const surface = useRef<HTMLElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const id = useId()
  useLayoutEffect(() => {
    let frame = 0
    const place = () => {
      const element = surface.current
      if (!element) return
      const viewport = window.visualViewport
      const leftEdge = viewport?.offsetLeft ?? 0
      const topEdge = viewport?.offsetTop ?? 0
      const width = viewport?.width ?? window.innerWidth
      const height = viewport?.height ?? window.innerHeight
      element.style.maxHeight = `${Math.min(560, Math.max(0, height - 24))}px`
      element.style.width = `${Math.min(392, Math.max(0, width - 24))}px`
      const rect = anchor.current?.getBoundingClientRect()
      const preferredLeft = rect && rect.right + 12 + element.offsetWidth <= leftEdge + width - 12
        ? rect.right + 12 : (rect?.left ?? leftEdge + width / 2) - element.offsetWidth - 12
      const left = Math.max(leftEdge + 12, Math.min(preferredLeft, leftEdge + width - element.offsetWidth - 12))
      const top = Math.max(topEdge + 12, Math.min(rect?.top ?? topEdge + 12, topEdge + height - element.offsetHeight - 12))
      element.style.left = `${left}px`
      element.style.top = `${top}px`
      frame = requestAnimationFrame(place)
    }
    place()
    return () => cancelAnimationFrame(frame)
  }, [anchor])
  useEffect(() => { heading.current?.focus({ preventScroll: true }) }, [])
  useEffect(() => {
    let outsidePress = false
    const isOutside = (target: EventTarget | null) => target instanceof Node
      && !surface.current?.contains(target)
      && !(target instanceof Element && target.closest('.run-subagent-orb, dialog[open], .n-menu, [role=listbox]'))
    const onPointerDown = (event: PointerEvent) => { outsidePress = isOutside(event.target) }
    const onClick = (event: MouseEvent) => {
      if (!busy && outsidePress && isOutside(event.target)) onClose()
      outsidePress = false
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return
      event.preventDefault()
      if (!busy) onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('click', onClick, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('click', onClick, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [busy, onClose])
  return createPortal(<section ref={surface} className="n-agent-popover run-subagent-panel nodrag nopan nowheel"
    role="dialog" aria-modal="false" aria-busy={busy || undefined} aria-labelledby={`${id}-title`}
    aria-describedby={description ? `${id}-description` : undefined}
    onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
      event.stopPropagation()
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') event.preventDefault()
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return
      event.preventDefault()
      if (!busy) onClose()
    }}>
    <header className="n-agent-popover-header">
      <span className="n-agent-popover-glyph" aria-hidden="true"><Icon name="bot" size={18} /></span>
      <div><h2 ref={heading} id={`${id}-title`} tabIndex={-1}>{title}</h2>
        {description && <p id={`${id}-description`}>{description}</p>}</div>
      <IconButton label="Close subagent" variant="ghost" disabled={busy} onClick={onClose}>
        <Icon name="close" size={16} />
      </IconButton>
    </header>
    <div className="n-agent-popover-body">{children}</div>
    {footer && <footer className="run-subagent-footer">{footer}</footer>}
  </section>, document.body)
}
