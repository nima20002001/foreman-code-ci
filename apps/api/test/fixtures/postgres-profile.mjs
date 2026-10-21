/* global process, setInterval */
import { monitorEventLoopDelay } from 'node:perf_hooks'
import pg from 'pg'

// TEMPORARY diagnostic: cumulative driver time per statement head in the Main process.
const query = pg.Client.prototype.query
const stats = new Map()
const lag = monitorEventLoopDelay({ resolution: 10 })
lag.enable()
pg.Client.prototype.query = function (...args) {
  const pending = Reflect.apply(query, this, args)
  if (!pending || typeof pending.then !== 'function') return pending
  const statement = String(typeof args[0] === 'string' ? args[0] : args[0]?.text).replace(/\s+/g, ' ').slice(0, 110)
  const started = performance.now()
  const done = () => {
    const entry = stats.get(statement) ?? { n: 0, ms: 0, max: 0 }
    const ms = performance.now() - started
    entry.n += 1; entry.ms += ms; entry.max = Math.max(entry.max, ms)
    stats.set(statement, entry)
  }
  return pending.then(value => { done(); return value }, error => { done(); throw error })
}
setInterval(() => {
  const top = [...stats].sort((a, b) => b[1].ms - a[1].ms).slice(0, 12)
    .map(([statement, { n, ms, max }]) => ({ statement, n, ms: Math.round(ms), max: Math.round(max) }))
  process.send?.({ kind: 'pg-profile', diag: globalThis.__diag, total: [...stats.values()].reduce((sum, v) => sum + v.ms, 0) | 0,
    count: [...stats.values()].reduce((sum, v) => sum + v.n, 0), lagMeanMs: Math.round(lag.mean / 1e6), lagMaxMs: Math.round(lag.max / 1e6), top })
}, 5000).unref()
