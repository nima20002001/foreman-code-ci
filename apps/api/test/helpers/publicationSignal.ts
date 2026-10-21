/** Wakeups select a read; consumers still verify the committed database state. */
export function publicationSignal() {
  let resolve!: () => void
  let pending = new Promise<void>((wake) => { resolve = wake })
  return {
    next: () => pending,
    notify() {
      const wake = resolve
      pending = new Promise<void>((next) => { resolve = next })
      wake()
    },
  }
}
