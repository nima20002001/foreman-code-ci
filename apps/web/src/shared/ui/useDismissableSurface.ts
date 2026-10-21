import { useEffect, useRef, type RefObject } from 'react'

export type SurfaceDismissReason = 'escape' | 'outside' | 'exclusive'

interface DismissableSurfaceOptions {
  /** Listeners are attached only while the surface is open. */
  open: boolean
  /**
   * State-only close callback. Each surface keeps ownership of focus return so
   * it can name the control that opened it. The reason is provided when a
   * surface must treat an outside press differently from Escape.
   */
  onDismiss: (reason: SurfaceDismissReason) => void
  /** Container for the surface. Presses inside it never dismiss. */
  surfaceRef: RefObject<HTMLElement | null>
  /**
   * Opening control. Presses on it are left to its own toggle handler, and
   * focus returns here after a press elsewhere once default browser focus
   * handling has settled.
   */
  triggerRef?: RefObject<HTMLElement | null>
  /** Escape closes standard surfaces unless a persistent picker opts out. */
  dismissOnEscape?: boolean
}

const openSurfaces = new Map<symbol, () => void>()

/**
 * Shared dismissal contract for menus, popovers, and dialogs: Escape, presses
 * outside, and mutual exclusivity between surfaces. Focus is only restored to
 * the trigger when the press did not hand focus to another control.
 */
export function useDismissableSurface({
  open,
  onDismiss,
  surfaceRef,
  triggerRef,
  dismissOnEscape = true,
}: DismissableSurfaceOptions): void {
  const onDismissRef = useRef(onDismiss)
  const surfaceIdRef = useRef<symbol>(Symbol('dismissable-surface'))

  useEffect(() => {
    onDismissRef.current = onDismiss
  })

  useEffect(() => {
    if (!open) return
    const surfaceId = surfaceIdRef.current
    openSurfaces.set(surfaceId, () => onDismissRef.current('exclusive'))
    for (const [id, closeOther] of [...openSurfaces]) {
      if (id !== surfaceId) closeOther()
    }
    return () => {
      openSurfaces.delete(surfaceId)
    }
  }, [open])

  useEffect(() => {
    if (!open) return

    const closeOnEscape = (event: KeyboardEvent) => {
      if (!dismissOnEscape || event.key !== 'Escape') return
      if (document.querySelector('dialog[open][aria-modal="true"]')) return
      event.preventDefault()
      onDismissRef.current('escape')
    }

    const closeOnOutsidePress = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (target instanceof Element && target.closest('dialog[open][aria-modal="true"]')) return
      // Let navigation and panel triggers own the destination of a leave decision.
      if (target instanceof Element && target.closest('a[href], button[aria-haspopup="dialog"]')) return
      if (surfaceRef.current?.contains(target)) return
      if (triggerRef?.current?.contains(target)) return
      onDismissRef.current('outside')
      window.setTimeout(() => {
        const active = document.activeElement
        if (active && active !== document.body && active !== document.documentElement) return
        triggerRef?.current?.focus()
      }, 0)
    }

    window.addEventListener('keydown', closeOnEscape)
    // Capture is required for surfaces anchored inside canvases such as React
    // Flow, which may stop bubbling pointer events before they reach document.
    document.addEventListener('mousedown', closeOnOutsidePress, true)
    return () => {
      window.removeEventListener('keydown', closeOnEscape)
      document.removeEventListener('mousedown', closeOnOutsidePress, true)
    }
  }, [dismissOnEscape, open, surfaceRef, triggerRef])
}
