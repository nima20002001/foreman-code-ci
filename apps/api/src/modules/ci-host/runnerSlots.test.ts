import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { HostCiRunner, systemHostCiPorts, type HostCiPorts } from './runner.js'

const roots: string[] = []
const completions: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(completions.splice(0).map(close => close()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A build computer with a real git origin standing in for GitHub and a corepack shim that records each install. */
async function computer() {
  const base = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'slot-host-'))
  roots.push(root)
  const origin = join(root, 'origin')
  const bin = join(root, 'bin')
  const calls = join(root, 'calls.jsonl')
  const fetchCalls = join(root, 'fetch-calls.jsonl')
  const started = join(root, 'started')
  const contracts = join(root, 'contracts')
  const offlineFailure = join(root, 'offline-failure')
  await mkdir(join(origin, 'src'), { recursive: true })
  await mkdir(bin)
  await mkdir(started)
  await writeFile(calls, '')
  await writeFile(join(origin, 'package.json'), JSON.stringify({ scripts: { lint: 'fixture', typecheck: 'fixture' } }))
  await writeFile(join(origin, 'pnpm-lock.yaml'), 'fixture-lock')
  await mkdir(join(origin, 'scripts'))
  await writeFile(join(origin, 'scripts/ci-contracts.mjs'), '// fixture contracts build\n')
  await writeFile(join(origin, '.gitignore'), 'node_modules/\ndist/\n')
  await writeFile(join(origin, 'src/kept.ts'), 'export const kept = 1\n')
  await writeFile(join(origin, 'src/removed.ts'), 'export const removed = 1\n')
  const environment = gitFixtureEnvironment()
  const git = (...args: string[]) => execFileSync('git', args, { cwd: origin, env: environment, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('commit', '-qm', 'fixture')
  // install records whether the checkout already had dependencies; lint can wait until `parallel` parts run at once.
  await writeFile(join(bin, 'corepack'), `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
if (args[1] === 'fetch') {
  fs.appendFileSync(${JSON.stringify(fetchCalls)}, JSON.stringify(args) + '\\n')
  if (args.includes('--offline') && fs.existsSync(${JSON.stringify(offlineFailure)})) process.exit(7)
  if (!args.includes('--offline')) fs.rmSync(${JSON.stringify(offlineFailure)}, { force: true })
  process.exit(0)
}
if (args[1] === 'install') {
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ cwd: process.cwd(), args,
    installed: fs.existsSync('node_modules/dependency') }) + '\\n')
  if (args.includes('--offline') && fs.existsSync(${JSON.stringify(offlineFailure)})) process.exit(7)
  fs.mkdirSync('node_modules', { recursive: true })
  fs.writeFileSync('node_modules/dependency', 'installed')
} else if (args.includes('--filter')) {
  fs.appendFileSync(${JSON.stringify(contracts)}, 'build\\n')
} else {
  if (args.includes('typecheck')) {
    const cache = process.env.FOREMAN_CODE_CI_TYPECHECK_CACHE
    if (!cache) throw new Error('No persistent typecheck cache')
    fs.mkdirSync(cache, { recursive: true })
    const info = path.join(cache, 'fixture.tsbuildinfo')
    console.log('typecheck=' + (fs.existsSync(info) ? 'warm' : 'cold'))
    fs.writeFileSync(info, 'incremental state')
  }
  const parallel = Number(process.env.FIXTURE_PARALLEL ?? 1)
  fs.writeFileSync(path.join(${JSON.stringify(started)}, String(process.pid)), '')
  const deadline = Date.now() + 10000
  while (fs.readdirSync(${JSON.stringify(started)}).length < parallel && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  }
  if (fs.readdirSync(${JSON.stringify(started)}).length < parallel) throw new Error('Concurrent suites did not overlap')
  console.log('overlap=' + parallel)
  console.log('dependency=' + fs.readFileSync('node_modules/dependency', 'utf8'))
  console.log('kept=' + require(path.join(process.cwd(), 'src/kept.ts')).kept)
}
`, { mode: 0o755 })
  const system = systemHostCiPorts()
  const launched = new Map<string, { cwd: string; done: Promise<unknown> }>()
  const units: (readonly string[])[] = []
  const activeUnits = new Set<string>()
  const stopped: string[] = []
  let hold = false
  let parallel = 1
  const ports: HostCiPorts = { ...system, cpus: 16, memoryBytes: 16 * 2 ** 30,
    availableMemoryBytes: () => 16 * 2 ** 30,
    run: async (file, args, options) => {
      if (file === 'gh') return { code: 0, stdout: '', stderr: '' }
      if (file === 'git' && args.some(value => value.startsWith('https://github.com/'))) {
        return system.run(file, args.map(arg => arg.startsWith('https://') ? origin : arg), options)
      }
      if (file === 'systemd-run') {
        units.push(args)
        activeUnits.add(args.find(arg => arg.startsWith('--unit='))!.slice('--unit='.length))
        const cwd = args.find(arg => arg.startsWith('--working-directory='))!.slice('--working-directory='.length)
        const env = Object.fromEntries(args.filter(arg => arg.startsWith('--setenv='))
          .map(arg => arg.slice('--setenv='.length).split(/=(.*)/s).slice(0, 2)))
        launched.set(args.at(-1)!, { cwd,
          done: hold ? Promise.resolve() : system.run('/bin/bash', [args.at(-1)!],
            { cwd, env: { ...env, FIXTURE_PARALLEL: String(parallel) } }) })
        return { code: 0, stdout: '', stderr: '' }
      }
      if (file === 'systemctl' && args.includes('show')) {
        const stdout = args.filter(arg => arg.endsWith('.service')).map(unit => {
          const state = activeUnits.has(unit.replace(/\.service$/, '')) ? 'active' : 'inactive'
          return `Id=${unit}\nLoadState=loaded\nActiveState=${state}\n`
        }).join('\n')
        return { code: 0, stdout, stderr: '' }
      }
      if (file === 'systemctl') {
        const unit = args.at(-1)!.replace(/\.service$/, '')
        if (args.includes('stop')) {
          stopped.push(unit)
          activeUnits.delete(unit)
        }
        return { code: 0, stdout: activeUnits.has(unit) ? 'active' : 'inactive', stderr: '' }
      }
      return system.run(file, args, options)
    } }
  const runner = new HostCiRunner(join(root, 'runner'), ports, { ...environment, PATH: `${bin}:${process.env.PATH}` })
  completions.push(async () => {
    await runner.beginDrain()
    await Promise.all([...launched.values()].map(process => process.done))
  })
  async function run(suite: 'lint' | 'typecheck' | 'install' = 'lint', warmup = false) {
    const runId = randomUUID()
    await runner.handle({ operation: 'start', runId, repository: 'example/project', commit: git('rev-parse', 'HEAD'),
      suite, scope: 'full', ...(warmup ? { warmup: true } : {}) })
    const script = join(root, 'runner/runs', runId, 'run.sh')
    await vi.waitFor(() => expect(launched.has(script)).toBe(true), { timeout: 10_000 })
    await launched.get(script)!.done
    await vi.waitFor(() => expect(runner.isUpdateIdle()).toBe(true), { timeout: 10_000 })
    const reply = await runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 })
    if (reply.operation !== 'read') throw new Error('Expected a read reply.')
    return { ...reply, checkout: launched.get(script)!.cwd }
  }
  const installs = async () => (await readFile(calls, 'utf8')).trim().split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as { cwd: string; args: string[]; installed: boolean })
  const fetches = async () => (await readFile(fetchCalls, 'utf8')).trim().split('\n')
    .map(line => JSON.parse(line) as string[])
  const inCheckout = (checkout: string, ...args: string[]) =>
    execFileSync('git', args, { cwd: checkout, env: environment, encoding: 'utf8' }).trim()
  return { run, installs, fetches, git, origin, inCheckout, runner, units, stopped,
    warm: () => run('install', true),
    hold: (value: boolean) => { hold = value },
    failOffline: () => writeFile(offlineFailure, ''),
    contracts: async () => (await readFile(contracts, 'utf8')).trim().split('\n'),
    concurrently: async (count: number) => {
    parallel = count
    await rm(started, { recursive: true, force: true })
    await mkdir(started)
  } }
}

it('runs the next part in the same checkout and installs incrementally over its dependencies', async () => {
  const fixture = await computer()
  const first = await fixture.run()
  const second = await fixture.run()
  expect(first).toMatchObject({ run: { state: 'passed' }, text: expect.stringContaining('dependency=installed') })
  expect(second).toMatchObject({ run: { state: 'passed' }, text: expect.stringContaining('dependency=installed') })
  expect(second.checkout).toBe(first.checkout)
  const installs = await fixture.installs()
  expect(installs).toHaveLength(2)
  expect(installs[1]).toMatchObject({ cwd: first.checkout, installed: true })
  expect(installs[1]!.args).toEqual(expect.arrayContaining(['--offline', '--frozen-lockfile']))
})

it('prepares a commit in a persistent slot without reserving CI capacity and reuses it for the first job', async () => {
  const fixture = await computer()
  const warm = await fixture.warm()
  expect(warm.run).toMatchObject({ state: 'passed', warmup: true })
  expect(await fixture.runner.status()).toMatchObject({ prewarmSupported: true, slotsUsed: 0, runs: [] })
  expect(fixture.units[0]).toEqual(expect.arrayContaining([
    '--property=Nice=19', '--property=CPUWeight=1', '--property=IOWeight=1',
  ]))
  expect(await fixture.contracts()).toHaveLength(1)
  const first = await fixture.run()
  expect(first.run.state).toBe('passed')
  expect(first.checkout).toBe(warm.checkout)
  expect(await fixture.installs()).toEqual([
    expect.objectContaining({ installed: false, args: expect.arrayContaining(['--offline']) }),
    expect.objectContaining({ installed: true }),
  ])
})

it('deduplicates successful warm-ups and prepares a changed commit again', async () => {
  const fixture = await computer()
  const first = await fixture.warm()
  const duplicate = await fixture.runner.handle({ operation: 'start', runId: randomUUID(), warmup: true,
    repository: 'example/project', commit: fixture.git('rev-parse', 'HEAD'), suite: 'install', scope: 'full' })
  expect(duplicate).toMatchObject({ run: { runId: first.run.runId, state: 'passed' } })
  expect(fixture.units).toHaveLength(1)
  await writeFile(join(fixture.origin, 'pnpm-lock.yaml'), 'changed-lock')
  fixture.git('commit', '-qam', 'change dependencies')
  expect((await fixture.warm()).run.state).toBe('passed')
  expect(await fixture.installs()).toHaveLength(2)
})

it('does not refill dependencies online during pre-warming', async () => {
  const fixture = await computer()
  await fixture.failOffline()
  expect((await fixture.warm()).run).toMatchObject({ state: 'failed', exitCode: 7 })
  expect(await fixture.fetches()).toHaveLength(1)
  expect((await fixture.fetches())[0]).toContain('--offline')
  expect(await fixture.installs()).toEqual([])
})

it('stops a running warm-up before real CI uses its checkout and defers warm-ups while CI is active', async () => {
  const fixture = await computer()
  fixture.hold(true)
  const warm = await fixture.warm()
  expect(warm.run.state).toBe('running')
  expect(await fixture.runner.status()).toMatchObject({ slotsUsed: 0 })
  const real = await fixture.run()
  expect(real.run.state).toBe('running')
  expect(fixture.stopped).toContain(`foreman-ci-${warm.run.runId}`)
  const canceled = await fixture.runner.handle({ operation: 'read', runId: warm.run.runId,
    afterOffset: 0, maxBytes: 65_536 })
  expect(canceled).toMatchObject({ run: { state: 'canceled' } })
  const deferred = await fixture.runner.handle({ operation: 'start', runId: randomUUID(), warmup: true,
    repository: 'example/project', commit: fixture.git('rev-parse', 'HEAD'), suite: 'install', scope: 'full' })
  expect(deferred).toMatchObject({ run: { state: 'queued' } })
  expect(fixture.units).toHaveLength(2)
})

it('resets a reused checkout to exactly the requested commit without leftover files', async () => {
  const fixture = await computer()
  const first = await fixture.run()
  expect(first.run.state).toBe('passed')
  await writeFile(join(first.checkout, 'src/kept.ts'), 'locally modified\n')
  await writeFile(join(first.checkout, 'untracked.ts'), 'leftover\n')
  await mkdir(join(first.checkout, 'dist'), { recursive: true })
  await writeFile(join(first.checkout, 'dist/removed.js'), 'stale build output\n')
  fixture.git('rm', '-q', 'src/removed.ts')
  fixture.git('commit', '-qm', 'remove a source')
  const second = await fixture.run()
  expect(second.run.state).toBe('passed')
  expect(second.checkout).toBe(first.checkout)
  expect(fixture.inCheckout(second.checkout, 'rev-parse', 'HEAD')).toBe(fixture.git('rev-parse', 'HEAD'))
  expect(second.text).toContain('kept=1')
  expect(existsSync(join(second.checkout, 'src/removed.ts'))).toBe(false)
  expect(fixture.inCheckout(second.checkout, 'status', '--porcelain', '--ignored', '--untracked-files=all'))
    .toBe('!! node_modules/dependency')
})

it('runs concurrent parts in overlapping processes with isolated dependencies', async () => {
  const fixture = await computer()
  await fixture.run()
  await fixture.concurrently(2)
  const results = await Promise.all([fixture.run(), fixture.run()])
  for (const result of results) {
    expect(result).toMatchObject({ run: { state: 'passed' }, text: expect.stringContaining('dependency=installed') })
  }
  for (const result of results) expect(result.text).toContain('overlap=2')
  expect(results[0].checkout).not.toBe(results[1].checkout)
})

it('retains typecheck state per slot outside a replaced dependency directory', async () => {
  const fixture = await computer()
  const first = await fixture.run('typecheck')
  expect(first).toMatchObject({ run: { state: 'passed' }, text: expect.stringContaining('typecheck=cold') })
  await rm(join(first.checkout, 'node_modules'), { recursive: true, force: true })
  const second = await fixture.run('typecheck')
  expect(second).toMatchObject({ run: { state: 'passed' }, text: expect.stringContaining('typecheck=warm') })
  await fixture.concurrently(2)
  const results = await Promise.all([fixture.run('typecheck'), fixture.run('typecheck')])
  expect(results.map(result => result.text.match(/typecheck=(warm|cold)/)?.[1]).sort()).toEqual(['cold', 'warm'])
  for (const result of results) expect(result.run.state).toBe('passed')
})
