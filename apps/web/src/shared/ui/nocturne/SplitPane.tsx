import { useRef, useEffect, type ReactNode, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { clamp } from './utils'

/** Controlled size: wire persistent layout preference to the existing Zustand owner. */
export function SplitPane({ primary, secondary, size, onSizeChange, min = 220, max = 600, label = 'Resize panel' }:
  { primary: ReactNode; secondary: ReactNode; size: number; onSizeChange: (size: number) => void; min?: number; max?: number; label?: string }) {
  const stopRef = useRef<(() => void) | undefined>(undefined)
  const upper = Math.max(min, max)
  const safe = clamp(size, min, upper)
  useEffect(() => () => stopRef.current?.(), [])
  function start(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    stopRef.current?.()
    const startX = event.clientX
    const pointerId = event.pointerId
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl'
    function move(next: PointerEvent) { if (next.pointerId === pointerId) onSizeChange(clamp(safe + (next.clientX - startX) * (rtl ? -1 : 1), min, upper)) }
    function stop() { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish); window.removeEventListener('blur', stop); stopRef.current = undefined }
    function finish(next: PointerEvent) { if (next.pointerId === pointerId) stop() }
    stopRef.current = stop
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', stop)
  }
  return <div className="n-split" style={{ '--n-pane-size': `${safe}px` } as CSSProperties}><div>{primary}</div>
    <div role="separator" aria-orientation="vertical" aria-label={label} tabIndex={0} aria-valuenow={safe} aria-valuemin={min} aria-valuemax={upper}
      className="n-split-handle" onPointerDown={start} onKeyDown={(event) => {
        const rtl = getComputedStyle(event.currentTarget).direction === 'rtl'
        const step = event.shiftKey ? 32 : 8
        const delta = (rtl ? -1 : 1) * step
        const value = event.key === 'Home' ? min : event.key === 'End' ? upper : event.key === 'ArrowLeft' ? safe - delta : event.key === 'ArrowRight' ? safe + delta : undefined
        if (value !== undefined) { event.preventDefault(); onSizeChange(clamp(value, min, upper)) }
      }} /><div>{secondary}</div></div>
}
