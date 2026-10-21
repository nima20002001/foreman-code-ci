import { AsyncLocalStorage } from 'node:async_hooks'

const priority = new AsyncLocalStorage<{ signal?: AbortSignal | undefined; reserved?: false }>()
interface DatabaseQueue {
  active: boolean
  delivery: (() => void)[]
  claims: (() => void)[]
}
const databaseQueues = new WeakMap<object, DatabaseQueue>()

/** Only CI admission and dispatch may borrow the reserved database connections. */
export function withCiDatabasePriority<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return priority.run({ signal }, work)
}

export function withoutCiDatabasePriority<T>(work: () => Promise<T>): Promise<T> {
  return priority.exit(work)
}

export function ciDatabasePriority() {
  const context = priority.getStore()
  return context?.reserved === false ? undefined : context
}

export function ciDatabaseDeadline(): AbortSignal | undefined {
  return priority.getStore()?.signal
}

/** Executor I/O keeps its dispatch deadline without borrowing reserved database connections. */
export function withoutCiDatabaseReservation<T>(work: () => Promise<T>): Promise<T> {
  const context = priority.getStore()
  return context ? priority.run({ ...context, reserved: false }, work) : work()
}

/** Only the short database step borrows a reserved connection; executor I/O stays outside this scope. */
export function withCiDatabaseReservation<T>(pool: object, work: () => Promise<T>): Promise<T> {
  const context = priority.getStore()
  if (!context) return work()
  return withCiDatabasePriority(() => queueCiDatabaseWork(pool, work, 'delivery'), context.signal)
}

function advanceDatabaseQueue(pool: object, queue: DatabaseQueue) {
  if (queue.active) return
  // Finish delivering claimed tickets before spending the pass on more slot claims.
  const resume = queue.delivery.shift() ?? queue.claims.shift()
  if (!resume) {
    if (databaseQueues.get(pool) === queue) databaseQueues.delete(pool)
    return
  }
  queue.active = true
  resume()
}

/** Queue database work before leasing, leaving the second reserved connection for admission and readiness. */
export function queueCiDatabaseWork<T>(pool: object, work: () => Promise<T>, kind: 'claim' | 'delivery'): Promise<T> {
  return waitForCiDispatch(async () => {
    let queue = databaseQueues.get(pool)
    if (!queue) {
      queue = { active: false, delivery: [], claims: [] }
      databaseQueues.set(pool, queue)
    }
    const selected = queue
    const ready = new Promise<void>(resolve => {
      if (kind === 'delivery') selected.delivery.push(resolve)
      else selected.claims.push(resolve)
    })
    queueMicrotask(() => advanceDatabaseQueue(pool, selected))
    await ready
    try {
      ciDatabaseDeadline()?.throwIfAborted()
      return await work()
    } finally {
      selected.active = false
      queueMicrotask(() => advanceDatabaseQueue(pool, selected))
    }
  })
}

/** Claim cleanup must still run when its dispatch pass has expired. */
export function withoutCiDatabaseDeadline<T>(work: () => Promise<T>): Promise<T> {
  const context = priority.getStore()
  return context ? priority.run({ ...context, signal: undefined }, work) : work()
}

export async function waitForCiDispatch<T>(work: () => Promise<T>): Promise<T> {
  const signal = priority.getStore()?.signal
  signal?.throwIfAborted()
  if (!signal) return work()
  let onAbort!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([work(), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
