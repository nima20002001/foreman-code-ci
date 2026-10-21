import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { HostCiRunner, systemHostCiPorts, type HostCiPorts } from './runner.js'

it.each([
  { ciShell: false, preparationDelayMs: 0 },
  { ciShell: true, preparationDelayMs: 0 },
  { ciShell: false, preparationDelayMs: 1500 },
])('selects one heavy integration file per weighted build-computer partition '
  + '(CI shell: $ciShell, preparation delay: $preparationDelayMs ms)', async ({ ciShell, preparationDelayMs }) => {
  const base = process.env.FOREMAN_CODE_TEST_ROOT ?? process.env.TMPDIR
  if (!base) throw new Error('A disposable test root is required')
  const root = await mkdtemp(join(base, 'partition-host-'))
  const origin = join(root, 'origin')
  const bin = join(root, 'bin')
  const calls = join(root, 'calls.jsonl')
  const heavy = [
    'apps/api/test/remote-review-production-main-crash.integration.test.ts',
    'apps/api/test/computer-workflow-save.regression-directories.integration.test.ts',
    'apps/api/test/local-human-native.integration.test.ts',
    'apps/api/test/native-stream-lifecycle.integration.test.ts',
  ]
  const ordinary = ['first', 'second', 'third', 'fourth'].map(name => `apps/api/test/${name}.integration.test.ts`)
  const files = [...ordinary, ...heavy]
  const durations = Object.fromEntries(files.map((file, index) => [file, 1000 - index * 100]))
  const system = systemHostCiPorts()
  let launched = Promise.resolve()
  let runner: HostCiRunner | undefined
  const admittedRuns: string[] = []
  try {
    await mkdir(join(origin, 'apps/api/test'), { recursive: true })
    await mkdir(join(origin, 'scripts'))
    await mkdir(bin)
    for (const file of files) await writeFile(join(origin, file), '')
    await writeFile(join(origin, 'package.json'), JSON.stringify({ scripts: { 'test:integration': 'fixture' } }))
    await writeFile(join(origin, 'pnpm-lock.yaml'), '')
    await writeFile(join(origin, 'scripts/ci-suite.sh'), '#!/bin/bash\nexit 0\n')
    await writeFile(join(origin, 'scripts/ci-files.mjs'),
      await readFile(new URL('../../../../../scripts/ci-files.mjs', import.meta.url), 'utf8'))
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: origin, env: gitFixtureEnvironment(), encoding: 'utf8',
    }).trim()
    git('init', '-q', '-b', 'main')
    git('add', '.')
    git('commit', '-qm', 'fixture')
    const commit = git('rev-parse', 'HEAD')
    await writeFile(join(bin, 'corepack'), `#!${process.execPath}\n`
      + "require('node:fs').appendFileSync(process.env.CI_CALLS_FILE, JSON.stringify(process.argv.slice(2)) + '\\n')\n")
    await chmod(join(bin, 'corepack'), 0o755)
    const shellStartup = join(root, 'shell-startup')
    await writeFile(shellStartup, 'export PATH=/unavailable-fixture-commands\n')
    const environment = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CI_CALLS_FILE: calls,
      ...(ciShell ? { BASH_ENV: shellStartup } : {}) }
    const ports: HostCiPorts = { ...system, run: async (file, args, options) => {
      if (file === 'gh') return { code: 0, stdout: '', stderr: '' }
      if (file === 'git' && args.some(value => value.startsWith('https://github.com/'))) {
        if (args.includes('--shared') && preparationDelayMs) {
          await delay(preparationDelayMs)
          preparationDelayMs = 0
        }
        return system.run(file, args.map(value => value.startsWith('https://') ? origin : value), options)
      }
      if (file === 'systemd-run') {
        const cwd = args.find(value => value.startsWith('--working-directory='))!.slice('--working-directory='.length)
        // A systemd service receives the runner's explicit environment, not the enclosing CI shell's BASH_ENV.
        const env = Object.fromEntries(args.filter(value => value.startsWith('--setenv='))
          .map(value => value.slice('--setenv='.length).split(/=(.*)/s).slice(0, 2)))
        const script = args.at(-1)!
        launched = system.run('/bin/bash', [script], { cwd, env: { ...env, CI_CALLS_FILE: calls } }).then(async result => {
          const log = await readFile(join(dirname(script), 'log'), 'utf8')
          expect(result.code, log).toBe(0)
        })
        return { code: 0, stdout: '', stderr: '' }
      }
      if (file === 'systemctl') {
        if (args.includes('stop')) await launched
        return { code: 0, stdout: 'active', stderr: '' }
      }
      return system.run(file, args, options)
    } }
    runner = new HostCiRunner(join(root, 'runner'), ports, environment)
    const host = runner
    for (const index of [0, 1, 2, 3]) {
      const runId = randomUUID()
      await host.handle({ operation: 'start', runId, repository: 'example/project', commit, suite: 'integration',
        partition: { index, count: 4, weights: [8, 1, 1, 1] }, durations })
      admittedRuns.push(runId)
      await expect.poll(async () => {
        const reply = await host.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 })
        return reply.operation === 'read' ? reply.run.state : 'unexpected'
      }, { timeout: 10_000 }).not.toBe('starting')
      await launched
      expect(await host.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
        .toMatchObject({ run: { state: 'passed' } })
    }
    const commands = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    const slices = commands.filter(command => command[1] === 'test:integration')
      .map(command => command.slice(command.indexOf('--files') + 1))
    expect(slices).toHaveLength(4)
    expect(slices.flat().sort()).toEqual([...files].sort())
    expect(slices.map(slice => slice.filter(file => heavy.includes(file)).length)).toEqual([1, 1, 1, 1])
    expect(slices[0]).toContain(heavy[0])
    expect(slices[1]).toContain(heavy[1])
  } finally {
    for (const runId of admittedRuns) await runner!.handle({ operation: 'cancel', runId })
    try { await launched } finally { await rm(root, { recursive: true, force: true }) }
  }
})
