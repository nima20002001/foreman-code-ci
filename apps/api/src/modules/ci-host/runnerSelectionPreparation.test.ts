import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { HostCiRunner, systemHostCiPorts, type HostCiPorts } from './runner.js'

async function selectionFixture(baseCommit: boolean) {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'ci-selection-preparation-'))
  const origin = join(root, 'origin')
  const environment = gitFixtureEnvironment()
  const system = systemHostCiPorts(environment)
  const git = async (args: string[], cwd = origin) => {
    const result = await system.run('git', args, { cwd, env: environment })
    if (result.code !== 0) throw new Error(`Fixture git ${args[0]} failed: ${result.stderr}`)
    return result.stdout.trim()
  }
  await mkdir(join(origin, 'scripts'), { recursive: true })
  await writeFile(join(origin, 'package.json'), JSON.stringify({ scripts: { lint: 'true' } }))
  await writeFile(join(origin, 'scripts/ci-affected.mjs'),
    "export function selectAffectedFiles() { return { scope: 'full', files: [], reason: 'fixture' } }")
  for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['commit', '-qm', 'fixture']]) await git(args)
  const base = await git(['rev-parse', 'HEAD'])
  await git(['checkout', '-qb', 'feature'])
  await writeFile(join(origin, 'feature.txt'), 'changed')
  await git(['add', '.'])
  await git(['commit', '-qm', 'feature'])
  const commit = await git(['rev-parse', 'HEAD'])
  const entered = deferred()
  const release = deferred()
  const aborted = deferred()
  const lock = join(root, 'runner/git/fixture/site/.git/shallow.lock')
  let intercept = true
  const ports: HostCiPorts = { cpus: 16, memoryBytes: 16 * 2 ** 30, now: () => new Date(),
    run: async (file, args, options = {}) => {
      if (file === 'git') {
        if (baseCommit && args[0] === 'cat-file') return { code: 1, stdout: '', stderr: 'not fetched' }
        const selectionFetch = args[0] === 'fetch' || args.some(arg => arg.startsWith('+refs/heads/'))
        if (intercept && selectionFetch) {
          intercept = false
          await writeFile(lock, 'live selection fetch', { flag: 'wx' })
          const onAbort = () => { aborted.resolve(); release.resolve() }
          options.signal?.addEventListener('abort', onAbort, { once: true })
          entered.resolve()
          await release.promise
          options.signal?.removeEventListener('abort', onAbort)
          // A fetch owns this lock until it exits, including when cancellation kills it.
          if (!existsSync(lock)) return { code: 1, stdout: '', stderr: 'live fetch lock was deleted' }
          await rm(lock)
        }
        const local = args.map(arg => arg === 'https://github.com/fixture/site.git' ? origin : arg)
        return system.run(file, local, { ...options, env: environment })
      }
      if (file === 'node') return system.run(file, args, options)
      const stdout = file === 'systemctl' ? args.filter(arg => arg.endsWith('.service')).map(unit =>
        `Id=${unit}\nLoadState=loaded\nActiveState=active\n`).join('\n') : ''
      return { code: 0, stdout, stderr: '' }
    } }
  const runner = new HostCiRunner(join(root, 'runner'), ports, environment)
  const request = { operation: 'start', repository: 'fixture/site', commit, suite: 'lint',
    scope: 'affected', ...(baseCommit ? { baseCommit: base } : {}) }
  const read = (runId: string) => runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1000 })
  return { root, runner, request, ports, environment, entered, release, aborted, lock, read }
}

it.each([false, true])('serializes selection fetches with another preparation (reopened runner: %s)', async reopened => {
  const f = await selectionFixture(false)
  const other = reopened ? new HostCiRunner(join(f.root, 'runner'), f.ports, f.environment) : f.runner
  const first = randomUUID()
  const second = randomUUID()
  let starting: ReturnType<HostCiRunner['handle']> | undefined
  try {
    await f.runner.handle({ ...f.request, runId: first })
    await f.entered.promise
    starting = other.handle({ ...f.request, runId: second, scope: 'full' })
    const completed = await Promise.race([
      starting.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 500)),
    ])
    expect(completed, 'another preparation must wait for the selection fetch').toBe(false)
    await expect(readFile(f.lock, 'utf8')).resolves.toBe('live selection fetch')
    f.release.resolve()
    await starting
    for (const runId of [first, second]) {
      await vi.waitFor(async () => expect(await f.read(runId)).toMatchObject({ run: { state: 'running' } }))
    }
  } finally {
    f.release.resolve()
    await starting
    await Promise.all([f.runner.beginDrain(), other.beginDrain()])
    await rm(f.root, { recursive: true, force: true })
  }
})

it.each([false, true])('Stop interrupts a selection fetch (explicit base: %s)', async explicitBase => {
  const f = await selectionFixture(explicitBase)
  const runId = randomUUID()
  let canceling: ReturnType<HostCiRunner['handle']> | undefined
  try {
    await f.runner.handle({ ...f.request, runId })
    await f.entered.promise
    canceling = f.runner.handle({ operation: 'cancel', runId })
    const interrupted = await Promise.race([
      f.aborted.promise.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 500)),
    ])
    expect(interrupted, 'Stop must abort the fetch before it finishes on its own').toBe(true)
    await expect(canceling).resolves.toMatchObject({ run: { state: 'canceled' } })
    await expect(f.read(runId)).resolves.toMatchObject({ run: { state: 'canceled' } })
  } finally {
    f.release.resolve()
    await canceling
    await f.runner.beginDrain()
    await rm(f.root, { recursive: true, force: true })
  }
})

it.each([false, true])('Stop releases a queued preparation while selection still holds the repository (reopened runner: %s)',
  async reopened => {
    const f = await selectionFixture(false)
    const other = reopened ? new HostCiRunner(join(f.root, 'runner'), f.ports, f.environment) : f.runner
    const first = randomUUID()
    const second = randomUUID()
    const third = randomUUID()
    let starting: ReturnType<HostCiRunner['handle']> | undefined
    let canceling: ReturnType<HostCiRunner['handle']> | undefined
    let following: ReturnType<HostCiRunner['handle']> | undefined
    const completedBeforeRelease = (pending: Promise<unknown>) => Promise.race([
      pending.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 500)),
    ])
    try {
      await f.runner.handle({ ...f.request, runId: first })
      await f.entered.promise
      starting = other.handle({ ...f.request, runId: second, scope: 'full' })
      await vi.waitFor(async () => expect(await other.status()).toMatchObject({ slotsUsed: 2 }))
      expect(await completedBeforeRelease(starting), 'the second ticket must be waiting for repository access').toBe(false)

      canceling = other.handle({ operation: 'cancel', runId: second })
      expect(await completedBeforeRelease(Promise.all([canceling, starting])),
        'Stop must settle preparation before the unrelated selection fetch exits').toBe(true)
      await expect(starting).resolves.toMatchObject({ run: { state: 'canceled' } })
      await expect(f.read(second)).resolves.toMatchObject({ run: { state: 'canceled' } })
      await expect(other.status()).resolves.toMatchObject({ slotsUsed: 1,
        runs: expect.arrayContaining([expect.objectContaining({ runId: first, state: 'starting' })]) })
      await expect(readFile(f.lock, 'utf8')).resolves.toBe('live selection fetch')

      following = other.handle({ ...f.request, runId: third, scope: 'full' })
      expect(await completedBeforeRelease(following), 'the next ticket must still wait for the live fetch').toBe(false)
      await expect(readFile(f.lock, 'utf8')).resolves.toBe('live selection fetch')
      f.release.resolve()
      await following
      for (const runId of [first, third]) {
        await vi.waitFor(async () => expect(await f.read(runId)).toMatchObject({ run: { state: 'running' } }))
      }
      await expect(f.read(second)).resolves.toMatchObject({ run: { state: 'canceled' } })
    } finally {
      f.release.resolve()
      await Promise.all([starting, canceling, following])
      await Promise.all([f.runner.beginDrain(), other.beginDrain()])
      await rm(f.root, { recursive: true, force: true })
    }
  })
