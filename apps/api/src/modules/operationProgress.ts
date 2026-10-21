import { AsyncLocalStorage } from 'node:async_hooks'

const progress = new AsyncLocalStorage<(bytes: number) => void>()

/** Nested requests carry byte progress back to the operation waiting for them. */
export function withOperationProgress<T>(report: (bytes: number) => void, work: () => T): T {
  return progress.run(report, work)
}

export function operationProgressReporter(): (bytes: number) => void {
  return progress.getStore() ?? (() => {})
}

export function reportOperationProgress(bytes: number): void {
  if (bytes > 0) progress.getStore()?.(bytes)
}
