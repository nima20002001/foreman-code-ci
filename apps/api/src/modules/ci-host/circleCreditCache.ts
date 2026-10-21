import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { withHostCiRunLock } from './runnerLock.js'

const period = z.string().datetime()
const entrySchema = z.object({
  orgId: z.string().optional(),
  attempts: z.array(z.number()).default([]),
  lastAttemptAt: z.number().optional(),
  nextPollAt: z.number().optional(),
  retryAt: z.number().optional(),
  refreshingUntil: z.number().optional(),
  job: z.object({ id: z.string(), periodStart: period, windowEnd: period }).optional(),
  snapshot: z.object({ used: z.number().nonnegative(), asOf: period, periodStart: period, windowEnd: period,
    basis: z.literal('compute').optional() }).optional(),
  failure: z.string().optional(),
  policy: z.object({ month: period, exhausted: z.boolean(), activated: z.boolean(),
    replacement: z.string().optional(), creditRefusedUntil: z.number().optional(),
    creditProbeRunId: z.string().optional() }).optional(),
}).strict()
const cacheSchema = z.record(z.string(), entrySchema)
export type CircleCreditState = z.infer<typeof entrySchema>
type CacheState = z.infer<typeof cacheSchema>

export function circleCreditKey(owner: string, circleAccountId = 'default'): string {
  return JSON.stringify([circleAccountId, owner.toLowerCase()])
}

export function circleMonthStart(at: number): string {
  const date = new Date(at)
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString()
}

/** Only nonsecret usage/export state is persisted. The directory lock also serializes separate API readers. */
export class CircleCreditCache {
  private state: CacheState = {}
  private pending: Promise<unknown> = Promise.resolve()

  constructor(private readonly path?: string) {}

  transaction<T>(work: (state: CacheState) => T | Promise<T>): Promise<T> {
    const operation = this.pending.then(() => this.locked(work))
    // A failed operation is returned to its caller; subsequent reads must still be able to acquire the lock.
    this.pending = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async locked<T>(work: (state: CacheState) => T | Promise<T>): Promise<T> {
    if (!this.path) return work(this.state)
    const path = this.path
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    return (await withHostCiRunLock(dirname(path), async () => {
      let state: CacheState
      try { state = cacheSchema.parse(JSON.parse(await readFile(path, 'utf8'))) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        state = {}
      }
      const previous = structuredClone(state)
      const result = await work(state)
      if (isDeepStrictEqual(previous, state)) return result
      const temporary = `${path}.${randomUUID()}.pending`
      try {
        await writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 })
        await rename(temporary, path)
      } finally { await rm(temporary, { force: true }) }
      return result
    }))!
  }
}
