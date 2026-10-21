/** A failed background operation waits before another attempt; success starts a fresh retry sequence. */
export class RetryBackoff {
  private failures = 0
  private nextAttemptAt = 0

  constructor(private readonly delays: { initialMs: number; maxMs: number }) {}

  ready(now = Date.now()): boolean {
    return now >= this.nextAttemptAt
  }

  fail(now = Date.now()): number {
    const delay = Math.min(this.delays.maxMs, this.delays.initialMs * 2 ** Math.min(this.failures, 30))
    this.failures++
    this.nextAttemptAt = now + delay
    return delay
  }

  reset(): void {
    this.failures = 0
    this.nextAttemptAt = 0
  }
}
