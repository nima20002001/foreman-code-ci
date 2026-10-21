import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { deferred, type Deferred } from '../../../test/helpers/deferred.js'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { HostCiRunner, systemHostCiPorts, type HostCiPorts } from './runner.js'
import { sweepHostCiCache } from './cacheCleanup.js'

const roots: string[] = []
const completions: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(completions.splice(0).map(close => close()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function computer({ prepareDatabase = false, beforeLaunch, afterRunning, expireUnit = false,
  expireInstallLock = false, failPrefetch = false }: {
  prepareDatabase?: boolean
  beforeLaunch?: () => Promise<void>
  afterRunning?: () => Promise<void>
  expireUnit?: boolean
  expireInstallLock?: boolean
  failPrefetch?: boolean
} = {}) {
  const base = process.env.FOREMAN_CODE_TEST_ROOT ?? process.env.TMPDIR
    ?? join(homedir(), '.cache/foreman-code/tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'warm-host-'))
  roots.push(root)
  const origin = join(root, 'origin')
  const bin = join(root, 'bin')
  const calls = join(root, 'calls.jsonl')
  const offlineFailure = join(root, 'offline-failure')
  const prefetchFailure = join(root, 'prefetch-failure')
  await mkdir(origin)
  await mkdir(bin)
  if (failPrefetch) await writeFile(prefetchFailure, 'fetch failed')
  if (expireInstallLock) {
    await writeFile(join(bin, 'flock'), '#!/bin/sh\n[ "$1" = "-s" ] && exit 0\nexit 1\n', { mode: 0o700 })
  }
  await writeFile(join(origin, 'package.json'), JSON.stringify({ scripts: { lint: 'fixture' } }))
  await writeFile(join(origin, 'pnpm-lock.yaml'), 'fixture-lock-one')
  if (prepareDatabase) {
    await mkdir(join(origin, 'scripts'))
    await writeFile(join(origin, 'scripts/ci-suite.sh'),
      '#!/bin/bash\ncorepack pnpm db:up\n')
  }
  const environment = gitFixtureEnvironment()
  const git = (...args: string[]) => execFileSync('git', args, { cwd: origin, env: environment, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('commit', '-qm', 'fixture')
  await writeFile(join(bin, 'corepack'), `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n')
if (args[1] === 'db:up') {
  if (!fs.existsSync('node_modules/dependency')) {
    console.error('Database preparation attempted to reinstall unfinished dependencies')
    process.exit(8)
  }
} else if (args[1] === 'install' || args[1] === 'fetch') {
  if (${prepareDatabase}) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
  if (args.includes('--offline') && fs.existsSync(${JSON.stringify(offlineFailure)})) process.exit(7)
  const storeIndex = args.indexOf('--store-dir')
  const store = storeIndex < 0 ? '.fixture-store' : args[storeIndex + 1]
  const metadataIndex = args.indexOf('--cache-dir')
  const metadata = path.join(metadataIndex < 0 ? '.fixture-metadata' : args[metadataIndex + 1], 'release-age')
  const seed = path.join(store, require('node:crypto').createHash('sha256').update(fs.readFileSync('pnpm-lock.yaml')).digest('hex'))
  const deploymentPackage = seed + '-deployment'
  if (args.includes('--offline') && (!fs.existsSync(seed) || !fs.existsSync(metadata))) process.exit(7)
  if (args[1] === 'fetch' && args.includes('--offline') && !fs.existsSync(deploymentPackage)) process.exit(7)
  if (args[1] === 'fetch' && fs.existsSync(${JSON.stringify(prefetchFailure)})) {
    console.error('Full lockfile prefetch failed')
    process.exit(19)
  }
  fs.mkdirSync(store, { recursive: true })
  fs.writeFileSync(seed, 'pristine')
  fs.mkdirSync(path.dirname(metadata), { recursive: true })
  fs.writeFileSync(metadata, 'verified package publication time')
  if (!args.includes('--offline')) fs.rmSync(${JSON.stringify(offlineFailure)}, { force: true })
  if (args[1] === 'fetch') fs.writeFileSync(deploymentPackage, 'available offline')
  else {
    fs.mkdirSync('node_modules', { recursive: true })
    if (!fs.existsSync('node_modules/dependency')) fs.copyFileSync(seed, 'node_modules/dependency')
  }
} else {
  console.log('dependency=' + fs.readFileSync('node_modules/dependency', 'utf8'))
  const metadata = process.env.npm_config_cache_dir
  console.log('metadata=' + (metadata
    ? fs.readFileSync(path.join(metadata, 'release-age'), 'utf8') : 'unavailable'))
  const store = path.join(path.dirname(metadata), 'pnpm-store')
  const deploymentPackage = path.join(store,
    require('node:crypto').createHash('sha256').update(fs.readFileSync('pnpm-lock.yaml')).digest('hex') + '-deployment')
  console.log('production dependency=' + (fs.existsSync(deploymentPackage)
    ? fs.readFileSync(deploymentPackage, 'utf8') : 'unavailable'))
  fs.writeFileSync('node_modules/dependency', 'modified by suite')
}
`, { mode: 0o755 })
  const system = systemHostCiPorts()
  const launched = new Map<string, { cwd: string; done: Promise<unknown> }>()
  const starts = new Map<string, Deferred<void>>()
  const ports: HostCiPorts = { ...system, cpus: 16, memoryBytes: 16 * 2 ** 30,
    availableMemoryBytes: () => 16 * 2 ** 30,
    run: async (file, args, options) => {
      if (file === 'gh') return { code: 0, stdout: '', stderr: '' }
      if (file === 'git' && args.some(value => value.startsWith('https://github.com/'))) {
        return system.run(file, args.map(arg => arg.startsWith('https://') ? origin : arg), options)
      }
      if (file === 'systemd-run') {
        await beforeLaunch?.()
        const cwd = args.find(arg => arg.startsWith('--working-directory='))!.slice('--working-directory='.length)
        const env = Object.fromEntries(args.filter(arg => arg.startsWith('--setenv='))
          .map(arg => arg.slice('--setenv='.length).split(/=(.*)/s).slice(0, 2)))
        const script = args.at(-1)!
        if (expireUnit) {
          starts.get(script)!.resolve()
          launched.set(script, { cwd, done: Promise.resolve() })
          const runtime = args.find(arg => arg.startsWith('--property=RuntimeMaxSec='))
          expect(Number(runtime?.split('=').at(-1))).toBeGreaterThan(0)
          expect(Number(runtime?.split('=').at(-1))).toBeLessThanOrEqual(3 * 60 * 60)
          const stop = args.find(arg => arg.startsWith('--property=ExecStopPost='))
          expect(stop).toBeDefined()
          const done = system.run('/bin/bash', ['-c', stop!.slice('--property=ExecStopPost='.length)],
            { cwd, env: { ...env, SERVICE_RESULT: 'timeout' } })
          launched.set(script, { cwd, done })
          starts.get(script)!.resolve()
          return { code: 0, stdout: '', stderr: '' }
        }
        launched.set(script, { cwd, done: system.run('/bin/bash', [script], { cwd, env }) })
        starts.get(script)!.resolve()
        return { code: 0, stdout: '', stderr: '' }
      }
      if (file === 'systemctl') {
        const stdout = args.filter(arg => arg.endsWith('.service'))
          .map(unit => `Id=${unit}\nLoadState=loaded\nActiveState=active\n`).join('\n')
        return { code: 0, stdout, stderr: '' }
      }
      return system.run(file, args, options)
    } }
  const runner = new HostCiRunner(join(root, 'runner'), ports, { ...environment, PATH: `${bin}:${process.env.PATH}` })
  completions.push(async () => {
    await runner.beginDrain()
    await Promise.all([...launched.values()].map(process => process.done))
  })
  async function run({ warmup = false } = {}) {
    const runId = randomUUID()
    const script = join(root, 'runner/runs', runId, 'run.sh')
    const started = deferred()
    starts.set(script, started)
    await runner.handle({ operation: 'start', runId, repository: 'example/project', commit: git('rev-parse', 'HEAD'),
      suite: warmup ? 'install' : 'lint',
      ...(warmup ? { scope: 'full', warmup: true } : { scope: 'affected', files: [] }) })
    await vi.waitFor(async () => {
      const reply = await runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 })
      if (reply.operation !== 'read' || reply.run.state === 'starting') throw new Error('Run is starting')
    })
    await afterRunning?.()
    await started.promise
    await launched.get(script)!.done
    await vi.waitFor(() => expect(runner.isUpdateIdle()).toBe(true), { timeout: 10_000 })
    return runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 })
  }
  const commands = async () => (await readFile(calls, 'utf8')).trim().split('\n')
    .map(line => JSON.parse(line) as string[])
  const onlinePackageCommands = async () => (await commands()).filter(args =>
    (args[1] === 'install' || args[1] === 'fetch') && !args.includes('--offline'))
  const failOffline = () => writeFile(offlineFailure, 'store unavailable')
  const evictDeploymentPackage = async () => {
    const fetch = (await commands()).find(args => args[1] === 'fetch')!
    const store = fetch[fetch.indexOf('--store-dir') + 1]!
    for (const name of await readdir(store)) {
      if (!name.endsWith('-deployment')) continue
      const packageFile = join(store, name)
      await writeFile(packageFile, Buffer.alloc(2 * 2 ** 20))
      await utimes(packageFile, new Date('2020-01-01'), new Date('2020-01-01'))
    }
    await sweepHostCiCache(join(root, 'runner'), { budgetBytes: 2 ** 20, activeRepositories: () => new Set() })
  }
  const slot = join(root, 'runner/slots/example/project/0/src')
  // A new slot starts without dependencies and installs them from the shared store.
  const removeDependencies = () => rm(join(slot, 'node_modules'), { recursive: true, force: true })
  // A checkout whose git link is broken cannot be reset to another commit.
  const breakCheckout = () => writeFile(join(slot, '.git'), 'gitdir: missing\n')
  return { run, commands, onlinePackageCommands, origin, git, failOffline, removeDependencies, breakCheckout,
    evictDeploymentPackage,
    rejectPrefetch: () => writeFile(prefetchFailure, 'fetch failed'),
    allowPrefetch: () => rm(prefetchFailure),
    readRetained: async () => {
      const retained = new HostCiRunner(join(root, 'runner'), ports, environment)
      try { return await retained.handle({ operation: 'status' }) }
      finally { await retained.beginDrain() }
    }, checkout: (...args: string[]) => execFileSync('git', args, {
    cwd: join(root, 'runner/git/example/project'), env: environment, encoding: 'utf8',
  }).trim() }
}

it('bounds the entire unit and retains a timeout failure after the worker restarts', async () => {
  const fixture = await computer({ expireUnit: true, prepareDatabase: true })
  await expect(fixture.run()).resolves.toMatchObject({ run: {
    state: 'failed', exitCode: 124, message: expect.stringContaining('CI_UNIT_DEADLINE_EXCEEDED'),
  } })
  await expect(fixture.readRetained()).resolves.toMatchObject({ runs: [{
    state: 'failed', exitCode: 124, message: expect.stringContaining('CI_UNIT_DEADLINE_EXCEEDED'),
  }] })
})

it('persists the reason when a shared installation lock cannot be acquired before its deadline', async () => {
  const fixture = await computer({ expireInstallLock: true })
  await expect(fixture.run()).resolves.toMatchObject({ run: {
    state: 'failed', exitCode: 124, message: expect.stringContaining('CI_INSTALL_LOCK_DEADLINE_EXCEEDED'),
  } })
})

it('warms once, installs offline on later jobs, and keeps the store private from suite mutations', async () => {
  const fixture = await computer()
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' }, text: expect.stringContaining('dependency=pristine') })
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' } })
  await fixture.removeDependencies()
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' }, text: expect.stringContaining('dependency=pristine') })
  const installs = (await fixture.commands()).filter(args => args[1] === 'install')
  expect(await fixture.onlinePackageCommands()).toHaveLength(1)
  expect(installs.at(-1)).toEqual(expect.arrayContaining(['--offline', '--frozen-lockfile']))
})

it('allows one online fill for a changed lockfile and then returns to offline installation', async () => {
  const fixture = await computer()
  await fixture.run()
  await writeFile(join(fixture.origin, 'pnpm-lock.yaml'), 'fixture-lock-two')
  fixture.git('add', '.')
  fixture.git('commit', '-qm', 'dependency update')
  await fixture.run()
  await fixture.run()
  const installs = (await fixture.commands()).filter(args => args[1] === 'install')
  expect(await fixture.onlinePackageCommands()).toHaveLength(2)
  expect(installs.at(-1)).toEqual(expect.arrayContaining(['--offline', '--frozen-lockfile']))
})

it('retains release-age metadata for offline installs after slot dependencies are removed', async () => {
  const fixture = await computer()
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' } })
  await fixture.removeDependencies()
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' } })
  expect(await fixture.onlinePackageCommands()).toHaveLength(1)
})

it('makes the installation metadata cache available to commands launched by the suite', async () => {
  const fixture = await computer()
  await expect(fixture.run()).resolves.toMatchObject({
    run: { state: 'passed' }, text: expect.stringContaining('metadata=verified package publication time'),
  })
})

it('prefetches deployment-only packages before suites and keeps later requests offline', async () => {
  const fixture = await computer()
  for (let request = 0; request < 2; request++) {
    await expect(fixture.run()).resolves.toMatchObject({
      run: { state: 'passed' }, text: expect.stringContaining('production dependency=available offline'),
    })
  }
  const fetches = (await fixture.commands()).filter(args => args[1] === 'fetch')
  expect(fetches.filter(args => !args.includes('--offline'))).toHaveLength(1)
  const installs = (await fixture.commands()).filter(args => args[1] === 'install')
  expect(installs.every(args => args.includes('--offline'))).toBe(true)
})

it('prefetches the changed lockfile before its first suite', async () => {
  const fixture = await computer()
  await fixture.run()
  await writeFile(join(fixture.origin, 'pnpm-lock.yaml'), 'fixture-lock-two')
  fixture.git('add', '.')
  fixture.git('commit', '-qm', 'dependency update')
  await expect(fixture.run()).resolves.toMatchObject({
    run: { state: 'passed' }, text: expect.stringContaining('production dependency=available offline'),
  })
  const fetches = (await fixture.commands()).filter(args => args[1] === 'fetch')
  expect(fetches.filter(args => !args.includes('--offline'))).toHaveLength(2)
})

it('refills an evicted deployment package even when the checkout is already installed', async () => {
  const fixture = await computer()
  await expect(fixture.run()).resolves.toMatchObject({
    run: { state: 'passed' }, text: expect.stringContaining('production dependency=available offline'),
  })
  await fixture.evictDeploymentPackage()
  await expect(fixture.run()).resolves.toMatchObject({
    run: { state: 'passed' }, text: expect.stringContaining('production dependency=available offline'),
  })
  expect(await fixture.onlinePackageCommands()).toHaveLength(2)
})

it('reports prefetch failure before running a suite and fills the store on the next request', async () => {
  const fixture = await computer({ failPrefetch: true })
  await expect(fixture.run()).resolves.toMatchObject({
    run: { state: 'failed', exitCode: 19 }, text: expect.stringContaining('Full lockfile prefetch failed'),
  })
  const commands = await fixture.commands()
  expect(commands.filter(args => args[1] === 'run')).toEqual([])
  expect(commands.filter(args => args[1] === 'install')).toEqual([])
  await fixture.allowPrefetch()
  await expect(fixture.run()).resolves.toMatchObject({
    run: { state: 'passed' }, text: expect.stringContaining('production dependency=available offline'),
  })
})

it('blocks suites when refilling an evicted deployment package fails despite installed dependencies', async () => {
  const fixture = await computer()
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' } })
  const before = await fixture.commands()
  await fixture.evictDeploymentPackage()
  await fixture.rejectPrefetch()
  await expect(fixture.run()).resolves.toMatchObject({
    run: { state: 'failed', exitCode: 19 }, text: expect.stringContaining('Full lockfile prefetch failed'),
  })
  const commands = await fixture.commands()
  expect(commands.filter(args => args[1] === 'run')).toEqual(before.filter(args => args[1] === 'run'))
  expect(commands.filter(args => args[1] === 'install')).toEqual(before.filter(args => args[1] === 'install'))
  await fixture.allowPrefetch()
  await expect(fixture.run()).resolves.toMatchObject({
    run: { state: 'passed' }, text: expect.stringContaining('production dependency=available offline'),
  })
})

it('keeps background warmup offline even when the full lockfile store is incomplete', async () => {
  const fixture = await computer()
  await expect(fixture.run({ warmup: true })).resolves.toMatchObject({ run: { state: 'failed', exitCode: 7 } })
  expect(await fixture.onlinePackageCommands()).toEqual([])
  await expect(fixture.run()).resolves.toMatchObject({
    run: { state: 'passed' }, text: expect.stringContaining('production dependency=available offline'),
  })
  fixture.git('commit', '--allow-empty', '-qm', 'request a new warmup')
  await expect(fixture.run({ warmup: true })).resolves.toMatchObject({ run: { state: 'passed' } })
  expect(await fixture.onlinePackageCommands()).toHaveLength(1)
})

it('shares one online prefetch between concurrent cold requests', async () => {
  const fixture = await computer()
  const replies = await Promise.all([fixture.run(), fixture.run()])
  for (const reply of replies) {
    expect(reply).toMatchObject({
      run: { state: 'passed' }, text: expect.stringContaining('production dependency=available offline'),
    })
  }
  expect(await fixture.onlinePackageCommands()).toHaveLength(1)
})

it('installs concurrent jobs offline from one warmed repository and store', async () => {
  const fixture = await computer()
  await fixture.run()
  const results = await Promise.all([fixture.run(), fixture.run()])
  for (const result of results) expect(result).toMatchObject({ run: { state: 'passed' } })
  expect(await fixture.onlinePackageCommands()).toHaveLength(1)
})

it('refills an unavailable warmed store online instead of failing the job', async () => {
  const fixture = await computer()
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' } })
  await fixture.failOffline()
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' } })
  expect(await fixture.onlinePackageCommands()).toHaveLength(2)
})

it('waits for dependencies before database preparation can trigger another install', async () => {
  const fixture = await computer({ prepareDatabase: true })
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' } })
  expect(await fixture.commands()).toContainEqual(['pnpm', 'db:up'])
})

it('falls back to a fresh checkout when the slot checkout is unusable, then recreates the slot', async () => {
  const fixture = await computer()
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' } })
  await fixture.breakCheckout()
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' },
    text: expect.stringContaining('[ci-checkout] persistent checkout unusable') })
  const next = await fixture.run()
  expect(next).toMatchObject({ run: { state: 'passed' }, text: expect.stringContaining('dependency=pristine') })
  expect(next).toMatchObject({ text: expect.not.stringContaining('[ci-checkout]') })
  expect(await fixture.onlinePackageCommands()).toHaveLength(1)
})

it('fetches only the tested commit on a cold runner and on later jobs with explicit files', async () => {
  const fixture = await computer()
  const staleCommit = fixture.git('rev-parse', 'HEAD')
  fixture.git('branch', 'ci/stale', staleCommit)
  fixture.git('commit', '--allow-empty', '-qm', 'tested commit')
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' } })
  expect(fixture.checkout('for-each-ref', '--format=%(refname)', 'refs/remotes/')).toBe('')
  expect(fixture.checkout('rev-list', '--count', fixture.git('rev-parse', 'HEAD'))).toBe('1')
  fixture.git('commit', '--allow-empty', '-qm', 'next tested commit')
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' } })
  expect(fixture.checkout('for-each-ref', '--format=%(refname)', 'refs/remotes/')).toBe('')
  expect(fixture.checkout('rev-list', '--count', fixture.git('rev-parse', 'HEAD'))).toBe('1')
})

it('waits for a registered process when the unit appears active before launch acknowledgement', async () => {
  const launching = deferred()
  const acknowledged = deferred()
  const fixture = await computer({
    beforeLaunch: async () => {
      launching.resolve()
      await acknowledged.promise
    },
    afterRunning: async () => {
      await launching.promise
      acknowledged.resolve()
    },
  })
  try {
    await expect(fixture.run()).resolves.toMatchObject({
      run: { state: 'passed' }, text: expect.stringContaining('dependency=pristine'),
    })
    expect(await fixture.onlinePackageCommands()).toHaveLength(1)
  } finally {
    acknowledged.resolve()
  }
})
