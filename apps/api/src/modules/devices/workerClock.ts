export const WORKER_CLOCK_TOLERANCE_MS = 2 * 60 * 1000

export function workerClockReason(workerTime: number | null, mainTime: number): string | null {
  if (workerTime === null) return 'Worker clock has not been observed on this connection.'
  if (Math.abs(workerTime - mainTime) > WORKER_CLOCK_TOLERANCE_MS) {
    return 'Worker clock differs from Main by more than 2 minutes. Synchronize the Worker clock.'
  }
  return null
}

/** Main timestamps advance with elapsed time even if the Worker's wall clock rolls back. */
export class MainClock {
  private sample: { mainTime: number; elapsed: number } | undefined
  constructor(private readonly elapsed: () => number = () => performance.now()) {}
  get observed(): boolean { return this.sample !== undefined }
  observe(mainTime: number): void {
    if (!Number.isFinite(mainTime)) throw new Error('Main clock observation is invalid.')
    this.sample = { mainTime, elapsed: this.elapsed() }
  }
  now(): number {
    if (!this.sample) throw new Error('Main clock has not been observed on this connection.')
    return this.sample.mainTime + this.elapsed() - this.sample.elapsed
  }
}
