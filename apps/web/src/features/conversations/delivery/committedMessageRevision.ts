// Client admission proof follows each immutable row object without changing the wire contract
// or promoting a partial text event into a complete lifecycle snapshot.
const revisions = new WeakMap<object, string>()

export function rememberCommittedRevision<T extends object>(message: T, revision: string): T {
  const previous = revisions.get(message)
  if (!previous || BigInt(revision) > BigInt(previous)) revisions.set(message, revision)
  return message
}

export function inheritCommittedRevision<T extends object>(message: T, source: object): T {
  const revision = revisions.get(source)
  return revision ? rememberCommittedRevision(message, revision) : message
}

export function committedAfterSnapshot(message: object, revision: number) {
  const committed = revisions.get(message)
  return committed !== undefined && BigInt(committed) > BigInt(revision)
}
