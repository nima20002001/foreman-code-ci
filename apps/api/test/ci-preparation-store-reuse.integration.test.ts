import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { HostCiRunner, systemHostCiPorts, type HostCiPorts } from '../src/modules/ci-host/runner.js'
import { deferred, type Deferred } from './helpers/deferred.js'
import { gitFixtureEnvironment } from './helpers/gitFixture.js'

it.each(['workspace', 'standalone', 'custom patch directory', 'repository hook'])(
  'preserves a warm checkout dependency tree with pinned pnpm across CI requests (%s)', async layout => {
  const base = process.env.FOREMAN_CODE_TEST_ROOT ?? join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'ci-store-reuse-'))
  const origin = join(root, 'origin')
  const environment = gitFixtureEnvironment()
  const execute = promisify(execFile)
  const command = (file: string, args: string[]) => execute(file, args, {
    cwd: origin, env: environment, timeout: 10_000, killSignal: 'SIGKILL',
  })
  const system = systemHostCiPorts()
  const launched = new Map<string, Promise<unknown>>()
  const starts = new Map<string, Deferred<void>>()
  let runner: HostCiRunner | undefined
  try {
    await mkdir(origin, { recursive: true })
    await mkdir(join(root, 'package'), { recursive: true })
    await writeFile(join(origin, 'package.json'), JSON.stringify({
      name: 'ci-store-reuse-fixture', private: true, packageManager: 'pnpm@11.27.0',
      dependencies: { '@fixture/dependency': 'file:./dependency.tgz' }, scripts: { lint: 'node suite.cjs' },
    }))
    const workspace = [
      'minimumReleaseAge: 2880', 'minimumReleaseAgeStrict: true',
      'minimumReleaseAgeIgnoreMissingTime: false', 'packageImportMethod: clone-or-copy',
    ]
    const patched = layout === 'custom patch directory'
    if (patched) {
      await mkdir(join(origin, 'config/fixes'), { recursive: true })
      await writeFile(join(origin, 'config/fixes/dependency.patch'), [
        'diff --git a/index.cjs b/index.cjs', '--- a/index.cjs', '+++ b/index.cjs', '@@ -1 +1 @@',
        '-module.exports = "pristine"', '+module.exports = "patched"', '',
      ].join('\n'))
      workspace.push('patchedDependencies:', '  "@fixture/dependency@1.0.0": config/fixes/dependency.patch')
    }
    if (layout !== 'standalone') {
      await writeFile(join(origin, 'pnpm-workspace.yaml'), workspace.join('\n') + '\n')
    }
    if (layout === 'repository hook') {
      await mkdir(join(origin, 'config'), { recursive: true })
      await writeFile(join(origin, '.pnpmfile.cjs'), 'module.exports = { hooks: require("./config/hooks.cjs") }\n')
      await writeFile(join(origin, 'config/hooks.cjs'), 'module.exports = { readPackage(pkg) { return pkg } }\n')
    }
    await writeFile(join(root, 'package/package.json'), JSON.stringify({
      name: '@fixture/dependency', version: '1.0.0', main: 'index.cjs',
    }))
    await writeFile(join(root, 'package/index.cjs'), 'module.exports = "pristine"\n')
    await command('tar', ['-czf', join(origin, 'dependency.tgz'), '-C', root, 'package'])
    await writeFile(join(origin, 'suite.cjs'), [
      'const fs = require("node:fs")',
      'console.log("dependency=" + require("@fixture/dependency"))',
      'fs.writeFileSync(require.resolve("@fixture/dependency"), \'module.exports = "modified by suite"\\n\')',
    ].join('\n'))
    await command('corepack', ['pnpm', 'install', '--lockfile-only', '--offline', '--no-frozen-lockfile'])
    await command('git', ['init', '-q', '-b', 'main'])
    await command('git', ['add', '.'])
    await command('git', ['commit', '-qm', 'fixture'])
    const { stdout } = await command('git', ['rev-parse', 'HEAD'])
    let commit = stdout.trim()
    const ports: HostCiPorts = { ...system, cpus: 4, memoryBytes: 8 * 2 ** 30,
      availableMemoryBytes: () => 8 * 2 ** 30,
      run: async (file, args, options) => {
        if (file === 'gh') return { code: 0, stdout: '', stderr: '' }
        if (file === 'git' && args.some(arg => arg.startsWith('https://github.com/'))) {
          return system.run(file, args.map(arg => arg.startsWith('https://github.com/') ? origin : arg), options)
        }
        if (file === 'systemd-run') {
          const cwd = args.find(arg => arg.startsWith('--working-directory='))!.slice('--working-directory='.length)
          const env = Object.fromEntries(args.filter(arg => arg.startsWith('--setenv='))
            .map(arg => arg.slice('--setenv='.length).split(/=(.*)/s).slice(0, 2)))
          const script = args.at(-1)!
          launched.set(script, system.run('/bin/bash', [script], { cwd, env }))
          starts.get(script)!.resolve()
          return { code: 0, stdout: '', stderr: '' }
        }
        if (file === 'systemctl') {
          const stdout = args.filter(arg => arg.endsWith('.service'))
            .map(unit => `Id=${unit}\nLoadState=loaded\nActiveState=active\n`).join('\n')
          return { code: 0, stdout, stderr: '' }
        }
        return system.run(file, args, options)
      },
    }
    runner = new HostCiRunner(join(root, 'runner'), ports, environment)
    const run = async () => {
      const runId = randomUUID()
      const script = join(root, 'runner/runs', runId, 'run.sh')
      const started = deferred()
      starts.set(script, started)
      await runner!.handle({ operation: 'start', runId, repository: 'example/project', commit,
        suite: 'lint', scope: 'full' })
      await started.promise
      await launched.get(script)
      await vi.waitFor(() => expect(runner!.isUpdateIdle()).toBe(true), { timeout: 10_000 })
      return runner!.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 })
    }
    const first = await run()
    expect(first).toMatchObject({
      run: { state: 'passed' }, text: expect.stringContaining(`dependency=${patched ? 'patched' : 'pristine'}`),
    })
    if (layout === 'repository hook') {
      expect(first).toMatchObject({ text: expect.stringContaining('prefetch unsupported for this layout (.pnpmfile.cjs)') })
    }
    await expect(run()).resolves.toMatchObject({
      run: { state: 'passed' }, text: expect.stringContaining('dependency=modified by suite'),
    })
    await appendFile(join(origin, 'pnpm-lock.yaml'), '\n# refreshed dependency inputs\n')
    await command('git', ['commit', '-qam', 'refresh dependency inputs'])
    commit = (await command('git', ['rev-parse', 'HEAD'])).stdout.trim()
    await expect(run()).resolves.toMatchObject({
      run: { state: 'passed' }, text: expect.stringContaining('dependency=modified by suite'),
    })
  } finally {
    await runner?.beginDrain()
    await Promise.all([...launched.values()])
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
