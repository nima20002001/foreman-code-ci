const operations = new Map<string, Promise<unknown>>()

/** Async retirement must not let a second admission inspect partially removed registrations. */
export function registryOperation<T>(identity: string, work: () => Promise<T>): Promise<T> {
  const previous = operations.get(identity) ?? Promise.resolve()
  const task = previous.catch(() => {
    // ignore: the previous caller receives its failure; later operations still need to inspect storage.
  }).then(work)
  operations.set(identity, task)
  return task.finally(() => {
    if (operations.get(identity) === task) operations.delete(identity)
  })
}
