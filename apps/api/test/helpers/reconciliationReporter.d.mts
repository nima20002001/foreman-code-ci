export function reconciliationReporter(callbacks: {
  pending(error: Error): void
  failure(error: unknown): void
}): (error: unknown) => void
