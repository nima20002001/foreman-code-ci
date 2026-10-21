/** A bounded history read wakes on native output, completion, cancellation or the idle heartbeat. */
export class WorkerEventWait {
  private readonly listeners = new Map<string, Set<() => void>>()

  subscribe(id: string, signal: AbortSignal) {
    let finish!: () => void
    const ready = new Promise<void>(resolve => { finish = resolve })
    const listeners = this.listeners.get(id) ?? new Set<() => void>()
    this.listeners.set(id, listeners)
    const dispose = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', wake)
      listeners.delete(wake)
      if (!listeners.size) this.listeners.delete(id)
    }
    const wake = () => { dispose(); finish() }
    const timer = setTimeout(wake, 2_000)
    listeners.add(wake)
    signal.addEventListener('abort', wake, { once: true })
    if (signal.aborted) wake()
    return { ready, dispose }
  }

  publish(id: string) {
    for (const wake of this.listeners.get(id) ?? []) wake()
  }
}
