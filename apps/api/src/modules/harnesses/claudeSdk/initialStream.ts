import type { NativeHarnessEvent } from '@foreman-code/contracts'

/** Prime the admitted first-input iterator so session persistence can complete
 * before session-scoped text readers are built. This never offers another input
 * and closing this observer does not cancel the native session. */
export async function primeInitialNativeStream(events: AsyncIterable<NativeHarnessEvent>) {
  const iterator = events[Symbol.asyncIterator]()
  let first: IteratorResult<NativeHarnessEvent>
  try { first = await iterator.next() }
  catch (error) { await iterator.return?.(); throw error }
  let closed = false
  let reading = false
  const close = async () => {
    if (closed) return
    closed = true
    await iterator.return?.()
  }
  const output: AsyncIterable<NativeHarnessEvent> = {
    async *[Symbol.asyncIterator]() {
      if (reading) throw new Error('The admitted initial stream has one observer.')
      reading = true
      try {
        if (closed) return
        if (!first.done) yield first.value
        while (!closed && !first.done) {
          first = await iterator.next()
          if (!first.done) yield first.value
        }
      } finally { await close() }
    },
  }
  return { output, close }
}
