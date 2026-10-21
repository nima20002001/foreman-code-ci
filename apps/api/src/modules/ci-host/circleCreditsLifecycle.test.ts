import type pg from 'pg'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { CircleCreditCache, circleCreditKey } from './circleCreditCache.js'
import { CircleCreditUsage } from './circleCredits.js'
import { CloudHttp } from './cloudHttp.js'
import type { HostCiPorts } from './runner.js'
import { HostCiService, type CiCommits, type HostCiEndpoint } from './service.js'

it('waits for a background usage download and its persisted state before CI shutdown completes', async () => {
  const parent = process.env.FOREMAN_CODE_TEST_ROOT ?? join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'circle-usage-'))
  const cache = new CircleCreditCache(join(directory, 'usage.json'))
  let release!: () => void
  let downloading!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { downloading = resolve })
  const ports: HostCiPorts = {
    run: async () => ({ code: 1, stdout: '', stderr: '' }),
    now: () => new Date(), cpus: 4, memoryBytes: 2 ** 30,
  }
  const http = new CloudHttp(ports, 'circleci', {
    circleToken: async () => 'fixture-token',
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('collaborations')) return Response.json([{ id: 'org', name: 'acme' }])
      if (init?.method === 'POST') return Response.json({ usage_export_job_id: 'job' })
      if (path.endsWith('/job')) {
        return Response.json({ state: 'completed', download_urls: ['https://signed.example/usage'] })
      }
      downloading()
      await blocked
      return new Response('COMPUTE_CREDITS\n380000\n')
    },
  })
  const usage = new CircleCreditUsage(http, {
    allowance: async () => ({ defaultMonthlyCredits: 400_000, accounts: {} }),
    primaryOwner: async () => 'acme',
  }, { cache })
  const pool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool
  const endpoint: HostCiEndpoint = {
    computers: async () => [],
    request: async () => { throw new Error('No executor request expected') },
  }
  const ci = new HostCiService(pool, new PostgresCommandCoordinator(pool), {
    resolve: async () => { throw new Error('No authorization request expected') },
  }, {} as CiCommits, endpoint, undefined, { circleCredits: usage })
  let closing: Promise<void> | undefined
  try {
    expect((await usage.reading('acme')).credits).toBeNull()
    await entered
    let closed = false
    closing = ci.close().then(() => { closed = true })
    // The download is held at the HTTP boundary while shutdown has a turn to complete.
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(closed).toBe(false)
    release()
    await closing
    const persisted = await new CircleCreditCache(join(directory, 'usage.json')).transaction(states =>
      states[circleCreditKey('acme')])
    expect(persisted?.snapshot).toMatchObject({ used: 380_000 })
    expect(persisted?.job).toBeUndefined()
    expect(persisted?.refreshingUntil).toBeUndefined()
  } finally {
    release()
    await (closing ?? ci.close())
    // Also drain the old implementation when the shutdown assertion fails.
    await vi.waitFor(async () => {
      const state = await cache.transaction(states => states[circleCreditKey('acme')])
      expect(state?.snapshot?.used).toBe(380_000)
      expect(state?.refreshingUntil).toBeUndefined()
    })
    await rm(directory, { recursive: true })
  }
})
