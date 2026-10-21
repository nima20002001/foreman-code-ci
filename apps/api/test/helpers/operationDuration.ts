/** Time spent with at least one operation in progress, excluding idle gaps. */
export function operationDuration() {
  let elapsedMs = 0
  let active = 0
  let started = 0
  return {
    get elapsedMs() { return elapsedMs },
    async measure<T>(operation: () => Promise<T>): Promise<T> {
      // Concurrent callers can await the same serialized writer; summing their waits double-counts time.
      if (active === 0) started = performance.now()
      active += 1
      try {
        return await operation()
      } finally {
        active -= 1
        if (active === 0) elapsedMs += performance.now() - started
      }
    },
  }
}
