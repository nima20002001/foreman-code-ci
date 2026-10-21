import { useEffect, useState } from 'react'

/** Matches the exit animation length in the overlay motion CSS. */
export const OVERLAY_MOTION_DURATION = 180

/**
 * Motion is only meaningful where the browser can animate and the user has not
 * asked for reduced motion. Tests and reduced-motion users unmount immediately.
 */
export function motionEnabled(): boolean {
  if (typeof window === 'undefined' || typeof Element === 'undefined') return false
  if (typeof Element.prototype.animate !== 'function') return false
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches !== true
}

/**
 * Keeps an exiting surface mounted until its exit animation has finished so a
 * dialog or backdrop never disappears before the motion completes.
 */
export function usePresence(open: boolean, duration = OVERLAY_MOTION_DURATION) {
  const [kept, setKept] = useState(open)
  const [exiting, setExiting] = useState(false)

  useEffect(() => {
    if (open) {
      setKept(true)
      setExiting(false)
      return
    }
    if (!kept) return
    if (!motionEnabled()) {
      setKept(false)
      setExiting(false)
      return
    }
    setExiting(true)
    const timeout = window.setTimeout(() => {
      setKept(false)
      setExiting(false)
    }, duration)
    return () => window.clearTimeout(timeout)
  }, [duration, kept, open])

  // Open surfaces mount in the same commit so opening effects can focus them.
  return { mounted: open || kept, exiting }
}
