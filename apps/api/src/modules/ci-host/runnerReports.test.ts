import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { CiTestResults } from '@foreman-code/contracts'
import { deferred } from '../../../test/helpers/deferred.js'
import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { HostCiRunner, type HostCiPorts } from './runner.js'

const fault = vi.hoisted(() => ({ report: null as string | null, code: 'EIO' }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    if (fault.report && String(args[0]).endsWith(fault.report)) {
      throw Object.assign(new Error('Report temporarily unreadable'), { code: fault.code })
    }
    return actual.readFile(...args)
  } }
})

const roots: string[] = []
const runners: HostCiRunner[] = []
afterEach(async () => {
  fault.report = null
  await Promise.all(runners.splice(0).map(runner => runner.beginDrain()))
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

const tests: CiTestResults = { summary: { passed: 1, failed: 0, skipped: 0 }, truncated: false,
  files: [{ file: 'apps/api/src/example.test.ts', status: 'passed', durationMs: 12,
    tests: [{ name: 'returns a result', status: 'passed', durationMs: 12 }] }] }

async function fixture(suite: 'unit' | 'integration', options: {
  beforeLaunch?: () => Promise<void>
  afterRunning?: () => Promise<void>
} = {}) {
  const root = await privateFixtureDirectory('ci-reports-')
  roots.push(root)
  const runId = randomUUID()
  let launches = 0
  let now = Date.now()
  const ports: HostCiPorts = { cpus: 4, memoryBytes: 8 * 2 ** 30, now: () => new Date(now),
    run: async (file, args) => {
      if (file === 'git' && args.includes('show')) return { code: 0, stdout: '{}', stderr: '' }
      if (file === 'git' && args.includes('worktree') && args.includes('add')) {
        const source = args.at(-2)!
        await fs.mkdir(join(source, 'scripts'), { recursive: true })
        await fs.writeFile(join(source, 'package.json'), JSON.stringify({ scripts: { test: 'fixture', 'test:integration': 'fixture' } }))
        await fs.writeFile(join(source, 'scripts/ci-suite.sh'), '')
        await fs.writeFile(join(source, 'scripts/ci-files.mjs'), '')
      }
      if (file === 'systemd-run') {
        launches++
        await options.beforeLaunch?.()
      }
      const stdout = file === 'systemctl' ? args.filter(arg => arg.endsWith('.service'))
        .map(unit => `Id=${unit}\nLoadState=loaded\nActiveState=active\n`).join('\n') : ''
      return { code: 0, stdout, stderr: '' }
    } }
  const runner = new HostCiRunner(root, ports, {})
  runners.push(runner)
  await runner.handle({ operation: 'start', runId, repository: 'fixture/site', commit: 'a'.repeat(40), suite, scope: 'full' })
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1, testResults: true, durations: true }
  await vi.waitFor(async () => {
    await expect(runner.handle({ ...read, testResults: false, durations: false }))
      .resolves.toMatchObject({ run: { state: 'running' } })
  })
  await options.afterRunning?.()
  await runner.beginDrain()
  expect(runner.isUpdateIdle()).toBe(true)
  const directory = join(root, 'runs', runId)
  await fs.writeFile(join(directory, 'test-results.json'), JSON.stringify(tests))
  await fs.writeFile(join(directory, 'measured-durations.json'), JSON.stringify({ 'apps/api/src/example.test.ts': 12 }))
  await fs.writeFile(join(directory, 'log'), 'Suite completed.\n')
  await fs.writeFile(join(directory, 'step'), suite)
  await fs.writeFile(join(directory, 'exit'), '0\n')
  return { runner, read, directory, reopen: () => new HostCiRunner(root, ports, {}), launches: () => launches,
    advance: (ms: number) => { now += ms } }
}

it.each(['unit', 'integration'] as const)('retries unreadable and malformed %s reports after terminal outcome', async suite => {
  const f = await fixture(suite)
  for (const code of ['EIO', 'EACCES']) {
    fault.report = 'test-results.json'
    fault.code = code
    await expect(f.runner.handle(f.read)).resolves.toMatchObject({ run: { state: 'passed', collection: 'pending' } })
    fault.report = null
    await expect(f.reopen().handle(f.read)).resolves.toMatchObject({
      run: { state: 'passed', collection: 'complete' }, testResults: tests,
    })
  }
  for (const invalid of ['{', '{}']) {
    await fs.writeFile(join(f.directory, 'test-results.json'), invalid)
    await expect(f.runner.handle(f.read)).resolves.toMatchObject({ run: { state: 'passed', collection: 'pending' } })
    await fs.writeFile(join(f.directory, 'test-results.json'), JSON.stringify(tests))
    await expect(f.reopen().handle(f.read)).resolves.toMatchObject({ testResults: tests, run: { collection: 'complete' } })
  }
  expect(f.launches()).toBe(1)
})

it('keeps a supported missing report pending and collects it when it appears', async () => {
  const f = await fixture('unit')
  await fs.rm(join(f.directory, 'test-results.json'))
  await expect(f.runner.handle(f.read)).resolves.toMatchObject({ run: { state: 'passed', collection: 'pending' } })
  await fs.writeFile(join(f.directory, 'test-results.json'), JSON.stringify(tests))
  await expect(f.reopen().handle(f.read)).resolves.toMatchObject({ testResults: tests, run: { collection: 'complete' } })
  expect(f.launches()).toBe(1)
})

it('bounds status summaries while individual reads retain the complete selection', async () => {
  const f = await fixture('integration')
  await f.runner.handle(f.read)
  const saved = JSON.parse(await fs.readFile(join(f.directory, 'meta.json'), 'utf8'))
  const root = dirname(dirname(f.directory))
  const files = Array.from({ length: 2500 }, (_, index) =>
    `apps/api/test/${'feature-'.repeat(10)}${index}.integration.test.ts`)
  const ids: string[] = Array.from({ length: 10 }, () => randomUUID())
  for (const runId of ids) {
    const directory = join(root, 'runs', runId)
    await fs.mkdir(directory)
    await fs.writeFile(join(directory, 'meta.json'), JSON.stringify({ ...saved, runId, cleaned: true,
      selection: { scope: 'affected', files, reason: 'Recorded execution coverage.' } }))
    await fs.writeFile(join(directory, 'log'), '')
    await fs.writeFile(join(directory, 'step'), 'integration')
  }
  const runner = f.reopen()
  const status = await runner.handle({ operation: 'status' })
  expect(Buffer.byteLength(JSON.stringify(status))).toBeLessThan(1024 * 1024)
  if (status.operation !== 'status') throw new Error('Expected CI status')
  expect(status.runs.filter(run => ids.includes(run.runId)).every(run => run.selection === undefined)).toBe(true)
  const detail = await runner.handle({ operation: 'read', runId: ids[0]!, afterOffset: 0, maxBytes: 0 })
  expect(detail).toMatchObject({ run: { selection: { files } } })
})

it.each(['unit', 'integration'] as const)('fails collection of missing %s reports after a crashed process closes', async suite => {
  const f = await fixture(suite)
  await fs.rm(join(f.directory, 'test-results.json'))
  await fs.rm(join(f.directory, 'measured-durations.json'))
  await fs.writeFile(join(f.directory, 'exit'), '137\n')
  const initial = await f.runner.handle(f.read)
  expect(initial).toMatchObject({ run: { state: 'failed', exitCode: 137, collection: 'pending' } })
  if (initial.operation !== 'read') throw new Error('Expected a read response')
  f.advance(15 * 60_000)
  expect(await f.reopen().handle(f.read)).toMatchObject({ run: {
    state: 'failed', exitCode: 137, finishedAt: initial.run.finishedAt, collection: 'failed',
  } })
  expect(f.launches()).toBe(1)
})

it('keeps duration read failures pending even when test results are readable', async () => {
  const f = await fixture('unit')
  fault.report = 'measured-durations.json'
  fault.code = 'EIO'
  await expect(f.runner.handle(f.read)).resolves.toMatchObject({ run: { state: 'passed', collection: 'pending' }, testResults: tests })
  fault.report = null
  await expect(f.reopen().handle(f.read)).resolves.toMatchObject({ run: { collection: 'complete' },
    durations: { 'apps/api/src/example.test.ts': 12 } })
})

it('waits for launch acknowledgement before reading completed reports', async () => {
  const launching = deferred()
  const acknowledged = deferred()
  try {
    const f = await fixture('unit', {
      beforeLaunch: async () => {
        launching.resolve()
        await acknowledged.promise
      },
      afterRunning: async () => {
        await launching.promise
        acknowledged.resolve()
      },
    })
    await expect(f.runner.handle(f.read)).resolves.toMatchObject({
      run: { state: 'passed', collection: 'complete' }, testResults: tests,
      durations: { 'apps/api/src/example.test.ts': 12 },
    })
    expect(f.launches()).toBe(1)
  } finally {
    acknowledged.resolve()
  }
})
