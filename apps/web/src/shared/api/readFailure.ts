import { useEffect, useState } from 'react'
import { ApiError } from './client'

export function isTransientReadError(error: unknown): boolean {
  return ApiError.is(error) && error.code !== 'INVALID_RESPONSE'
    && ![401, 403, 404].includes(error.status)
    && (error.code === 'NETWORK_ERROR' || error.status >= 500 || error.status === 408 || error.status === 429)
}

/** A denied or invalid read hides cached content until a successful read replaces it. */
export function useBlockingReadError(query: {
  error: unknown; isSuccess: boolean; dataUpdatedAt: number
}): unknown {
  const current = query.error && !isTransientReadError(query.error) ? query.error : undefined
  const [blocked, setBlocked] = useState<unknown>()
  useEffect(() => {
    if (current) setBlocked(current)
    else if (query.isSuccess) setBlocked(undefined)
  }, [current, query.isSuccess, query.dataUpdatedAt])
  return current ?? blocked
}
