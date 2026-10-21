import { DomainError } from '../errors.js'

/** One session-wide dispatch fence. A queued batch cannot enter its next helper command after takeover. */
export class BrowserDispatchGate {
  private pending = 0
  private readonly targets = new Map<string, number>()
  private idle = new Set<() => void>()
  private waiters = new Set<() => void>()
  private agentOpen = true
  private closed = false

  fence(): void { this.agentOpen = false }
  open(): void {
    if (this.closed) return
    this.agentOpen = true
    for (const resume of this.waiters) resume()
    this.waiters.clear()
  }
  close(): void {
    this.closed = true; this.agentOpen = false
    for (const resume of this.waiters) resume()
    this.waiters.clear()
  }

  async waitForAgent(signal?: AbortSignal): Promise<void> {
    while (!this.agentOpen) {
      if (this.closed) throw new DomainError('BROWSER_CLOSED', 'The browser session is closed.', 409)
      signal?.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        const done = () => { cleanup(); resolve() }
        const aborted = () => { cleanup(); reject(signal?.reason) }
        const cleanup = () => { this.waiters.delete(done); signal?.removeEventListener('abort', aborted) }
        this.waiters.add(done); signal?.addEventListener('abort', aborted, { once: true })
        if (signal?.aborted) aborted()
      })
    }
    if (this.closed) throw new DomainError('BROWSER_CLOSED', 'The browser session is closed.', 409)
  }

  atDialogBoundary(dialogTabs: ReadonlySet<string>): boolean {
    return this.pending > 0 && [...this.targets].reduce((sum, [tabId, count]) => sum + (dialogTabs.has(tabId) ? count : 0), 0) === this.pending
  }

  async dispatch<T>(isAgent: boolean, assertCurrent: () => void, call: () => Promise<T>, tabId?: string): Promise<T> {
    if (this.closed || isAgent && !this.agentOpen) {
      throw new DomainError('BROWSER_PAUSED', 'Browser actions are paused while control changes.', 409)
    }
    assertCurrent()
    // No await between the fence check and admission.
    this.pending++
    if (tabId) this.targets.set(tabId, (this.targets.get(tabId) ?? 0) + 1)
    try { return await call() } finally {
      this.pending--
      if (tabId) {
        const count = (this.targets.get(tabId) ?? 1) - 1
        if (count) this.targets.set(tabId, count); else this.targets.delete(tabId)
      }
      if (!this.pending) { for (const resolve of this.idle) resolve(); this.idle.clear() }
    }
  }

  async settle(timeoutMs = 10_000): Promise<boolean> {
    if (!this.pending) return true
    return new Promise(resolve => {
      const settled = () => { clearTimeout(timeout); this.idle.delete(settled); resolve(true) }
      const timeout = setTimeout(() => { this.idle.delete(settled); resolve(false) }, timeoutMs)
      this.idle.add(settled)
    })
  }
}
