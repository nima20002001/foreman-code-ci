import { useEffect, useId, useRef, useState, cloneElement, type KeyboardEventHandler, type ReactElement, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Button, IconButton } from './Button'
import { Icon } from './Icon'
import { TextField } from './Fields'
import { cx } from './utils'
import { useFloatingSurface } from './useFloatingSurface'

let scrollLocks = 0
let previousOverflow = ''
function lockBody() {
  if (scrollLocks++ === 0) { previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden' }
  return () => { if (--scrollLocks === 0 && document.body.style.overflow === 'hidden') document.body.style.overflow = previousOverflow }
}

export interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  headerLeading?: ReactNode
  onKeyDownCapture?: KeyboardEventHandler<HTMLDialogElement>
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full'
  variant?: 'dialog' | 'drawer' | 'sheet'
  side?: 'start' | 'end'
  role?: 'dialog' | 'alertdialog'
  busy?: boolean
  closeLabel?: string
  dismissible?: boolean
  closeOnOutsideClick?: boolean
  /** Focus target when the element that opened the dialog is gone on close. */
  returnFocusRef?: RefObject<HTMLElement | null>
  /** Keep a compact dialog beside the control that opened it. */
  anchorRef?: RefObject<HTMLElement | null>
  anchorAlign?: 'start' | 'end'
  initialFocusRef?: RefObject<HTMLElement | null>
  className?: string
  onAfterClose?: () => void
}
export function Dialog({ open, onOpenChange, title, description, children, footer, headerLeading, onKeyDownCapture, size = 'md', variant = 'dialog', dismissible = true,
  closeOnOutsideClick = true, initialFocusRef, className, onAfterClose, side = 'end', role = 'dialog', busy = false, closeLabel = 'Close dialog', returnFocusRef, anchorRef, anchorAlign = 'end' }: DialogProps) {
  const canDismiss = dismissible && !busy
  const ref = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const backdropDown = useRef(false)
  const id = useId()
  useEffect(() => {
    const dialog = ref.current
    if (!dialog || !open) return
    const returnFocus = returnFocusRef?.current
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const unlock = lockBody()
    if (!dialog.open) dialog.showModal()
    const target = initialFocusRef?.current
    if (target && dialog.contains(target)) target.focus()
    else heading.current?.focus()
    return () => {
      if (dialog.open) dialog.close()
      unlock()
      if (previous?.isConnected) previous.focus()
      else returnFocus?.focus()
    }
  }, [open, initialFocusRef, returnFocusRef])
  useEffect(() => {
    const dialog = ref.current, anchor = anchorRef?.current
    if (!open || !dialog || !anchor) return
    const viewport = window.visualViewport
    const position = () => {
      const rect = anchor.getBoundingClientRect()
      const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0
      const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight
      dialog.style.position = 'fixed'; dialog.style.margin = '0'; dialog.style.inset = 'auto'
      dialog.style.maxHeight = `${Math.max(0, height - 24)}px`
      const size = dialog.getBoundingClientRect()
      dialog.style.left = `${Math.max(left + 12, Math.min(anchorAlign === 'start' ? rect.left : rect.right - size.width, left + width - size.width - 12))}px`
      const below = rect.bottom + 8
      dialog.style.top = `${Math.max(top + 12, Math.min(below + size.height <= top + height - 12 ? below : rect.top - size.height - 8, top + height - size.height - 12))}px`
    }
    position()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(position) : undefined
    observer?.observe(anchor); observer?.observe(dialog)
    window.addEventListener('resize', position); window.addEventListener('scroll', position, true)
    viewport?.addEventListener('resize', position); viewport?.addEventListener('scroll', position)
    return () => {
      observer?.disconnect(); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true)
      viewport?.removeEventListener('resize', position); viewport?.removeEventListener('scroll', position)
      for (const property of ['position', 'margin', 'inset', 'max-height', 'left', 'top']) dialog.style.removeProperty(property)
    }
  }, [open, anchorRef, anchorAlign])
  if (typeof document === 'undefined') return null
  return createPortal(<dialog ref={ref} className={cx('n-theme', 'n-dialog', `n-dialog--${size}`, variant === 'drawer' && 'n-drawer', variant === 'sheet' && 'n-sheet', className)}
    role={role} aria-modal="true" aria-busy={busy || undefined} data-side={side} aria-labelledby={`${id}-title`} aria-describedby={description ? `${id}-description` : undefined}
    onKeyDownCapture={onKeyDownCapture}
    onKeyDown={(event) => {
      // Handle Escape explicitly rather than relying on the native cancel event.
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault(); if (canDismiss) onOpenChange(false)
    }}
    onCancel={(event) => { event.preventDefault(); if (canDismiss) onOpenChange(false) }}
    onClose={(event) => { if (!event.currentTarget.open) { if (open) onOpenChange(false); onAfterClose?.() } }}
    onPointerDown={(event) => { event.stopPropagation(); backdropDown.current = event.target === event.currentTarget }}
    onClick={(event) => { event.stopPropagation(); if (closeOnOutsideClick && canDismiss && backdropDown.current && event.target === event.currentTarget) onOpenChange(false); backdropDown.current = false }}>
    <div className="n-dialog-inner"><header className="n-dialog-header">{headerLeading}<div><h2 id={`${id}-title`} tabIndex={-1} ref={heading}>{title}</h2>
      {description && <p id={`${id}-description`}>{description}</p>}</div><IconButton label={closeLabel} variant="ghost" disabled={!canDismiss} onClick={() => onOpenChange(false)}><Icon name="close" /></IconButton></header>
      <div className="n-dialog-body">{children}</div>{footer && <footer className="n-dialog-footer">{footer}</footer>}
    </div>
  </dialog>, document.body)
}

export function Drawer(props: Omit<DialogProps, 'variant'>) { return <Dialog {...props} variant="drawer" /> }

export function BottomSheet(props: Omit<DialogProps, 'variant'>) { return <Dialog {...props} variant="sheet" /> }

export interface ConfirmDialogProps {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string
  confirmLabel: string; onConfirm: () => void; confirmation?: string; pending?: boolean; error?: string
}
export function ConfirmDialog(props: ConfirmDialogProps) {
  return <Dialog open={props.open} onOpenChange={props.onOpenChange} title={props.title} description={props.description} dismissible={!props.pending} busy={props.pending} role="alertdialog" size="sm">
    {props.open && <ConfirmContents {...props} />}
  </Dialog>
}
function ConfirmContents({ confirmation, pending, error, onOpenChange, onConfirm, confirmLabel }: ConfirmDialogProps) {
  const [typed, setTyped] = useState('')
  return <div className="n-stack">{confirmation && <TextField label={`Type “${confirmation}” to confirm`} value={typed} disabled={pending} onChange={(event) => setTyped(event.currentTarget.value)} autoComplete="off" spellCheck={false} />}
    {error && <p className="n-field-error" role="alert">{error}</p>}
    <div className="n-actions"><Button disabled={pending} onClick={() => onOpenChange(false)}>Keep it</Button><Button variant="danger" loading={pending}
      disabled={Boolean(confirmation) && typed !== confirmation} onClick={onConfirm}>{confirmLabel}</Button></div></div>
}

export function Tooltip({ content, children }: { content: string; children: ReactElement<{ 'aria-describedby'?: string }> }) {
  const id = useId()
  const ref = useRef<HTMLSpanElement>(null)
  const surface = useRef<HTMLSpanElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [open, setOpen] = useState(false)
  useFloatingSurface(open, ref, surface, 270)
  function show() { clearTimeout(timer.current); setOpen(true) }
  function scheduleHide() {
    clearTimeout(timer.current)
    // The gap remains traversable; hover/focus content must not vanish under the pointer.
    timer.current = setTimeout(() => {
      if (!ref.current?.matches(':hover') && !ref.current?.contains(document.activeElement)) setOpen(false)
    }, 160)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    if (!open) return
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      const anchor = ref.current
      const focusedPopup = document.activeElement?.closest('[role="combobox"][aria-expanded="true"], [role="menu"], [role="dialog"]')
      const modal = Array.from(document.querySelectorAll('dialog[open]')).at(-1)
      const ownsFocus = Boolean(anchor?.contains(document.activeElement))
      const ownsHover = Boolean(anchor?.matches(':hover')) && !focusedPopup && (!modal || Boolean(anchor && modal.contains(anchor)))
      // A lingering hover tip must not swallow Escape from a newly focused picker/modal.
      if (ownsFocus || ownsHover) { event.preventDefault(); event.stopPropagation() }
      clearTimeout(timer.current); setOpen(false)
    }
    document.addEventListener('keydown', escape, true)
    return () => document.removeEventListener('keydown', escape, true)
  }, [open])
  return <span ref={ref} className="n-tooltip-anchor" onMouseEnter={show} onMouseLeave={scheduleHide} onFocus={show} onBlur={scheduleHide}>
    {cloneElement(children, { 'aria-describedby': [children.props['aria-describedby'], open ? id : ''].filter(Boolean).join(' ') || undefined })}
    {open && <span ref={surface} popover="manual" id={id} role="tooltip" className="n-theme n-tooltip" onMouseEnter={show} onMouseLeave={scheduleHide}>{content}</span>}
  </span>
}
