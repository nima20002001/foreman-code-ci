import { remoteReviewProduction, waitForRemoteReview } from './remoteReviewProduction.js'

export function reservationCleanupWorkflow() {
  // Reservation locking needs one native preparation and completion, regardless of graph size.
  return remoteReviewProduction({ workflow: 'single' })
}

export function completeReservationCleanupWorkflow(
  fixture: Awaited<ReturnType<typeof reservationCleanupWorkflow>>,
  runId: string,
) {
  return waitForRemoteReview(async () => {
    await fixture.reconcile()
    return fixture.details(runId)
  }, value => value.run.executionState === 'completed' && !value.cleanupPending,
  'workflow completion after cleanup deferral')
}
