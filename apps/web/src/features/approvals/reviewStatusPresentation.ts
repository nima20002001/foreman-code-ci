import type { DurableInteraction, ReviewStatus } from '@foreman-code/contracts'

/** Presentation only. A due clock is never evidence that a retry actually started. */
export function reviewStatusPresentation(review: ReviewStatus, interaction: Pick<DurableInteraction, 'status' | 'deliveryState'>, now: number) {
  const failed = review.state === 'failed'
  const canceled = interaction.status === 'canceled'
  const completed = review.state === 'completed'
  const delivered = interaction.deliveryState === 'delivered'
  const visible = failed || interaction.status === 'pending' || (!completed && delivered)
  const title = failed ? 'Orchestrator review stopped'
    : completed ? 'Orchestrator finished without a decision'
      : canceled ? 'Orchestrator review canceled'
        : review.state === 'uncertain' ? 'Checking native review settlement'
          : ['blocked_busy', 'blocked_disconnected'].includes(review.state) ? 'Orchestrator connection unavailable'
            : ['leased', 'submitted', 'acknowledged'].includes(review.state) ? 'Orchestrator reviewing' : 'Waiting for Orchestrator'
  const retryAt = review.retryAfter ? Date.parse(review.retryAfter) : NaN
  const retryScheduled = !failed && !completed && !canceled && Number.isFinite(retryAt)
  const retryMessage = failed
    ? review.cleanupPending !== false ? 'No automatic review retry. Native or credential cleanup is still pending; use Stop to retry cleanup.'
      : 'No automatic review retry. Cleanup finished; correct the reviewer settings before starting a new Run.'
    : canceled ? 'This request is canceled. No automatic review retry is scheduled.'
      : retryScheduled ? retryAt > now ? `Retry scheduled for ${new Date(retryAt).toLocaleString()}.`
        : 'Retry is due; waiting for the next backend check.'
        : completed ? 'This request is still pending. Correct the reviewer settings before starting a new Run.'
          : delivered ? 'The Worker decision was delivered. The native review still needs settlement; the decision will not be resent.'
            : undefined
  return { visible, title, failed, errorMessage: review.error?.message, retryMessage, retryScheduled, retryAt }
}
