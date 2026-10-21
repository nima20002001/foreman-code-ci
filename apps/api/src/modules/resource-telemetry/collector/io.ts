import { readBounded } from './linuxProcfs.js'
import type { ProcessReader } from './processSet.js'
/** At most eight open/read operations; aborted waiters never start I/O. */
export function boundedReader(concurrency = 8) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('limit-exceeded')
  let active = 0
  const waiting: Array<() => void> = []
  const read = async (path: string, signal: AbortSignal, maxBytes?: number): Promise<string> => {
    if (active >= concurrency) await new Promise<void>(resolve => waiting.push(resolve))
    else active++
    try { signal.throwIfAborted(); return await readBounded(path, signal, maxBytes) }
    finally { const next = waiting.shift(); if (next) next(); else active-- }
  }
  return { read, process: {
    stat: (pid, signal) => read(`/proc/${pid}/stat`, signal, 8192),
    children: async (pid, signal) => {
      // The kernel leader children list is deliberately partial for threaded parents.
      const text = await read(`/proc/${pid}/task/${pid}/children`, signal, 32768)
      const values = text.trim() ? text.trim().split(/\s+/).map(Number) : []
      if (values.some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error('invalid-counter')
      return values
    },
  } satisfies ProcessReader }
}
