const held = new Map<string, Promise<void>>()

/**
 * Serializes the cleanup paths that close one source materialization (workflow closure and reservation
 * reclamation). Both remove the same Worker directory and settle the same reservation, so the second path
 * must start only after the first has committed and can then see that nothing is left to do.
 */
export async function withSourceOperationExclusion<T>(operationId: string, work: () => Promise<T>): Promise<T> {
  for (let current = held.get(operationId); current; current = held.get(operationId)) await current
  let release!: () => void
  held.set(operationId, new Promise<void>(resolve => { release = resolve }))
  try {
    return await work()
  } finally {
    held.delete(operationId)
    release()
  }
}
