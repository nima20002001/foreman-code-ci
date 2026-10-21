/** JSDOM lacks Web Locks; model exclusive commands and nonblocking tab ownership claims. */
export function installBrowserLocks() {
  const browserNavigator = navigator
  const originalLocks = Object.getOwnPropertyDescriptor(browserNavigator, 'locks')
  const pending = new Map<string, Promise<unknown>>()
  Object.defineProperty(browserNavigator, 'locks', { configurable: true, value: {
    request<T>(name: string, options: LockOptions | ((lock: Lock) => T | PromiseLike<T>),
      callback?: (lock: Lock | null) => T | PromiseLike<T>): Promise<T> {
      const work = typeof options === 'function' ? options : callback!
      const lock = { name, mode: 'exclusive' as const }
      if (typeof options !== 'function' && options.ifAvailable && pending.has(name)) {
        return Promise.resolve(callback!(null))
      }
      const result = (pending.get(name) ?? Promise.resolve()).then(() => {
        if (typeof options !== 'function') options.signal?.throwIfAborted()
        return work(lock)
      })
      // Rejected callbacks release the lock, so later commands can still acquire it.
      const released = result.then(() => undefined, () => undefined)
      pending.set(name, released)
      void released.then(() => {
        if (pending.get(name) === released) pending.delete(name)
      })
      return result
    },
  } })
  return () => {
    if (originalLocks) Object.defineProperty(browserNavigator, 'locks', originalLocks)
    else Reflect.deleteProperty(browserNavigator, 'locks')
  }
}
