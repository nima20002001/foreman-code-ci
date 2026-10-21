import { useEffect, useSyncExternalStore } from 'react'
import { frameAt } from './advancedUtils'
function subscribeMotion(callback: () => void) {
  if (typeof window.matchMedia !== 'function') return () => {}
  const media = window.matchMedia('(prefers-reduced-motion: reduce)')
  media.addEventListener('change', callback)
  return () => media.removeEventListener('change', callback)
}
export function useReducedMotion() {
  return useSyncExternalStore(subscribeMotion, () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches, () => true)
}
/** Advances a supplied view index, never an API run. Start explicitly; pausing preserves position. */
export function useReplay({ index, count, playing, speed = 1, onSeek, onPlayingChange }:
  { index: number; count: number; playing: boolean; speed?: number; onSeek: (index: number) => void; onPlayingChange: (playing: boolean) => void }) {
  useEffect(() => {
    if (!playing) return
    if (!Number.isFinite(count) || Math.floor(count) < 2 || frameAt(index, count) >= Math.floor(count) - 1) { onPlayingChange(false); return }
    if (document.hidden) { onPlayingChange(false); return }
    const handle = setTimeout(() => { if (!document.hidden) onSeek(frameAt(frameAt(index, count) + 1, count)) }, 2000 / ([.5, 1, 2].includes(speed) ? speed : 1))
    function visibility() { if (document.hidden) { clearTimeout(handle); onPlayingChange(false) } }
    document.addEventListener('visibilitychange', visibility)
    return () => { clearTimeout(handle); document.removeEventListener('visibilitychange', visibility) }
  }, [count, index, playing, speed, onSeek, onPlayingChange])
}
