import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from '../../shared/errorMessage'

/** Navigation requests B's owned release immediately; its durable recovery outlives the visible body. */
export function useBrowserPanelRelease(release: (() => void | Promise<void>) | undefined) {
  const [error, setError] = useState<string>()
  const generation = useRef(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current += 1 } }, [])
  const request = useCallback(() => {
    if (!release) return
    const current = ++generation.current
    if (mounted.current) setError(undefined)
    try {
      const result = release()
      void Promise.resolve(result).catch(failure => {
        if (mounted.current && current === generation.current) setError(errorMessage(failure, 'Browser control release is unconfirmed.'))
      })
    } catch (failure) { if (mounted.current) setError(errorMessage(failure, 'Browser control release is unconfirmed.')) }
  }, [release])
  return { request, error }
}
