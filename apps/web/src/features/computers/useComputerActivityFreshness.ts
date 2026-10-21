import { useEffect, useState, useSyncExternalStore } from 'react'
import { onlineManager } from '@tanstack/react-query'

// Three missed five-second refreshes turn current presence into a last-observed fact.
const ACTIVITY_FRESH_MS = 15_000
const subscribeOnline = (notify: () => void) => onlineManager.subscribe(notify)
const readOnline = () => onlineManager.isOnline()

export function useComputerActivityFreshness(updatedAt: number, fetchStatus: 'fetching' | 'paused' | 'idle') {
  const online = useSyncExternalStore(subscribeOnline, readOnline)
  const [checkedAt, setCheckedAt] = useState(() => Date.now())
  useEffect(() => {
    const remaining = updatedAt + ACTIVITY_FRESH_MS - Date.now()
    const timer = setTimeout(() => setCheckedAt(Date.now()), Math.max(0, remaining))
    return () => clearTimeout(timer)
  }, [updatedAt])
  return online && fetchStatus !== 'paused' && updatedAt > 0
    && checkedAt - updatedAt < ACTIVITY_FRESH_MS
}
