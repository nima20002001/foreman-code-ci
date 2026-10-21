import { useEffect, type RefObject } from 'react'
import { clamp } from './utils'

/** A non-modal native top-layer surface. DOM ancestry is preserved for focus handling. */
export function useFloatingSurface(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  surfaceRef: RefObject<HTMLElement | null>,
  width: number | 'anchor' = 260,
  align: 'start' | 'end' = 'start',
  side: 'block' | 'inline' = 'block',
  /** False keeps the surface in normal stacking so a z-index can order it among other floating containers. */
  topLayer = true,
) {
  useEffect(() => {
    const anchor = anchorRef.current
    const surface = surfaceRef.current
    if (!open || !anchor || !surface) return
    const native = topLayer && typeof surface.showPopover === 'function'
    if (native) surface.showPopover()
    else surface.style.display = 'block'
    function position() {
      if (!anchor || !surface) return
      const rect = anchor.getBoundingClientRect()
      const viewport = window.visualViewport
      const leftEdge = viewport?.offsetLeft ?? 0
      const topEdge = viewport?.offsetTop ?? 0
      const viewportWidth = viewport?.width ?? window.innerWidth
      const viewportHeight = viewport?.height ?? window.innerHeight
      const desiredWidth = width === 'anchor' ? rect.width : width
      const actualWidth = Math.min(desiredWidth, Math.max(1, viewportWidth - 24))
      const rtl = getComputedStyle(anchor).direction === 'rtl'
      const endAligned = (align === 'end') !== rtl
      let left = clamp(endAligned ? rect.right - actualWidth : rect.left, leftEdge + 12, leftEdge + viewportWidth - actualWidth - 12)
      if (side === 'inline') {
        const preferred = rtl ? rect.left - actualWidth - 6 : rect.right + 6
        const opposite = rtl ? rect.right + 6 : rect.left - actualWidth - 6
        const fits = preferred >= leftEdge + 12 && preferred + actualWidth <= leftEdge + viewportWidth - 12
        left = clamp(fits ? preferred : opposite, leftEdge + 12, leftEdge + viewportWidth - actualWidth - 12)
      }
      const below = Math.max(0, topEdge + viewportHeight - rect.bottom - 20)
      const above = Math.max(0, rect.top - topEdge - 20)
      const upwards = below < Math.min(surface.scrollHeight, 240) && above > below
      const available = side === 'inline' ? viewportHeight - 24 : upwards ? above : below
      Object.assign(surface.style, {
        position: 'fixed', margin: '0', inset: 'auto', left: `${left}px`, width: `${actualWidth}px`,
        maxHeight: `${Math.min(360, Math.max(0, available))}px`,
      })
      const height = surface.getBoundingClientRect().height
      surface.style.top = side === 'inline' ? `${clamp(rect.top, topEdge + 12, topEdge + viewportHeight - height - 12)}px` : `${upwards ? Math.max(topEdge + 12, rect.top - height - 8) : Math.max(topEdge + 12, rect.bottom + 8)}px`
    }
    position()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(position) : undefined
    observer?.observe(anchor)
    observer?.observe(surface)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    window.visualViewport?.addEventListener('resize', position)
    window.visualViewport?.addEventListener('scroll', position)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
      window.visualViewport?.removeEventListener('resize', position)
      window.visualViewport?.removeEventListener('scroll', position)
      if (native && surface.matches(':popover-open')) surface.hidePopover()
    }
  }, [open, anchorRef, surfaceRef, width, align, side, topLayer])
}
