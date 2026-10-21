import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { GitCiCommits } from '../../src/modules/ci-host/commits.js'
import { CloudCi } from '../../src/modules/ci-host/cloud.js'
import { GitHubActionsProvider } from '../../src/modules/ci-host/cloudProviders.js'
import { HostCiRunner, systemHostCiPorts, type HostCiPorts } from '../../src/modules/ci-host/runner.js'
import type { HostCiComputer, HostCiEndpoint } from '../../src/modules/ci-host/service.js'
import type { GitWorktreePorts } from '../../src/modules/sources/gitWorktree.js'
import { gitFixtureEnvironment } from './gitFixture.js'
import { deferred, type Deferred } from './deferred.js'

type CommandResult = Awaited<ReturnType<HostCiPorts['run']>>

/** Real git and package scripts, with local origins and a process standing in for the systemd service. */
export async function genericCiRepository(options: { lockfile?: string; integration?: boolean; cloud?: boolean
  suiteExit?: number; suiteHook?: boolean; beforeLaunch?: () => Promise<void>
  beforeCheckout?: () => Promise<void> } = {}) {
  const base = process.env.FOREMAN_CODE_TEST_ROOT ?? process.env.TMPDIR
  if (!base) throw new Error('A disposable test root is required.')
  const root = await mkdtemp(join(base, 'generic-ci-'))
  const origin = join(root, 'origin')
  const mirror = join(root, 'mirror')
  const bin = join(root, 'bin')
  const system = systemHostCiPorts()
  const environment = { ...gitFixtureEnvironment(), PATH: `${bin}:${process.env.PATH}` }
  const localUrl = (value: string) => {
    if (value.startsWith('https://') && value.endsWith('/octo/site.git')) return origin
    if (value.startsWith('https://') && value.endsWith('/octo/site-ci.git')) return mirror
    return value
  }
  const git: GitWorktreePorts = {
    cloneDirectory: repository => join(root, 'clones', ...repository.split('/')),
    git: (args, settings) => system.run('git', args.map(localUrl), {
      ...(settings.cwd ? { cwd: settings.cwd } : {}), env: { ...environment, ...settings.env },
    }),
  }
  const processes = new Map<string, Promise<CommandResult>>()
  const completions = new Map<string, Deferred<CommandResult>>()
  try {
    await mkdir(origin)
    await mkdir(mirror)
    await mkdir(bin)
    const scripts: Record<string, string> = Object.fromEntries(['build', 'lint', 'unit'].map(suite =>
      [suite, `node -e "console.log('fixture ${suite} passed'); process.exit(${options.suiteExit ?? 0})"`]))
    if (options.integration) scripts.integration = "node -e \"console.log('fixture integration passed')\""
    await writeFile(join(origin, 'package.json'), JSON.stringify({ name: 'fixture-project', private: true, scripts }))
    if (options.lockfile) await writeFile(join(origin, options.lockfile), '')
    if (options.suiteHook) {
      await mkdir(join(origin, 'scripts'))
      await writeFile(join(origin, 'scripts/ci-suite.sh'), '#!/bin/bash\n'
        + 'if [ "${1:-}" = prepare ]; then exit 0; fi\n'
        + 'case "$SUITE" in build-api|build-other) echo "fixture hook $SUITE passed" ;; *) exit 23 ;; esac\n')
    }
    await writeFile(join(mirror, 'README.md'), 'CI mirror\n')
    for (const cwd of [origin, mirror]) {
      for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['commit', '-qm', 'fixture']]) {
        const result = await system.run('git', args, { cwd, env: environment })
        if (result.code !== 0) throw new Error(`Fixture git ${args[0]} failed.`)
      }
    }
    const head = await system.run('git', ['rev-parse', 'HEAD'], { cwd: origin, env: environment })
    if (head.code !== 0) throw new Error('Could not read the fixture commit.')
    const packageManager = `#!${process.execPath}
const { readFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { basename } = require('node:path')
const tool = basename(process.argv[1])
const args = process.argv.slice(2)
console.log(tool + ' ' + args.join(' '))
if (args[0] === '--version') process.exit(0)
if (tool === 'corepack') args.shift()
if (args[0] === 'install' || args[0] === 'fetch') process.exit(0)
if (args[0] !== 'run' || args.length !== 2) process.exit(21)
const script = JSON.parse(readFileSync('package.json', 'utf8')).scripts[args[1]]
if (!script) process.exit(22)
const result = spawnSync('bash', ['-c', script], { stdio: 'inherit' })
process.exit(result.status ?? 1)
`
    for (const tool of ['corepack', 'npm']) {
      await writeFile(join(bin, tool), packageManager, { mode: 0o755 })
    }
    const ports: HostCiPorts = { ...system, run: async (file, args, settings = {}) => {
      if (file === 'gh') return { code: 0, stdout: '', stderr: '' }
      if (file === 'git') {
        if (args.includes('worktree') && args.includes('add')) await options.beforeCheckout?.()
        return system.run(file, args.map(localUrl), { ...settings, env: environment })
      }
      if (file === 'systemd-run') {
        await options.beforeLaunch?.()
        const cwd = args.find(value => value.startsWith('--working-directory='))!.slice('--working-directory='.length)
        const script = args.at(-1)!
        const runId = basename(dirname(script))
        const completion = system.run('bash', [script], { cwd, env: environment })
        processes.set(runId, completion)
        void completion.then(result => {
          completions.get(runId)!.resolve(result)
          processes.delete(runId)
        })
        return { code: 0, stdout: '', stderr: '' }
      }
      if (file === 'systemctl') {
        const units = args.filter(arg => arg.startsWith('foreman-ci-') && arg.endsWith('.service'))
        const runId = (unit: string) => unit.slice('foreman-ci-'.length, -'.service'.length)
        // A successful stop reply confirms the fixture process has closed, like the systemd command.
        if (args.includes('stop')) await Promise.all(units.map(unit => processes.get(runId(unit))))
        const stdout = args.includes('show') ? units.map(unit => {
          const active = processes.has(runId(unit))
          return `Id=${unit}\nLoadState=${active ? 'loaded' : 'not-found'}\nActiveState=${active ? 'active' : 'inactive'}\n`
        }).join('\n') : ''
        return { code: 0, stdout, stderr: '' }
      }
      return system.run(file, args, settings)
    } }
    const runner = new HostCiRunner(join(root, 'runner'), ports, environment)
    const computer: HostCiComputer = { key: randomUUID(), hostRef: { kind: 'main', mainId: randomUUID() },
      label: 'Build computer', priority: 60 }
    const cloud = new CloudCi(computer.hostRef.mainId, new GitHubActionsProvider(ports), async () => 'octo/site-ci',
      join(root, 'cloud'), ports, git)
    const cloudAttempts: string[] = []
    const endpoint: HostCiEndpoint = {
      computers: async () => options.cloud ? [...cloud.computers().slice(0, 1), computer] : [computer],
      request: async (target, request) => {
        if (target.hostRef.kind !== 'cloud') {
          if (request.operation === 'start' && !completions.has(request.runId)) {
            completions.set(request.runId, deferred<CommandResult>())
          }
          return runner.handle(request)
        }
        if (request.operation === 'start') cloudAttempts.push(request.runId)
        return cloud.handle(request)
      },
    }
    return { commits: new GitCiCommits(git), endpoint, cloudAttempts, commit: head.stdout.trim(),
      waitForCompletion(runId: string) {
        const completion = completions.get(runId)
        if (!completion) throw new Error('The fixture has not started this CI run.')
        return completion.promise
      },
      async close() {
        await runner.beginDrain()
        await Promise.all(processes.values())
        await rm(root, { recursive: true, force: true })
      } }
  } catch (error) {
    await Promise.all(processes.values())
    await rm(root, { recursive: true, force: true })
    throw error
  }
}
