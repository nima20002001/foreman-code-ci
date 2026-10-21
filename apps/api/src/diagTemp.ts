// TEMPORARY diagnostic, removed before the fix.
import { writeFileSync } from 'node:fs'
import { monitorEventLoopDelay } from 'node:perf_hooks'
const g = globalThis as { __dt?: Record<string, { n: number; ms: number; max: number }>; __dtFile?: string; __lag?: ReturnType<typeof monitorEventLoopDelay> }
export function diagFile(file: string): void { g.__dtFile = file; if (!g.__lag) { g.__lag = monitorEventLoopDelay({ resolution: 10 }); g.__lag.enable() } }
export async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now()
  try { return await run() } finally {
    const stats = (g.__dt ??= {})
    const entry = stats[label] ??= { n: 0, ms: 0, max: 0 }
    const ms = performance.now() - started
    entry.n++; entry.ms += ms; entry.max = Math.max(entry.max, ms)
    if (g.__dtFile) writeFileSync(g.__dtFile, JSON.stringify({ lagMean: g.__lag?.mean, lagMax: g.__lag?.max, stats }))
  }
}
