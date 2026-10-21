/** One read serves every caller that starts before it is sent, so each still observes state as of its own
 * start; a caller that starts after it was sent gets a fresh read. */
export function burstRead<T>(read: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined
  return () => pending ??= Promise.resolve().then(() => {
    pending = undefined
    return read()
  })
}
