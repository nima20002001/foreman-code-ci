import { useEffect, useState } from 'react'
import type { DurableInteraction, ReviewStatus } from '@foreman-code/contracts'
import { Alert } from '../../shared/ui/nocturne'
import { reviewStatusPresentation } from './reviewStatusPresentation'

export function ReviewStatusNotice({ review, interaction }: { review: ReviewStatus; interaction: DurableInteraction }) {
  const [now, setNow] = useState(() => Date.now())
  const view = reviewStatusPresentation(review, interaction, now)
  useEffect(() => {
    setNow(Date.now())
    if (!view.retryScheduled || view.retryAt <= Date.now()) return
    // Only the retry wording uses a clock; backend state stays in React Query.
    const timer = window.setInterval(() => {
      const current = Date.now()
      setNow(current)
      if (current >= view.retryAt) window.clearInterval(timer)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [view.retryScheduled, view.retryAt])
  if (!view.visible) return null
  return <Alert live tone={view.failed ? 'danger' : 'warning'} title={view.title}>
    {view.errorMessage ? <p>{view.errorMessage}</p> : null}
    {view.retryMessage ? <p>{view.retryMessage}</p> : null}
    {review.reviewJobId ? <small>Review: {review.reviewJobId}</small> : null}
  </Alert>
}
