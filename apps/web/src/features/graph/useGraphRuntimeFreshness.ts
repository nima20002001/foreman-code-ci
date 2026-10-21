import { useEffect, useState } from 'react'

/** One availability timeout at the synchronization owner, never one timer per node. */
export function useGraphRuntimeFreshness(runId: string | undefined, updatedAt: number, maxAge: number): boolean {
  const [expired, setExpired] = useState<{ runId: string; updatedAt: number }>()
  useEffect(() => {
    if (!runId || !updatedAt) return
    const timeout = window.setTimeout(() => setExpired({ runId, updatedAt }),
      Math.max(0, updatedAt + maxAge - Date.now()))
    return () => window.clearTimeout(timeout)
  }, [runId, updatedAt, maxAge])
  return !runId || Boolean(updatedAt && Date.now() - updatedAt < maxAge
    && !(expired?.runId === runId && expired.updatedAt === updatedAt))
}
