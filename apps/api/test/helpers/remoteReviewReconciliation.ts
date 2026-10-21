export function remoteReviewReconciliation(reconcile: () => Promise<void>): () => Promise<void> {
  let completedAt = -Infinity
  let pending: Promise<void> | undefined
  return async () => {
    if (pending) return pending
    // Reconciliation writes also notify the waiter; they must not trigger another pass immediately.
    if (performance.now() - completedAt < 1_000) return
    pending = reconcile().then(() => {
      completedAt = performance.now()
    }).finally(() => {
      pending = undefined
    })
    return pending
  }
}
