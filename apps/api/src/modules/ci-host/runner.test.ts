import { once } from 'node:events'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, copyFile, rm, writeFile, chmod, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { HostCiRunner, systemHostCiPorts, type HostCiPorts } from './runner.js'
import { integrationShardPlan } from '../../../../../scripts/test-integration.mjs'

declare module '../../../../../scripts/test-integration.mjs' {
  export function integrationShardPlan(
    environment: NodeJS.ProcessEnv,
    resources?: {
      cpuCount?: number
      availableMemoryBytes?: number
      maxConnections?: number
      reservedConnections?: number
      activeConnections?: number
    },
    fileCount?: number,
  ): { shards: number; limit: number; reason: string }
}

const roots: string[] = []
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})
const children = new Set<ReturnType<typeof spawn>>()
async function stopUnit(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = once(child, 'close')
  process.kill(-child.pid!, 'SIGKILL')
  await closed
}
afterEach(async () => {
  await Promise.all([...children].map(stopUnit))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A computer with a real git origin standing in for GitHub, gh and corepack shims, and a systemd-run that runs the
 * unit's script as a child process the way the user manager would. */
async function computer(options: { github?: boolean; suiteExit?: number; watchdogReason?: string; pause?: boolean
  measured?: Record<string, number>; databaseExit?: number; selector?: boolean;
  change?: 'source' | 'infrastructure' | 'docs'; defaultBranch?: string; cpuCount?: number; hostSlots?: boolean
  affectedUnitTests?: number; inspectSource?: boolean; memoryBytes?: number;
  beforeCheckout?: () => Promise<void> } = {}) {
  const temporaryRoot = process.env.FOREMAN_CODE_TEST_ROOT ?? join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(temporaryRoot, { recursive: true })
  const root = await mkdtemp(join(temporaryRoot, 'host-ci-'))
  roots.push(root)
  const environment = gitFixtureEnvironment()
  const origin = join(root, 'origin')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: origin, env: environment, encoding: 'utf8' }).trim()
  await mkdir(join(origin, 'apps/api/test'), { recursive: true })
  await writeFile(join(origin, 'package.json'), JSON.stringify({ name: 'fixture',
    ...(options.hostSlots ? { foremanCi: { hostSlots: 1 } } : {}), scripts: {
    typecheck: 'tsc', lint: 'eslint', build: 'tsc -b', test: 'vitest',
    'test:integration': 'node scripts/test-integration.mjs', 'db:up': 'node db.mjs',
    'test:scripts': 'node --test scripts/fixture.test.mjs' } }))
  if (options.inspectSource) {
    await writeFile(join(origin, 'program.mjs'), 'process.stdout.write(JSON.stringify({value: 1}))\n')
  }
  await writeFile(join(origin, 'pnpm-lock.yaml'), '')
  for (const name of ['a', 'b', 'c', 'd']) await writeFile(join(origin, `apps/api/test/${name}.integration.test.ts`), '')
  await mkdir(join(origin, 'scripts'))
  await mkdir(join(origin, 'apps/worker/test'), { recursive: true })
  await writeFile(join(origin, 'apps/worker/test/fixture.test.mjs'), '')
  await writeFile(join(origin, 'scripts/fixture.test.mjs'), '')
  await writeFile(join(origin, 'scripts/integration-durations.json'), JSON.stringify({
    'apps/api/test/a.integration.test.ts': 400, 'apps/api/test/b.integration.test.ts': 300,
    'apps/api/test/c.integration.test.ts': 200, 'apps/api/test/d.integration.test.ts': 100 }))
  await mkdir(join(origin, 'apps/web/src'), { recursive: true })
  await writeFile(join(origin, 'apps/web/heavy-tests.json'), JSON.stringify({ files: [] }))
  await copyFile(new URL('../../../../../scripts/ci-unit-files.mjs', import.meta.url),
    join(origin, 'scripts/ci-unit-files.mjs'))
  const suiteFiles = ['ci-affected-run.mjs', 'ci-files.mjs', 'ci-suite.sh',
    'ci-test-results.mjs', 'ci-node-test-reporter.mjs', 'ci-typecheck-cache.mjs']
  for (const file of suiteFiles) {
    await copyFile(new URL(`../../../../../scripts/${file}`, import.meta.url), join(origin, 'scripts', file))
  }
  await writeFile(join(origin, 'scripts/test-command.mjs'),
    "import { spawnSync } from 'node:child_process'; const [, command, ...args] = process.argv.slice(2);"
      + " const result = spawnSync(command, args, { stdio: 'inherit' }); process.exit(result.status ?? 1);\n")
  const unitFiles = ['apps/api/test/first.test.ts', 'apps/api/test/second.test.ts',
    'apps/web/src/first.test.tsx', 'apps/web/src/second.test.tsx']
  for (const file of unitFiles) await writeFile(join(origin, file), '')
  if (options.selector) {
    await copyFile(new URL('../../../../../scripts/ci-affected.mjs', import.meta.url),
      join(origin, 'scripts/ci-affected.mjs'))
    await copyFile(new URL('../../../../../scripts/worker-snapshot-policy.mjs', import.meta.url),
      join(origin, 'scripts/worker-snapshot-policy.mjs'))
    await mkdir(join(origin, 'packages/contracts/src'), { recursive: true })
    for (const file of ['ciImportGraph.mjs', 'ciCoverage.mjs']) {
      await copyFile(new URL(`../../../../../packages/contracts/src/${file}`, import.meta.url),
        join(origin, 'packages/contracts/src', file))
    }
    await mkdir(join(origin, 'apps/api/src'), { recursive: true })
    await writeFile(join(origin, 'apps/api/src/feature.ts'), 'export const value = 1')
    await writeFile(join(origin, unitFiles[0]!), "import '../src/feature.js'")
    await writeFile(join(origin, 'apps/api/test/a.integration.test.ts'), "import '../src/feature.js'")
    for (let index = 0; index < (options.affectedUnitTests ?? 0); index++) {
      await writeFile(join(origin, `apps/api/test/many-${index}.test.ts`), "import '../src/feature.js'")
    }
  }
  await writeFile(join(origin, 'scripts/unit-durations.json'), JSON.stringify(Object.fromEntries(
    unitFiles.map((file, index) => [file, 100 + index * 10]))))
  git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-qm', 'fixture')
  const baseCommit = git('rev-parse', 'HEAD')
  if (options.defaultBranch) git('branch', '-m', options.defaultBranch)
  if (options.change) {
    git('checkout', '-qb', 'feature')
    const changedFile = { source: 'apps/api/src/feature.ts', infrastructure: 'package.json', docs: 'README.md' }[options.change]
    const text = options.change === 'infrastructure'
      ? (await readFile(join(origin, changedFile), 'utf8')).replace('fixture', 'changed-fixture') : 'export const value = 2'
    await writeFile(join(origin, changedFile), text)
    git('add', '.')
    git('commit', '-qm', 'feature change')
  }
  const commit = git('rev-parse', 'HEAD')
  const bin = join(root, 'bin')
  await mkdir(bin)
  // corepack records its arguments; the suite command exits with the requested status. With `measured`, the
  // integration suite prints the durations it was given and reports the ones it measured, like the repository's runner.
  const integration = options.measured ? `if [ "$2" = test:integration ]; then echo "expected $(cat "$FOREMAN_CODE_INTEGRATION_DURATIONS")"; `
    + `printf '%s' '${JSON.stringify(options.measured)}' > "$FOREMAN_CODE_INTEGRATION_DURATIONS_OUTPUT"; fi\n` : ''
  const unitReport = `${process.execPath} -e 'const fs = require("node:fs"); const path = require("node:path");
    const args = process.argv.slice(1); const output = args.find(arg => arg.startsWith("--outputFile.json="));
    const nodeOutput = args.find(arg => arg.startsWith("--test-reporter-destination=") && !arg.endsWith("=stdout"));
    if (nodeOutput) fs.writeFileSync(nodeOutput.slice("--test-reporter-destination=".length), JSON.stringify({ testResults: [] }));
    if (output) fs.writeFileSync(output.slice("--outputFile.json=".length), JSON.stringify({ testResults:
      args.filter(arg => /\\.test\\.tsx?$/.test(arg)).map(file => ({ name: path.resolve(args[1] === "--dir" ? args[2] : ".", file), status: "passed", startTime: 1, endTime: 6,
      assertionResults: [{ fullName: path.basename(file) + " works", status: "passed", duration: 4 }] })) }));' "$@"\n`
  await writeFile(join(bin, 'corepack'), '#!/bin/bash\necho "corepack $*"\n'
    + 'echo "CI shard ceiling $FOREMAN_CODE_CI_INTEGRATION_SHARDS"\n'
    + 'echo "CI budget $FOREMAN_CODE_CI_CPU_COUNT $FOREMAN_CODE_CI_MEMORY_BYTES $FOREMAN_CODE_VERIFICATION_UNIT_WORKERS"\n'
    + 'echo "CI database $FOREMAN_CODE_CI_DATABASE_CPUS $FOREMAN_CODE_CI_DATABASE_MEMORY_BYTES"\n'
    + 'if [ "$2" = test ] && [ -n "$FOREMAN_CODE_VITEST_CACHE" ]; then mkdir -p "$FOREMAN_CODE_VITEST_CACHE";'
    + ' echo "vitest cache entries $(ls "$FOREMAN_CODE_VITEST_CACHE" | wc -l)"; touch "$FOREMAN_CODE_VITEST_CACHE/$RANDOM$RANDOM"; fi\n'
    + `${integration}${unitReport}`
    + (options.inspectSource ? 'if [ "$2" = typecheck ]; then node program.mjs; fi\n' : '')
    + `if [ "$2" = db:up ]; then code=${options.databaseExit ?? 0};`
    + ' if [ "$code" = 0 ]; then touch "$TMPDIR/database-ready"; fi; exit "$code"; fi\n'
    + 'if [ "$2" = test ] || [ "$2" = test:integration ]'
    + ' || { [ "$2" = --dir ] && [ "$3" = apps/api ] && [ "$5" = vitest ]; }; then\n'
    + '  [ -f "$TMPDIR/database-ready" ] || exit 11\nfi\n'
    + 'if [ "$*" = "pnpm --filter @foreman-code/contracts build" ]; then exit 0; fi\n'
    + (options.watchdogReason ? `if [ -n "\${CI_WATCHDOG_MESSAGE_FILE:-}" ]; then printf '%s' '${JSON.stringify({ message: options.watchdogReason })}' > "$CI_WATCHDOG_MESSAGE_FILE"; echo '[ci-watchdog] ${options.watchdogReason}'; fi\n` : '')
    + 'if [ "$2" != install ] && [ "$2" != fetch ] && [ "$2" != db:up ]; then '
    + `${options.pause ? 'read -r pauseInput; ' : ''}exit ${options.suiteExit ?? 0}; fi\n`)
  await chmod(join(bin, 'corepack'), 0o755)
  for (const cli of ['codex', 'claude']) {
    await writeFile(join(bin, cli), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
  }
  let notifyUnitStarted!: () => void
  const unitStarted = new Promise<void>(resolve => { notifyUnitStarted = resolve })
  const units = new Map<string, ReturnType<typeof spawn>>()
  const system = systemHostCiPorts()
  const ports: HostCiPorts = { ...system, cpus: options.cpuCount ?? 8, memoryBytes: options.memoryBytes ?? 16 * 2 ** 30,
    availableMemoryBytes: () => options.memoryBytes ?? 16 * 2 ** 30,
    run: async (file, args, runOptions = {}) => {
      if (file === 'gh') return { code: options.github === false ? 1 : 0, stdout: '', stderr: '' }
      if (file === 'git' && args.some(value => value.startsWith('https://github.com/'))) {
        return system.run('git', args.map(value => value.startsWith('https://github.com/') ? origin : value), runOptions)
      }
      if (file === 'git' && args.includes('worktree') && args.includes('add')) await options.beforeCheckout?.()
      if (file === 'systemd-run') {
        const name = args.find(value => value.startsWith('--unit='))!.slice('--unit='.length)
        const env = Object.fromEntries(args.filter(value => value.startsWith('--setenv='))
          .map(value => value.slice('--setenv='.length).split(/=(.*)/s).slice(0, 2)))
        const cwd = args.find(value => value.startsWith('--working-directory='))!.slice('--working-directory='.length)
        const child = spawn('/bin/bash', [args.at(-1)!], { cwd, detached: true, env: { ...env, PATH: `${bin}:${process.env.PATH}` } })
        units.set(name, child)
        children.add(child)
        child.once('close', () => children.delete(child))
        child.on('exit', () => units.delete(name))
        notifyUnitStarted()
        return { code: 0, stdout: '', stderr: '' }
      }
      if (file === 'systemctl' && args.includes('show')) {
        const stdout = args.filter(arg => arg.endsWith('.service')).map(unit => {
          const state = units.has(unit.replace('.service', '')) ? 'active' : 'inactive'
          return `Id=${unit}\nLoadState=loaded\nActiveState=${state}\n`
        }).join('\n')
        return { code: 0, stdout, stderr: '' }
      }
      if (file === 'systemctl' && args.includes('stop')) {
        const child = units.get(args.at(-1)!.replace('.service', ''))
        if (child) await stopUnit(child)
        return { code: 0, stdout: '', stderr: '' }
      }
      return system.run(file, args, { ...runOptions, env: { ...environment, ...runOptions.env } })
    } }
  const runner = new HostCiRunner(join(root, 'ci'), ports, { ...environment, PATH: `${bin}:${process.env.PATH}` })
  const settle = (runId: string) => vi.waitFor(async () => {
    const reply = await runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 })
    if (reply.operation !== 'read' || ['starting', 'running'].includes(reply.run.state)) {
      throw new Error('The run did not settle.')
    }
    return reply
  }, { interval: 50, timeout: 10_000 })
  return { root, runner, commit, baseCommit, git, settle, units, unitStarted }
}

describe('host CI runner', () => {
  it('reads a locally preparing run without competing for its reconciliation lock', async () => {
    let entered!: () => void
    let release!: () => void
    const preparing = new Promise<void>(resolve => { entered = resolve })
    const released = new Promise<void>(resolve => { release = resolve })
    const f = await computer({ beforeCheckout: async () => {
      entered()
      await released
    } })
    const runId = randomUUID()
    const started = f.runner.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit,
      suite: 'unit', part: 'unit-api', partition: { index: 0, count: 2 } })
    try {
      await preparing
      const lockStarts = () => vi.mocked(spawn).mock.calls.filter(([file]) => file === '/usr/bin/flock').length
      const beforeReads = lockStarts()
      const replies = await Promise.all(Array.from({ length: 8 }, () =>
        f.runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 })))
      for (const reply of replies) expect(reply).toMatchObject({ operation: 'read', run: { runId, state: 'starting' } })
      expect(lockStarts() - beforeReads).toBe(0)
    } finally {
      release()
      await started
      expect((await f.settle(runId)).run).toMatchObject({ state: 'passed', step: 'unit-api' })
    }
  })

  it.each(['integration', 'unit'] as const)('passes each concurrent %s ticket its allowed slot share', async suite => {
    const gib = 2 ** 30
    const f = await computer({ cpuCount: 16, memoryBytes: 32 * gib, hostSlots: true, pause: true })
    const runIds = [randomUUID(), randomUUID()]
    const databaseCpus = suite === 'integration' ? 2 : 1
    const cpuBudget = 12 / 2 - databaseCpus
    const databaseMemory = suite === 'integration' ? 1.5 * gib : gib
    const memoryBudget = Math.floor(24 * gib * 0.9 / 2) - databaseMemory
    for (const runId of runIds) {
      await f.runner.handle({ operation: 'start', runId, repository: 'example/project', commit: f.commit,
        suite, scope: 'full', buildAllowancePercent: 75 })
      await vi.waitFor(async () => {
        const reply = await f.runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 })
        expect(reply).toMatchObject({ operation: 'read', run: { state: 'running' },
          text: expect.stringContaining(`CI budget ${cpuBudget} ${memoryBudget} ${cpuBudget}`) })
      })
    }
    expect(await f.runner.status()).toMatchObject({ slotsUsed: 2, slotsTotal: 2 })
    const plan = integrationShardPlan({ FOREMAN_CODE_CI_CPU_COUNT: String(cpuBudget),
      FOREMAN_CODE_CI_MEMORY_BYTES: String(memoryBudget) }, { cpuCount: 16, availableMemoryBytes: 32 * gib })
    expect(plan.shards).toBe(cpuBudget)
    expect(plan.limit).toBe(cpuBudget)
    for (const runId of runIds) await f.runner.cancel(runId)
  })

  it.each([false, true])('honors saved build allowances for integration starts with gate=%s', async gate => {
    const f = await computer({ cpuCount: 16, hostSlots: true })
    const runId = randomUUID()
    await f.runner.handle({ operation: 'start', runId, repository: 'example/project', commit: f.commit,
      suite: 'integration', scope: 'full', buildAllowancePercent: 50,
      ...(gate ? { gate: true, integrationShards: 32, files: ['apps/api/test/a.integration.test.ts'] } : {}) })
    const done = await f.settle(runId)
    expect(done.run.state).toBe('passed')
    const databaseCpus = gate ? 1 : 2
    const suiteMemoryGiB = 7 - databaseCpus
    expect(done.text).toContain(`CI database ${databaseCpus} ${databaseCpus * 2 ** 30}`)
    expect(done.text).toContain(`CI budget ${8 - databaseCpus} ${suiteMemoryGiB * 2 ** 30} ${suiteMemoryGiB}`)
    if (gate) expect(done.text).toContain('CI shard ceiling 4')
  })

  it('sizes the isolated integration database for the shards that share it', async () => {
    const f = await computer({ cpuCount: 16, hostSlots: true })
    const runId = randomUUID()
    await f.runner.handle({ operation: 'start', runId, repository: 'example/project', commit: f.commit,
      suite: 'integration', scope: 'full', gate: true, integrationShards: 16, files: ['apps/api/test/a.integration.test.ts'] })
    const done = await f.settle(runId)
    expect(done.run.state).toBe('passed')
    // Eight memory-limited shards share the database's unchanged per-shard CPU and memory limits.
    expect(done.text).toContain(`CI database 2 ${2 * 2 ** 30}`)
    expect(done.text).toContain('CI shard ceiling 8')
    expect(done.text).toContain('CI budget 14 ')
  })

  it('keeps the exclusive database fallback within the saved build allowance', async () => {
    const f = await computer({ cpuCount: 16 })
    const runId = randomUUID()
    await f.runner.handle({ operation: 'start', runId, repository: 'example/project', commit: f.commit,
      suite: 'integration', scope: 'full', buildAllowancePercent: 50 })
    const done = await f.settle(runId)
    expect(done.run.state).toBe('passed')
    expect(done.text).toContain(`CI budget 8 ${7 * 2 ** 30} 7`)
  })

  it('passes the admitted slot share to integration sizing and Vitest workers', async () => {
    const f = await computer({ cpuCount: 16, hostSlots: true })
    const runId = randomUUID()
    await f.runner.handle({ operation: 'start', runId, repository: 'example/project', commit: f.commit,
      suite: 'integration', scope: 'full' })
    const done = await f.settle(runId)
    expect(done.run.state).toBe('passed')
    expect(done.text).toContain(`CI budget 6 ${Math.floor(16 * 2 ** 30 * 0.9 / 2) - 2 * 2 ** 30} 5`)
    expect(done.text).toContain('corepack pnpm db:down')
  })

  it('selects changes since an explicit base even when the resolved commit is the default branch head', async () => {
    const f = await computer({ selector: true, change: 'source' })
    f.git('update-ref', 'refs/heads/main', f.commit)
    const runId = randomUUID()
    await f.runner.handle({ operation: 'start', runId, repository: 'example/project', commit: f.commit,
      baseCommit: f.baseCommit, suite: 'unit', part: 'unit-api', scope: 'affected' })
    const done = await f.settle(runId)
    expect(done.run).toMatchObject({ state: 'passed',
      message: 'Selected 1 affected files for unit-api: Static import reachability from changed files.' })
    expect(done.text).toContain('vitest run test/first.test.ts')
    expect(done.text).not.toContain('second.test.ts')
    expect(done.text).not.toContain('Running full suite:')
  })

  it.each(['unavailable', 'non-ancestor'] as const)('runs the full suite with a reason for an %s base', async kind => {
    const f = await computer({ selector: true, change: 'source' })
    f.git('commit', '--allow-empty', '-qm', 'later commit')
    const baseCommit = kind === 'unavailable' ? 'f'.repeat(40) : f.git('rev-parse', 'HEAD')
    const runId = randomUUID()
    await f.runner.handle({ operation: 'start', runId, repository: 'example/project', commit: f.commit,
      baseCommit, suite: 'unit', scope: 'affected' })
    const done = await f.settle(runId)
    expect(done.run).toMatchObject({ state: 'passed',
      message: 'Running full suite: baseCommit is unavailable or is not an ancestor of the resolved commit.' })
    expect(done.text).toContain('corepack pnpm test')
    expect(done.text).toContain('Running full suite:')
  })

  it('treats the resolved commit itself as a valid base with no changes', async () => {
    const f = await computer({ selector: true, change: 'source' })
    const runId = randomUUID()
    await f.runner.handle({ operation: 'start', runId, repository: 'example/project', commit: f.commit,
      baseCommit: f.commit, suite: 'unit' })
    const done = await f.settle(runId)
    expect(done.run).toMatchObject({ state: 'passed', message: 'No affected files for this suite part.' })
    expect(done.text).not.toContain('corepack pnpm test')
  })

  it('derives omitted files against a non-main workspace default branch and selects the unit part', async () => {
    const f = await computer({ selector: true, change: 'source', defaultBranch: 'release/stable' })
    const runId = randomUUID()
    await f.runner.handle({ operation: 'start', runId, repository: 'example/project', commit: f.commit,
      suite: 'unit', part: 'unit-api', defaultBranch: 'release/stable' })
    const done = await f.settle(runId)
    expect(done.run).toMatchObject({ state: 'passed',
      message: 'Selected 1 affected files for unit-api: Static import reachability from changed files.' })
    expect(done.text).toContain('corepack pnpm --dir apps/api exec vitest run test/first.test.ts')
    expect(done.text).not.toContain('second.test.ts')
    expect(done.text).not.toContain('apps/web')
  })

  it('preserves affected selections with more than 2000 files', async () => {
    const f = await computer({ selector: true, change: 'source', affectedUnitTests: 2001 })
    const runId = randomUUID()
    await f.runner.handle({ operation: 'start', runId, repository: 'example/project', commit: f.commit,
      suite: 'unit', part: 'unit-api' })
    const done = await f.settle(runId)
    expect(done.run).toMatchObject({ state: 'passed' })
    expect(done.run.message).toBe('Selected 2002 affected files for unit-api: Static import reachability from changed files.')
    expect(done.text).toContain('many-2000.test.ts')
    expect(done.text).not.toContain('Running full suite:')
  }, 30_000)

  it.each(['docs', 'source'] as const)('passes an empty affected unit shard after a %s change without running the suite', async change => {
    const f = await computer({ selector: true, change })
    const runId = randomUUID()
    await f.runner.handle({ operation: 'start', runId, repository: 'example/project', commit: f.commit,
      suite: 'unit', part: 'unit-api', partition: { index: 1, count: 5 } })
    const done = await f.settle(runId)
    expect(done.run).toMatchObject({ state: 'passed', exitCode: 0, message: 'No affected files for this suite part.' })
    expect(done.text).not.toContain('vitest run')
    expect(done.text).not.toContain('corepack pnpm test')
  })

  it.each([
    [{}, 'no affected selector'],
    [{ selector: true }, 'workspace default branch head'],
    [{ selector: true, change: 'infrastructure' as const }, 'Shared CI infrastructure changed'],
  ])('runs the full suite and reports the fallback for %j', async (options, reason) => {
    const f = await computer(options)
    const runId = randomUUID()
    await f.runner.handle({ operation: 'start', runId, repository: 'example/project', commit: f.commit, suite: 'unit' })
    const done = await f.settle(runId)
    expect(done.run.state).toBe('passed')
    expect(done.run.message).toContain(reason)
    expect(done.text).toContain('Running full suite:')
    expect(done.text).toContain('corepack pnpm test')
  })

  it('runs explicit full scope even when the repository selector would select one test', async () => {
    const f = await computer({ selector: true, change: 'source' })
    const runId = randomUUID()
    await f.runner.handle({ operation: 'start', runId, repository: 'example/project', commit: f.commit,
      suite: 'unit', scope: 'full' })
    const done = await f.settle(runId)
    expect(done.run.state).toBe('passed')
    expect(done.text).toContain('corepack pnpm test')
    expect(done.text).not.toContain('Selected 1 affected')
  })

  it('derives affected integration files and lets an excess partition complete without running tests', async () => {
    const f = await computer({ selector: true, change: 'source' })
    for (const index of [0, 1]) {
      const runId = randomUUID()
      await f.runner.handle({ operation: 'start', runId, repository: 'example/project', commit: f.commit,
        suite: 'integration', partition: { index, count: 2 } })
      const done = await f.settle(runId)
      expect(done.run.state).toBe('passed')
      if (index === 0) expect(done.text).toContain('corepack pnpm test:integration --files apps/api/test/a.integration.test.ts')
      else expect(done.text).not.toContain('corepack pnpm test:integration')
    }
  })
  it.each([
    ['unit', undefined, true], ['unit', 'unit-api', true], ['integration', undefined, true],
    ['unit', 'unit-web', false], ['unit', 'unit-web-heavy', false], ['unit', 'unit-other', true],
    ['lint', 'lint-api', false], ['typecheck', 'typecheck-api', false], ['build', 'build-api', false],
  ])('prepares the database for %s/%s only when needed', async (suite, part, databaseRequired) => {
    const f = await computer()
    const runId = randomUUID()
    await f.runner.handle({ operation: 'start', runId, repository: 'example/project', commit: f.commit,
      suite, ...(part ? { part } : {}) })
    const done = await f.settle(runId)
    expect(done.run.state).toBe('passed')
    if (part === 'unit-other') {
      expect(done.text).toContain('corepack pnpm --filter @foreman-code/contracts test')
      expect(done.text).toContain('--test-reporter=spec')
      expect(done.text).toContain('scripts/**/*.test.mjs')
    }
    const database = done.text.indexOf('corepack pnpm db:up')
    if (databaseRequired) {
      expect(database).toBeGreaterThan(done.text.indexOf('corepack pnpm install --frozen-lockfile'))
      expect(done.text.slice(database + 'corepack pnpm db:up'.length)).toContain('corepack pnpm')
    } else {
      expect(database).toBe(-1)
    }
  })

  it('stops before the unit part when database preparation fails', async () => {
    const f = await computer({ databaseExit: 9 })
    const runId = randomUUID()
    await f.runner.handle({ operation: 'start', runId, repository: 'example/project', commit: f.commit,
      suite: 'unit', part: 'unit-api' })
    const done = await f.settle(runId)
    expect(done.run).toMatchObject({ state: 'failed', exitCode: 9, step: 'prepare' })
    expect(done.text).toContain('corepack pnpm db:up')
    expect(done.text).not.toContain('corepack pnpm test')
  })

  it.each([
    ['lint-api', 'lint', '--filter @foreman-code/api lint'],
    ['lint-other', 'lint', '-r --no-bail --filter !@foreman-code/api --if-present lint'],
    ['typecheck-api', 'typecheck', '--filter @foreman-code/api typecheck'],
    ['typecheck-other', 'typecheck', '-r --filter !@foreman-code/api --if-present typecheck'],
    ['build-api', 'build', '--filter @foreman-code/api build'],
    ['build-other', 'build', '-r --filter !@foreman-code/api --if-present build'],
  ])('executes %s with the package commands used by the cloud suite', async (part, suite, command) => {
    const f = await computer()
    const runId = randomUUID()
    await f.runner.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit, suite, part })
    const done = await f.settle(runId)
    expect(done.run).toMatchObject({ state: 'passed', step: part })
    expect(done.text).toContain(`corepack pnpm ${command}`)
  })

  it.each(['unit-api', 'unit-web'])('executes every file once across %s shards and reports timings', async part => {
    const f = await computer()
    const measured: string[] = []
    for (const index of [0, 1]) {
      const runId = randomUUID()
      await f.runner.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit,
        suite: 'unit', part, partition: { index, count: 2 } })
      expect((await f.settle(runId)).run).toMatchObject({ state: 'passed', step: part })
      const result = await f.runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1, durations: true })
      expect(result.operation).toBe('read')
      if (result.operation === 'read') measured.push(...Object.keys(result.durations!))
    }
    const project = part === 'unit-api' ? 'apps/api/test' : 'apps/web/src'
    const extension = part === 'unit-api' ? 'ts' : 'tsx'
    expect(measured.sort()).toEqual([`${project}/first.test.${extension}`, `${project}/second.test.${extension}`])
  })

  it.each([['full part', {}], ['affected selection', { scope: 'affected' as const,
    files: ['apps/api/test/first.test.ts', 'apps/api/test/second.test.ts'] }]])('reports structured test results of a unit-api %s', async (_kind, selection) => {
    const f = await computer()
    const runId = randomUUID()
    await f.runner.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit,
      suite: 'unit', part: 'unit-api', ...selection })
    expect((await f.settle(runId)).run).toMatchObject({ state: 'passed', step: 'unit-api' })
    const result = await f.runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1, testResults: true })
    expect(result.operation === 'read' && result.testResults).toEqual({ summary: { passed: 2, failed: 0, skipped: 0 },
      truncated: false, files: ['first', 'second'].map(name => ({ file: `apps/api/test/${name}.test.ts`, status: 'passed',
        durationMs: 5, tests: [{ name: `${name}.test.ts works`, status: 'passed', durationMs: 4 }] })) })
    // A Main from before test results asks only for durations and gets the reply shape it knows.
    const durations = await f.runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1, durations: true })
    expect(durations.operation === 'read' && 'testResults' in durations).toBe(false)
  })

  it('preserves a failing unit part exit code after collecting its durations', async () => {
    const f = await computer({ suiteExit: 7 })
    const runId = randomUUID()
    await f.runner.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit,
      suite: 'unit', part: 'unit-web', partition: { index: 0, count: 2 } })
    expect((await f.settle(runId)).run).toMatchObject({ state: 'failed', exitCode: 7, step: 'unit-web' })
  })

  it('executes an affected unit part selection without slicing it again', async () => {
    const f = await computer()
    const runId = randomUUID()
    await f.runner.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit,
      suite: 'unit', part: 'unit-api', partition: { index: 1, count: 2 }, scope: 'affected',
      files: ['apps/api/test/first.test.ts'] })
    const done = await f.settle(runId)
    expect(done.run).toMatchObject({ state: 'passed', step: 'unit-api' })
    expect(done.text).toContain('corepack pnpm --dir apps/api exec vitest run test/first.test.ts')
    expect(done.text).not.toContain('test/second.test.ts')
  })

  it('executes the accepted commit after the original checkout changes', async () => {
    const f = await computer({ inspectSource: true })
    const origin = join(f.root, 'origin')
    await writeFile(join(origin, 'dependency.mjs'), 'export const value = 2\n')
    await writeFile(join(origin, 'program.mjs'),
      "import {value} from './dependency.mjs'; process.stdout.write(JSON.stringify({value}))\n")
    const runId = randomUUID()
    await f.runner.handle({ operation: 'start', runId, repository: 'example/project',
      commit: f.commit, suite: 'typecheck', scope: 'full' })
    const done = await f.settle(runId)
    expect(done.run).toMatchObject({ state: 'passed', exitCode: 0 })
    expect(done.text).toContain('{"value":1}')
    expect(done.text).not.toContain('{"value":2}')
    expect(f.git('rev-parse', 'HEAD')).toBe(f.commit)
    const current = execFileSync(process.execPath, ['program.mjs'], { cwd: origin, encoding: 'utf8' })
    expect(JSON.parse(current)).toEqual({ value: 2 })
  })

  it('fetches the commit, installs and runs the suite in its own checkout, then frees its slot', async () => {
    const f = await computer()
    const runId = randomUUID()
    const started = await f.runner.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit, suite: 'unit' })
    expect(started).toMatchObject({ operation: 'start', run: { runId, state: expect.stringMatching(/starting|running/) } })
    const done = await f.settle(runId)
    expect(done.run).toMatchObject({ state: 'passed', exitCode: 0, step: 'unit' })
    expect(done.text).toContain('corepack pnpm install --frozen-lockfile')
    expect(done.text).toContain('corepack pnpm test')
    expect(await f.runner.status()).toMatchObject({ slotsUsed: 0 })
    // A retried start returns the same run instead of starting it again.
    expect(await f.runner.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit, suite: 'unit' }))
      .toMatchObject({ run: { runId, state: 'passed' } })
  })

  it('keeps the Vitest transform cache for the next part that holds the same checkout slot', async () => {
    const f = await computer()
    const entries: number[] = []
    for (let part = 0; part < 2; part++) {
      const runId = randomUUID()
      await f.runner.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit, suite: 'unit' })
      const done = await f.settle(runId)
      expect(done.run.state).toBe('passed')
      entries.push(Number(/vitest cache entries (\d+)/.exec(done.text)?.[1]))
    }
    expect(entries[0]).toBe(0)
    expect(entries[1]).toBeGreaterThan(0)
  })

  it('reports a failing suite with its exit code and step', async () => {
    const f = await computer({ suiteExit: 3 })
    const runId = randomUUID()
    await f.runner.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit, suite: 'typecheck' })
    expect((await f.settle(runId)).run).toMatchObject({ state: 'failed', exitCode: 3, step: 'typecheck' })
  })

  it('runs a duration-balanced slice of the integration files after starting the database', async () => {
    const f = await computer()
    const slices: string[][] = []
    for (const index of [0, 1]) {
      const runId = randomUUID()
      await f.runner.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit, suite: 'integration',
        partition: { index, count: 2 }, durations: {
          'apps/api/test/a.integration.test.ts': 400, 'apps/api/test/b.integration.test.ts': 300,
          'apps/api/test/c.integration.test.ts': 200, 'apps/api/test/d.integration.test.ts': 100 } })
      const done = await f.settle(runId)
      expect(done.run.state).toBe('passed')
      expect(done.text).toContain('corepack pnpm db:up')
      slices.push([...done.text.matchAll(/apps\/api\/test\/(\w)\.integration/g)].map(match => match[1]!))
    }
    expect(slices.flat().sort()).toEqual(['a', 'b', 'c', 'd'])
    expect(slices.map(slice => slice.sort())).toEqual([['a', 'd'], ['b', 'c']])
  })

  it('splits and times integration files by Main\'s learned durations and reports the durations it measured', async () => {
    const measured = { 'apps/api/test/d.integration.test.ts': 870 }
    const f = await computer({ measured })
    // The database snapshot makes d the slowest file and a the fastest.
    const durations = { 'apps/api/test/a.integration.test.ts': 50, 'apps/api/test/b.integration.test.ts': 300,
      'apps/api/test/c.integration.test.ts': 200, 'apps/api/test/d.integration.test.ts': 900 }
    const slices: string[][] = []
    for (const index of [0, 1]) {
      const runId = randomUUID()
      await f.runner.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit, suite: 'integration',
        partition: { index, count: 2 }, durations })
      const done = await f.settle(runId)
      expect(done.run.state).toBe('passed')
      expect(done.durations).toBeUndefined()
      const command = done.text.split('\n').find(line => line.startsWith('corepack pnpm test:integration'))!
      slices.push([...command.matchAll(/apps\/api\/test\/(\w)\.integration/g)].map(match => match[1]!).sort())
      const expected = JSON.parse(done.text.split('\n').find(line => line.startsWith('expected '))!.slice('expected '.length))
      expect(expected).toEqual(durations)
      expect(await f.runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1, durations: true }))
        .toMatchObject({ operation: 'read', durations: measured })
    }
    expect(slices).toEqual([['d'], ['a', 'b', 'c']])
  })

  it('runs one suite at a time and stops a run on cancel', async () => {
    const f = await computer({ pause: true })
    const first = randomUUID()
    await f.runner.handle({ operation: 'start', runId: first, repository: 'octo/site', commit: f.commit, suite: 'lint' })
    await f.unitStarted
    await expect(f.runner.handle({ operation: 'start', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'unit' })).rejects.toMatchObject({ code: 'CI_HOST_BUSY' })
    const canceled = await f.runner.handle({ operation: 'cancel', runId: first })
    expect(canceled).toMatchObject({ run: { state: 'canceled' } })
    expect(f.units.size).toBe(0)
  })

  it('refuses to start without a GitHub login and says how to fix it', async () => {
    const f = await computer({ github: false })
    await expect(f.runner.handle({ operation: 'start', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'unit' })).rejects.toMatchObject({ code: 'COMPUTER_GITHUB_REQUIRED' })
    const status = await f.runner.handle({ operation: 'status' })
    expect(status).toMatchObject({ operation: 'status', ready: false, cpuCount: 8 })
    expect(status.operation === 'status' && status.reasons.join(' ')).toContain('gh auth login')
    expect(await readdir(join(f.root, 'ci')).catch(() => [])).not.toContain('runs')
  })

  it('marks a run lost when its unit ends without an exit status', async () => {
    const f = await computer({ pause: true })
    const runId = randomUUID()
    await f.runner.handle({ operation: 'start', runId, repository: 'octo/site', commit: f.commit, suite: 'build' })
    await f.unitStarted
    await Promise.all([...f.units.values()].map(stopUnit))
    expect((await f.settle(runId)).run).toMatchObject({ state: 'lost', exitCode: null })
    expect(await f.runner.handle({ operation: 'status' }))
      .toMatchObject({ slotsUsed: 0, runs: [expect.objectContaining({ runId, state: 'lost' })] })
  })
})


it('returns the saved watchdog reason with the failed build-computer ticket and logs', async () => {
  const reason = 'CI hang watchdog: no test progress for 60000 ms; running: loop.test.ts > planner never returns'
  const f = await computer({ suiteExit: 1, watchdogReason: reason })
  const runId = randomUUID()
  await f.runner.handle({ operation: 'start', runId, repository: 'example/project', commit: f.commit,
    suite: 'typecheck', expectedDurationMs: 150_000 })
  const result = await f.settle(runId)
  expect(result.run).toMatchObject({ state: 'failed', exitCode: 1, message: reason })
  expect(result.text).toContain(reason)
  const reopened = new HostCiRunner(join(f.root, 'ci'))
  expect(await reopened.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 }))
    .toMatchObject({ run: { state: 'failed', message: reason } })
})
