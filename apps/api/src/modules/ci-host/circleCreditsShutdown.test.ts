import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'
import { CircleCreditCache, circleCreditKey, circleMonthStart } from './circleCreditCache.js'
import { CircleCreditUsage } from './circleCredits.js'
import { CloudHttp } from './cloudHttp.js'
import type { HostCiPorts } from './runner.js'

it.each(['poll request', 'poll sleep', 'download', 'download body'] as const)(
  'preserves a pending export when shutdown cancels a %s', async phase => {
    const parent = process.env.FOREMAN_CODE_TEST_ROOT ?? join(homedir(), '.cache', 'foreman-tmp')
    await mkdir(parent, { recursive: true })
    const directory = await mkdtemp(join(parent, 'circle-usage-'))
    const path = join(directory, 'usage.json')
    const cache = new CircleCreditCache(path)
    let now = Date.parse('2026-10-17T12:00:00Z')
    const job = { id: 'job', periodStart: circleMonthStart(now), windowEnd: new Date(now).toISOString() }
    const snapshot = { basis: 'compute' as const, used: 100, asOf: job.windowEnd,
      periodStart: job.periodStart, windowEnd: job.windowEnd }
    await cache.transaction(states => {
      states[circleCreditKey('acme')] = { orgId: 'org', attempts: [now], lastAttemptAt: now, job, snapshot }
    })
    const entered = deferred()
    const release = deferred()
    let activeSignal: AbortSignal | undefined
    let resuming = false
    let posts = 0
    const downloads: string[] = []
    const waitForRelease = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
      const abort = () => { reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
      void release.promise.then(() => {
        signal.removeEventListener('abort', abort)
        resolve()
      })
    })
    const ports: HostCiPorts = {
      run: async () => { throw new Error('No CLI request expected') },
      now: () => new Date(now), cpus: 4, memoryBytes: 2 ** 30,
    }
    const http = new CloudHttp(ports, 'circleci', {
      circleToken: async () => 'fixture-token',
      fetch: async (input, init) => {
        const url = new URL(String(input))
        const signal = init?.signal
        if (!signal) throw new Error('HTTP request must have a cancellation signal')
        if (init?.method === 'POST') {
          posts++
          return Response.json({ usage_export_job_id: 'unexpected-job' })
        }
        if (url.pathname.endsWith('/job')) {
          if (!resuming && (phase === 'poll request' || phase === 'poll sleep')) {
            activeSignal = signal
            entered.resolve()
            if (phase === 'poll sleep') return Response.json({ state: 'processing' })
            await waitForRelease(signal)
          }
          return Response.json({ state: 'completed', download_urls: [
            'https://signed.example/first', 'https://signed.example/second',
          ] })
        }
        downloads.push(url.pathname)
        if (!resuming && (phase === 'download' || phase === 'download body')) {
          activeSignal = signal
          entered.resolve()
          if (phase === 'download') await waitForRelease(signal)
          else return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              const abort = () => { controller.error(signal.reason) }
              signal.addEventListener('abort', abort, { once: true })
              void release.promise.then(() => {
                signal.removeEventListener('abort', abort)
                if (signal.aborted) return
                controller.enqueue(new TextEncoder().encode('COMPUTE_CREDITS\n1000\n'))
                controller.close()
              })
            },
          }))
        }
        return new Response('COMPUTE_CREDITS\n1000\n')
      },
    })
    const create = () => new CircleCreditUsage(http, {
      allowance: async () => ({ defaultMonthlyCredits: 400_000, accounts: {} }),
      primaryOwner: async () => 'acme',
    }, { cache: new CircleCreditCache(path), now: () => now })
    const usage = create()
    let restarted: CircleCreditUsage | undefined
    let closing: Promise<void> | undefined
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      expect((await usage.reading('acme')).credits?.used).toBe(100)
      await entered.promise
      let closed = false
      closing = usage.close().then(() => { closed = true })
      await new Promise<void>(resolve => { setImmediate(resolve) })
      expect(closed).toBe(false)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(activeSignal?.aborted).toBe(true)
      vi.useRealTimers()
      await vi.waitFor(() => { expect(closed).toBe(true) })
      await closing
      const saved = await new CircleCreditCache(path).transaction(states => states[circleCreditKey('acme')])
      expect(saved).toEqual({ orgId: 'org', attempts: [Date.parse(job.windowEnd)],
        lastAttemptAt: Date.parse(job.windowEnd), job, snapshot, nextPollAt: Date.parse(job.windowEnd) + 6_000 })
      expect(downloads).toHaveLength(phase.startsWith('download') ? 1 : 0)
      resuming = true
      now += 6_000
      restarted = create()
      await restarted.reading('acme')
      await restarted.close()
      const resumed = await new CircleCreditCache(path).transaction(states => states[circleCreditKey('acme')])
      expect(resumed?.snapshot?.used).toBe(2000)
      expect(resumed?.job).toBeUndefined()
      expect(resumed?.refreshingUntil).toBeUndefined()
      expect(posts).toBe(0)
    } finally {
      resuming = true
      now += 6_000
      release.resolve()
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(6_000)
      vi.useRealTimers()
      await (closing ?? usage.close())
      await restarted?.close()
      await rm(directory, { recursive: true })
    }
  },
)
