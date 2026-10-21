import { useEffect, useState } from 'react'
import { ApiError } from './client'
import { isApiAccessError } from './accessError'

/** UI-only denial latch: a later network failure must not reveal an old protected draft. */
export function useProtectedAccessError(query: {
  error: unknown; failureReason: unknown; isSuccess: boolean; failureCount: number; dataUpdatedAt: number
}, mutationError?: unknown): ApiError | undefined {
  const current = isApiAccessError(query.error) ? query.error
    : isApiAccessError(query.failureReason) ? query.failureReason
      : isApiAccessError(mutationError) ? mutationError : undefined
  const [latched, setLatched] = useState<ApiError>()
  useEffect(() => {
    if (current) setLatched(current)
    else if (query.isSuccess && query.failureCount === 0) setLatched(undefined)
  }, [current, query.isSuccess, query.failureCount, query.dataUpdatedAt])
  return current ?? latched
}
