import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, open, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'
import { HostCiRunner, type HostCiPorts } from './runner.js'

const maintenance = vi.hoisted(() => ({ scan: null as null | (() => Promise<void>),
  sharedRemoval: null as null | (() => Promise<void>), reportRead: null as null | (() => Promise<void>) }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]).endsWith('/test-results.json')) await maintenance.reportRead?.()
      return actual.readFile(...args)
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      if (String(args[0]).endsWith('/cache')) await maintenance.scan?.()
      return actual.readdir(...args)
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (String(args[0]).endsWith('/vitest-cache')) await maintenance.sharedRemoval?.()
      return actual.rm(...args)
    },
  }
})

const roots: string[] = []
const runners: HostCiRunner[] = []
afterEach(async () => {
  maintenance.scan = null
  maintenance.sharedRemoval = null
  maintenance.reportRead = null
  await Promise.all(runners.splice(0).map(runner => runner.beginDrain()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'ci-cleanup-'))
  roots.push(root)
  let now = new Date('2026-10-14T00:00:00Z')
  const ports: HostCiPorts = { cpus: 8, memoryBytes: 16 * 2 ** 30,
    now: () => now,
    run: async () => ({ code: 0, stdout: 'active', stderr: '' }) }
  const runner = new HostCiRunner(root, ports, {})
  runners.push(runner)
  return { root, runner, advance: (milliseconds: number) => { now = new Date(now.getTime() + milliseconds) } }
}

async function run(root: string, options: { state?: string; cleaned?: boolean; repository?: string } = {}) {
  const runId = randomUUID()
  const directory = join(root, 'runs', runId)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'meta.json'), JSON.stringify({ runId,
    repository: options.repository ?? 'fixture/site', commit: 'a'.repeat(40), suite: 'lint',
    state: options.state ?? 'passed', cleaned: options.cleaned ?? false, partition: null,
    startedAt: '2026-10-01T00:00:00Z', finishedAt: '2026-10-01T00:01:00Z', exitCode: 0, message: null }))
  await writeFile(join(directory, 'log'), 'retained log')
  for (const name of ['src', 'tmp', 'vitest-cache']) {
    await mkdir(join(directory, name), { recursive: true })
    await writeFile(join(directory, name, 'contents'), 'fixture bytes')
  }
  return { runId, directory }
}

it.each([false, true])('removes settled per-run caches on read, including cleaned=%s', async cleaned => {
  const f = await fixture()
  const ticket = await run(f.root, { cleaned })
  await expect(f.runner.handle({ operation: 'read', runId: ticket.runId, afterOffset: 0, maxBytes: 100 }))
    .resolves.toMatchObject({ run: { state: 'passed' }, text: 'retained log' })
  await expect(access(join(ticket.directory, 'vitest-cache'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(ticket.directory, 'log'), 'utf8')).resolves.toBe('retained log')
})

it('retains active per-run and shared caches, then retires the shared cache after the run settles', async () => {
  const f = await fixture()
  const ticket = await run(f.root, { state: 'running' })
  const shared = join(f.root, 'vitest-cache')
  await mkdir(shared)
  await writeFile(join(shared, 'contents'), 'shared bytes')
  await f.runner.handle({ operation: 'status' })
  await expect(readFile(join(shared, 'contents'), 'utf8')).resolves.toBe('shared bytes')
  await expect(access(join(ticket.directory, 'vitest-cache'))).resolves.toBeUndefined()
  await writeFile(join(ticket.directory, 'exit'), '0\n')
  await f.runner.handle({ operation: 'status' })
  await vi.waitFor(async () => {
    await expect(access(shared)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

it('deletes only DB-selected terminal directories and preserves active and unknown runs', async () => {
  const f = await fixture()
  const terminal = await run(f.root)
  const active = await run(f.root, { state: 'running' })
  const unknown = await run(f.root)
  const reply = await f.runner.handle({ operation: 'status', cleanupRunIds: [terminal.runId, active.runId] })
  expect(reply).toMatchObject({ operation: 'status', removedRunIds: [terminal.runId] })
  await expect(access(terminal.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(access(active.directory)).resolves.toBeUndefined()
  await expect(access(unknown.directory)).resolves.toBeUndefined()
  await expect(f.runner.handle({ operation: 'status', cleanupRunIds: [terminal.runId] }))
    .resolves.toMatchObject({ operation: 'status', removedRunIds: [terminal.runId] })
})

async function sparseFile(path: string, size: number, usedAt: string) {
  await mkdir(join(path, '..'), { recursive: true })
  const handle = await open(path, 'w')
  try { await handle.truncate(size) } finally { await handle.close() }
  await utimes(path, new Date(usedAt), new Date(usedAt))
}

it('evicts the least recently used cache entries above 3 GB while preserving active repositories', async () => {
  const f = await fixture()
  await run(f.root, { state: 'running', repository: 'fixture/busy' })
  const oldest = join(f.root, 'cache/fixture/idle/pnpm-store/old')
  const newest = join(f.root, 'cache/fixture/idle/pnpm-store/new')
  const busy = join(f.root, 'cache/fixture/busy/pnpm-store/held')
  await sparseFile(oldest, 2 ** 30, '2026-10-01T00:00:00Z')
  await sparseFile(newest, 2 ** 30, '2026-10-03T00:00:00Z')
  await sparseFile(busy, 2 * 2 ** 30, '2026-09-01T00:00:00Z')
  await f.runner.handle({ operation: 'status' })
  await vi.waitFor(async () => {
    await expect(access(oldest)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  await expect(access(newest)).resolves.toBeUndefined()
  await expect(access(busy)).resolves.toBeUndefined()
})

it.each(['scan', 'sharedRemoval'] as const)('answers status without waiting for slow cache maintenance: %s', async operation => {
  const f = await fixture()
  const entered = deferred()
  const released = deferred()
  const finished = deferred()
  let calls = 0
  maintenance[operation] = async () => {
    calls++
    entered.resolve()
    await released.promise
    finished.resolve()
  }
  const pending = f.runner.handle({ operation: 'status' })
  await entered.promise
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([pending,
      new Promise<'blocked'>(resolve => { timeout = setTimeout(() => resolve('blocked'), 1000) })])
    expect(result).toMatchObject({ operation: 'status', ready: true })
    await expect(f.runner.handle({ operation: 'status' })).resolves.toMatchObject({ operation: 'status', ready: true })
    expect(calls).toBe(1)
  } finally {
    clearTimeout(timeout)
    released.resolve()
    await pending
    await finished.promise
  }
})

it('preserves a terminal directory while its report is being read, then removes it after the read', async () => {
  const f = await fixture()
  const ticket = await run(f.root, { cleaned: true })
  const results = { summary: { passed: 1, failed: 0, skipped: 0 }, truncated: false,
    files: [{ file: 'example.test.ts', status: 'passed', durationMs: 1,
      tests: [{ name: 'returns a result', status: 'passed', durationMs: 1 }] }] }
  await writeFile(join(ticket.directory, 'test-results.json'), JSON.stringify(results))
  const entered = deferred()
  const released = deferred()
  maintenance.reportRead = async () => {
    entered.resolve()
    await released.promise
  }
  const reading = f.runner.handle({ operation: 'read', runId: ticket.runId, afterOffset: 0, maxBytes: 100,
    testResults: true })
  try {
    await entered.promise
    await expect(f.runner.handle({ operation: 'status', cleanupRunIds: [ticket.runId] }))
      .resolves.toMatchObject({ removedRunIds: [] })
    await expect(access(ticket.directory)).resolves.toBeUndefined()
  } finally {
    released.resolve()
    await reading
  }
  await expect(reading).resolves.toMatchObject({ text: 'retained log', testResults: results })
  await expect(f.runner.handle({ operation: 'status', cleanupRunIds: [ticket.runId] }))
    .resolves.toMatchObject({ removedRunIds: [ticket.runId] })
  await expect(access(ticket.directory)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('preserves a repository that becomes active while a background cache scan is paused', async () => {
  const f = await fixture()
  const cache = join(f.root, 'cache/fixture/busy/pnpm-store/held')
  await sparseFile(cache, 4 * 2 ** 30, '2026-10-01T00:00:00Z')
  const entered = deferred()
  const released = deferred()
  maintenance.scan = async () => {
    entered.resolve()
    await released.promise
  }
  const pending = f.runner.handle({ operation: 'status' })
  try {
    await entered.promise
    const active = await run(f.root, { state: 'running', repository: 'fixture/busy' })
    await expect(f.runner.handle({ operation: 'read', runId: active.runId, afterOffset: 0, maxBytes: 100 }))
      .resolves.toMatchObject({ run: { state: 'running' } })
  } finally {
    released.resolve()
    await pending
    await f.runner.beginDrain()
  }
  await expect(access(cache)).resolves.toBeUndefined()
})


it('does not rewalk unchanged cache trees on cleanup passes until the hourly refresh', async () => {
  const f = await fixture()
  const cached = join(f.root, 'cache/fixture/site/pnpm-store/entry')
  await sparseFile(cached, 16, '2026-10-01T00:00:00Z')
  let scans = 0
  maintenance.scan = async () => { scans++ }
  const cleanup = async () => {
    await f.runner.handle({ operation: 'status' })
    await f.runner.beginDrain()
    f.runner.resumeAdmissions()
  }
  await cleanup()
  expect(scans).toBe(1)
  for (let pass = 0; pass < 11; pass++) {
    f.advance(5 * 60_000)
    await cleanup()
  }
  expect(scans).toBe(1)
  await expect(access(cached)).resolves.toBeUndefined()
  f.advance(5 * 60_000)
  await cleanup()
  expect(scans).toBe(2)
})

it('rescans a cache on the next five-minute pass after its writer settles and preserves oldest-first eviction', async () => {
  const f = await fixture()
  const ticket = await run(f.root, { state: 'running' })
  const oldest = join(f.root, 'cache/fixture/site/pnpm-store/old')
  const newest = join(f.root, 'cache/fixture/site/pnpm-store/new')
  await sparseFile(oldest, 2 ** 30, '2026-10-01T00:00:00Z')
  await sparseFile(newest, 2 * 2 ** 30, '2026-10-03T00:00:00Z')
  await f.runner.handle({ operation: 'status' })
  await f.runner.beginDrain()
  f.runner.resumeAdmissions()
  await expect(access(oldest)).resolves.toBeUndefined()
  await sparseFile(newest, 3 * 2 ** 30, '2026-10-03T00:00:00Z')
  await writeFile(join(ticket.directory, 'exit'), '0\n')
  await f.runner.handle({ operation: 'status' })
  f.advance(5 * 60_000)
  await f.runner.handle({ operation: 'status' })
  await f.runner.beginDrain()
  await expect(access(oldest)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(access(newest)).resolves.toBeUndefined()
})


it('confirms removed directories through repeated cleanup and a restarted runner, preserving incomplete metadata', async () => {
  const f = await fixture()
  const terminal = await run(f.root)
  const incomplete = await run(f.root)
  await rm(join(incomplete.directory, 'meta.json'))
  const request = { operation: 'status', cleanupRunIds: [terminal.runId, incomplete.runId] }
  await expect(f.runner.handle(request)).resolves.toMatchObject({ removedRunIds: [terminal.runId] })
  await expect(f.runner.handle(request)).resolves.toMatchObject({ removedRunIds: [terminal.runId] })
  const restarted = new HostCiRunner(f.root, { cpus: 8, memoryBytes: 16 * 2 ** 30,
    now: () => new Date('2026-10-14T00:00:00Z'),
    run: async () => ({ code: 0, stdout: 'active', stderr: '' }) }, {})
  runners.push(restarted)
  await expect(restarted.handle(request)).resolves.toMatchObject({ removedRunIds: [terminal.runId] })
  await expect(readFile(join(incomplete.directory, 'log'), 'utf8')).resolves.toBe('retained log')
})
