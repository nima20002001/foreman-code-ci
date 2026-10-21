import { useCallback, useLayoutEffect, useRef } from 'react'

/** Stable render-object actions dispatch to the latest committed editor, not a stale draft. */
export function useGraphEvent<Args extends unknown[], Result>(callback: (...args: Args) => Result) {
  const latest = useRef(callback)
  useLayoutEffect(() => { latest.current = callback }, [callback])
  return useCallback((...args: Args): Result => latest.current(...args), [])
}
