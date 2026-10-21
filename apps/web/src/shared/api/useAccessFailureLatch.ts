import { useEffect, useState } from 'react'
import { isAccessFailure } from './accessErrors'

/** An authorization rejection stays closed through subsequent network errors.
 * Only a successful query result may reopen it. This is a UI gate, not a data cache. */
export function useAccessFailureLatch(query: {
  error: unknown; failureReason: unknown; isSuccess: boolean; failureCount: number; dataUpdatedAt: number
}): boolean {
  const denied = isAccessFailure(query.error) || isAccessFailure(query.failureReason)
  const [blocked, setBlocked] = useState(false)
  useEffect(() => {
    if (denied) setBlocked(true)
    else if (query.isSuccess && query.failureCount === 0) setBlocked(false)
  }, [denied, query.isSuccess, query.failureCount, query.dataUpdatedAt])
  return denied || blocked
}
