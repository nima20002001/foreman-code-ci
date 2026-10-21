import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { HostCiRunner, systemHostCiPorts, type HostCiPorts } from './runner.js'

it('starts real CI after a canceled warmup fetch leaves a stale shallow lock', async () => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'ci-stale-locks-'))
  const origin = join(root, 'origin')
  const environment = gitFixtureEnvironment()
  const system = systemHostCiPorts(environment)
  const git = async (args: string[], cwd: string) => {
    const result = await system.run('git', args, { cwd, env: environment })
    if (result.code !== 0) throw new Error(`Fixture git ${args[0]} failed: ${result.stderr}`)
    return result.stdout
  }
  await mkdir(origin)
  await writeFile(join(origin, 'package.json'), JSON.stringify({ scripts: { lint: 'true' } }))
  for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['commit', '-qm', 'fixture']]) {
    await git(args, origin)
  }
  const commit = (await git(['rev-parse', 'HEAD'], origin)).trim()
  const fetchEntered = deferred()
  const launches: string[] = []
  let interrupted = false
  const ports: HostCiPorts = {
    cpus: 16, memoryBytes: 16 * 2 ** 30, now: () => new Date(),
    run: async (file, args, options = {}) => {
      if (file === 'git') {
        const local = args.map(arg => arg === 'https://github.com/fixture/site.git' ? origin : arg)
        if (!interrupted && args.includes('fetch')) {
          interrupted = true
          await writeFile(join(options.cwd!, '.git', 'shallow.lock'), '')
          fetchEntered.resolve()
          await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => resolve(), { once: true }))
          return { code: 1, stdout: '', stderr: '' }
        }
        return system.run(file, local, { ...options, env: environment })
      }
      if (file === 'systemd-run') {
        launches.push(args.find(arg => arg.startsWith('--unit='))!.slice('--unit='.length))
      }
      if (file === 'systemctl') {
        const stdout = args.filter(arg => arg.endsWith('.service')).map(unit =>
          `Id=${unit}\nLoadState=loaded\nActiveState=active\n`).join('\n')
        return { code: 0, stdout, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  const runner = new HostCiRunner(join(root, 'runner'), ports, environment)
  const request = { operation: 'start', repository: 'fixture/site', commit, scope: 'full' }
  const warmup = runner.handle({ ...request, runId: randomUUID(), suite: 'install', warmup: true })
  let real: ReturnType<HostCiRunner['handle']> | undefined
  try {
    await fetchEntered.promise
    const runId = randomUUID()
    real = runner.handle({ ...request, runId, suite: 'lint' })
    await real
    await expect(warmup).resolves.toMatchObject({ run: { state: 'canceled' } })
    const read = () => runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 10_000 })
    await vi.waitFor(async () => {
      await expect(read()).resolves.toMatchObject({ run: { state: 'running', message: null } })
    })
    expect(launches).toEqual([`foreman-ci-${runId}`])
  } finally {
    await Promise.allSettled([warmup, real])
    await runner.beginDrain()
    await rm(root, { recursive: true, force: true })
  }
})

it('preserves a running checkout index lock and locks outside shared clone preparation', async () => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'ci-live-worktree-lock-'))
  const origin = join(root, 'origin')
  const environment = gitFixtureEnvironment()
  const system = systemHostCiPorts(environment)
  const git = async (args: string[], cwd: string) => {
    const result = await system.run('git', args, { cwd, env: environment })
    if (result.code !== 0) throw new Error(`Fixture git ${args[0]} failed: ${result.stderr}`)
    return result.stdout.trim()
  }
  await mkdir(origin)
  await writeFile(join(origin, 'package.json'), JSON.stringify({ scripts: { lint: 'true' } }))
  for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['commit', '-qm', 'fixture']]) {
    await git(args, origin)
  }
  const commit = await git(['rev-parse', 'HEAD'], origin)
  const sources: string[] = []
  const ports: HostCiPorts = {
    cpus: 16, memoryBytes: 16 * 2 ** 30, now: () => new Date(),
    run: async (file, args, options = {}) => {
      if (file === 'git') {
        const local = args.map(arg => arg === 'https://github.com/fixture/site.git' ? origin : arg)
        return system.run(file, local, { ...options, env: environment })
      }
      if (file === 'systemd-run') {
        sources.push(args.find(arg => arg.startsWith('--working-directory='))!.slice('--working-directory='.length))
      }
      const stdout = file === 'systemctl' ? args.filter(arg => arg.endsWith('.service')).map(unit =>
        `Id=${unit}\nLoadState=loaded\nActiveState=active\n`).join('\n') : ''
      return { code: 0, stdout, stderr: '' }
    },
  }
  const runner = new HostCiRunner(join(root, 'runner'), ports, environment)
  const request = { operation: 'start', repository: 'fixture/site', commit, scope: 'full', suite: 'lint' }
  const firstRunId = randomUUID()
  const read = (runId: string) => runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 10_000 })
  try {
    await runner.handle({ ...request, runId: firstRunId })
    await vi.waitFor(async () => {
      await expect(read(firstRunId)).resolves.toMatchObject({ run: { state: 'running' } })
    })
    const indexLock = await git(['rev-parse', '--path-format=absolute', '--git-path', 'index.lock'], sources[0]!)
    const gitDirectory = join(root, 'runner', 'git', 'fixture', 'site', '.git')
    const protectedLocks = [indexLock, join(gitDirectory, 'objects', 'fixture.lock'), join(gitDirectory, 'fixture.lock')]
    for (const lock of protectedLocks) await writeFile(lock, 'owned by a running suite', { flag: 'wx' })
    const secondRunId = randomUUID()
    await runner.handle({ ...request, runId: secondRunId })
    await vi.waitFor(async () => {
      await expect(read(secondRunId)).resolves.toMatchObject({ run: { state: 'running' } })
    })
    await expect(read(firstRunId)).resolves.toMatchObject({ run: { state: 'running' } })
    for (const lock of protectedLocks) {
      await expect(readFile(lock, 'utf8')).resolves.toBe('owned by a running suite')
    }
    expect(sources).toHaveLength(2)
  } finally {
    await runner.beginDrain()
    await rm(root, { recursive: true, force: true })
  }
})
