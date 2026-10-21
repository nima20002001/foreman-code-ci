import { useEffect, useReducer } from 'react'

const defaultClock = () => performance.now()

/**
 * Milliseconds elapsed on the monotonic clock since a response arrived. Computed from the clock on every render, so a
 * paused or throttled timer resumes at the true elapsed time instead of showing a stale age; the interval only re-renders.
 */
export function useMonotonicElapsed(receivedMonoMs: number | undefined, tickMs = 1000, clock: () => number = defaultClock): number {
  const [, tick] = useReducer((value: number) => value + 1, 0)
  useEffect(() => {
    if (receivedMonoMs === undefined) return
    const refresh = () => tick()
    const timer = setInterval(refresh, tickMs)
    document.addEventListener('visibilitychange', refresh)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh) }
  }, [receivedMonoMs, tickMs])
  return receivedMonoMs === undefined ? 0 : Math.max(0, clock() - receivedMonoMs)
}
