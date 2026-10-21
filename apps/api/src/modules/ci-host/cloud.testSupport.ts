import { execFile, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach } from 'vitest'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import type { GitWorktreePorts } from '../sources/gitWorktree.js'
import { CloudCi } from './cloud.js'
import { pruneMirrorBranches } from './mirrorBranches.js'
import { CircleCiProvider, GitHubActionsProvider, type CloudProvider } from './cloudProviders.js'
import { systemHostCiPorts, type HostCiPorts } from './runner.js'

const disposals: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose()
})

type GitHubListedRun = { databaseId: number; displayTitle: string; headSha?: string }

function githubListing(github: { listed: GitHubListedRun[]; status: string }, dispatched: string[][],
  commit: (branch: string) => string, path?: string) {
  const page = path ? Number(new URL(path, 'https://api.github.com').searchParams.get('page')) : null
  const selected = page === null ? github.listed : github.listed.slice((page - 1) * 100, page * 100)
  const listed = selected.map(value => {
    const command = dispatched.find(args => args.includes(`run_id=${value.displayTitle.slice(3)}`))
    const branch = command?.[command.indexOf('--ref') + 1] ?? 'main'
    return { ...value, headSha: value.headSha ?? commit(branch) }
  })
  if (!path) return JSON.stringify(listed)
  return JSON.stringify({ total_count: github.listed.length,
    workflow_runs: listed.map(value => ({ id: value.databaseId, display_title: value.displayTitle,
      status: github.status, head_sha: value.headSha })) })
}

/** A private repository and its public mirror as local bare repositories standing in for GitHub, with a gh that
 * records dispatches and replays the run states a test sets. */
export async function fixture(files: Record<string, string> = {}, options: { mirror?: boolean; provider?: 'github' | 'circleci'
  mirrorWorkflows?: boolean; sourceWorkflows?: boolean; userSystemd?: boolean; account?: string } = {}) {
  await mkdir(process.env.FOREMAN_CODE_TEST_ROOT ?? join(homedir(), '.cache', 'foreman-tmp'), { recursive: true })
  const root = await mkdtemp(join(process.env.FOREMAN_CODE_TEST_ROOT ?? join(homedir(), '.cache', 'foreman-tmp'), 'cloud-ci-'))
  const cleanupHooks: { waitForCleanup?: () => Promise<void> } = {}
  const dispose = async () => {
    await cleanupHooks.waitForCleanup?.()
    await rm(root, { recursive: true, force: true })
  }
  disposals.push(dispose)
  const environment = gitFixtureEnvironment()
  const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: environment, encoding: 'utf8' }).trim()
  const work = join(root, 'work'), mirrorWork = join(root, 'mirror-work')
  const origin = join(root, 'origin.git'), mirror = join(root, 'mirror.git'), accountMirror = join(root, 'account-mirror.git')
  for (const path of [work, mirrorWork]) await mkdir(path)
  run(root, 'init', '-q', '--bare', origin); run(root, 'init', '-q', '--bare', mirror)
  // The mirror starts from one import commit without the private history.
  run(mirrorWork, 'init', '-q', '-b', 'main'); await writeFile(join(mirrorWork, 'README.md'), 'import\n')
  const workflows = { '.github/workflows/ci.yml': 'name: CI\non: workflow_dispatch\n',
    '.circleci/config.yml': 'version: 2.1\n' }
  for (const [path, text] of Object.entries(workflows)) {
    if (options.mirrorWorkflows === false) continue
    await mkdir(join(mirrorWork, path, '..'), { recursive: true })
    await writeFile(join(mirrorWork, path), text)
  }
  run(mirrorWork, 'add', '.'); run(mirrorWork, 'commit', '-qm', 'Initial import'); run(mirrorWork, 'push', '-q', mirror, 'main')
  // A further CircleCI org (options.account) has its own copy of the mirror at `<account>/site-ci`.
  if (options.account) { run(root, 'init', '-q', '--bare', accountMirror); run(mirrorWork, 'push', '-q', accountMirror, 'main') }
  run(work, 'init', '-q', '-b', 'main')
  await writeFile(join(work, 'secret-history.txt'), 'old\n'); run(work, 'add', '.'); run(work, 'commit', '-qm', 'private history')
  await rm(join(work, 'secret-history.txt'))
  await mkdir(join(work, 'apps/api/test'), { recursive: true }); await mkdir(join(work, 'scripts'))
  for (const name of ['a', 'b', 'c', 'd']) await writeFile(join(work, `apps/api/test/${name}.integration.test.ts`), '')
  await writeFile(join(work, 'scripts/integration-durations.json'), JSON.stringify({ 'apps/api/test/a.integration.test.ts': 400,
    'apps/api/test/b.integration.test.ts': 300, 'apps/api/test/c.integration.test.ts': 200, 'apps/api/test/d.integration.test.ts': 100 }))
  for (const [path, text] of Object.entries(workflows)) {
    if (options.sourceWorkflows === false) continue
    await mkdir(join(work, path, '..'), { recursive: true })
    await writeFile(join(work, path), text)
  }
  for (const [path, text] of Object.entries(files)) await writeFile(join(work, path), text)
  run(work, 'add', '-A'); run(work, 'commit', '-qm', 'change'); run(work, 'push', '-q', origin, 'main')
  const commit = run(work, 'rev-parse', 'HEAD')
  const local = (value: string) => value === 'https://github.com/octo/site.git' ? origin
    : value === 'https://github.com/octo/site-ci.git' ? mirror : value === `https://github.com/${options.account}/site-ci.git` ? accountMirror : value
  const cleanup = { unavailable: false, failures: 0 }
  const git: GitWorktreePorts = {
    cloneDirectory: repository => join(root, 'clones', ...repository.split('/')),
    // Asynchronous like Main's git, so concurrent starts really overlap.
    git: (args, options) => new Promise(resolve => {
      if (cleanup.unavailable && args[0] === 'push' && args.includes('--atomic')) {
        cleanup.failures++
        resolve({ code: 1, stdout: '', stderr: 'fixture remote is unavailable for cleanup' })
        return
      }
      execFile('git', args.map(local), { cwd: options.cwd, env: { ...environment, ...options.env }, encoding: 'utf8' },
        (error, stdout, stderr) => {
          resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr })
        })
    }),
  }
  const dispatched: string[][] = []
  const github = { listed: [] as GitHubListedRun[], status: 'in_progress', conclusion: '',
    durations: null as Record<string, number> | null, testResults: null as unknown, canceled: [] as string[],
    steps: [] as { number: number; name: string; status: string; conclusion: string | null }[],
    watchdogFailure: null as unknown, suiteLog: '', log: 'ci\tSuite\tall green\n', rateLimited: false, jobReads: [] as ('full' | 'unchanged')[], artifactError: '', logError: '' }
  const githubRuns = (path?: string) => githubListing(github, dispatched,
    branch => run(mirror, 'rev-parse', branch), path)
  const circle = { triggered: [] as string[][], outcome: '' as string, durations: null as Record<string, number> | null,
    testResults: null as unknown, watchdogFailure: null as unknown, log: 'Suite\nall green\n',
    artifacts: null as Record<string, unknown> | null, rawOutput: null as string | null,
    phantoms: 0, lookupError: '', cancelError: '', canceled: [] as string[], runView: null as unknown,
    jobDetails: {} as Record<string, unknown>,
    steps: [] as { num: number; name: string; phase: string; outcome?: string }[], output: '',
    downloaded: [] as string[], downloadGate: Promise.resolve() as Promise<void>, artifactError: '', logError: '' }
  let now = Date.now()
  const system = systemHostCiPorts()
  const ports: HostCiPorts = { ...system, now: () => new Date(now), run: async (file, args) => {
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
    if (file === 'tailscale') return ok(JSON.stringify({ MagicDNSSuffix: 'tail0000.ts.net',
      Self: { HostName: 'owner-desktop', TailscaleIPs: ['100.90.1.2', 'fd7a::1'] },
      Peer: { a: { HostName: 'builder-Laptop', TailscaleIPs: ['100.90.1.3'] } }, User: { 1: { LoginName: 'owner@example.org' } } }))
    if (file === 'circleci') {
      if (args[0] === 'auth') return ok()
      if (args[0] === 'run' && args[1] === 'trigger') {
        circle.triggered.push([...args])
        return ok(JSON.stringify({ id: `run-${circle.triggered.length}` }))
      }
      if (args[0] === 'run' && args[1] === 'get') {
        if (circle.lookupError) return { code: 1, stdout: '', stderr: circle.lookupError }
        const phantom = Number(args[2]!.slice('run-'.length)) <= circle.phantoms
        return ok(JSON.stringify(circle.runView ?? (phantom ? { phase: 'created', workflows: [] }
          : { workflows: [{ jobs: [{ id: 'job-1' }] }] })))
      }
      if (args[0] === 'run' && args[1] === 'cancel') {
        circle.canceled.push(args[2]!)
        if (circle.cancelError) return { code: 1, stdout: '', stderr: circle.cancelError }
        return ok()
      }
      if (args[0] === 'job' && args[1] === 'get') return ok(JSON.stringify(circle.jobDetails[args[2]!] ??
        { executions: [{ steps: circle.steps }], ...circle.outcome
        ? { phase: 'ended', outcome: circle.outcome, stopped_at: '2026-10-11T02:00:00Z' } : { phase: 'started' } }))
      if (args[0] === 'job' && args[1] === 'output' && args[2] === 'get') {
        return ok(args.includes('--strip-ansi=false') ? circle.rawOutput ?? circle.output : circle.output)
      }
      // The CLI's default view keeps only each step's last lines.
      if (args[0] === 'job' && args[1] === 'output') {
        if (circle.logError) return { code: 1, stdout: '', stderr: circle.logError }
        return ok(args[args.indexOf('--tail') + 1] === '0' ? circle.log : '_… 1 earlier lines hidden_\nall green\n')
      }
      if (args[0] === 'job' && args[1] === 'artifact' && circle.artifactError) {
        return { code: 1, stdout: '', stderr: circle.artifactError }
      }
      if (args[0] === 'job' && args[1] === 'artifact' && args.includes('--json')) {
        if (!circle.artifacts && !circle.durations && !circle.testResults && !circle.watchdogFailure) return ok('[]')
        const listed = circle.artifacts ? Object.keys(circle.artifacts)
          : [...circle.watchdogFailure ? ['durations/watchdog-message.json'] : [], 'durations/durations.json', ...circle.testResults ? ['durations/test-results.json'] : [],
          'integration-logs/run/slot-1/a.integration.test.ts.log']
        return ok(JSON.stringify(listed.map(path => ({ path, url: `https://artifacts.example/${path}`, execution: 0 }))))
      }
      return { code: 1, stdout: '', stderr: `unexpected circleci ${args.join(' ')}` }
    }
    if (file === 'curl') {
      const url = args.at(-1)!
      circle.downloaded.push(url)
      await circle.downloadGate
      const path = new URL(url).pathname.slice(1)
      const reports: Record<string, unknown> = { 'watchdog-message.json': circle.watchdogFailure,
        'durations.json': circle.durations, 'test-results.json': circle.testResults }
      const body = circle.artifacts ? circle.artifacts[path] : reports[basename(path)]
      await writeFile(args[args.indexOf('-o') + 1]!, typeof body === 'string' ? body : JSON.stringify(body))
      return ok()
    }
    if (file !== 'gh') return system.run(file, args)
    if (args[0] === 'auth') return ok()
    if (args[0] === 'workflow') { dispatched.push([...args]); return ok() }
    if (args[0] === 'api') {
      if (github.rateLimited) return { code: 1, stdout: 'HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Remaining: 0\r\n\r\n{}',
        stderr: 'gh: API rate limit exceeded for user ID 1. (HTTP 403)' }
      if (args[1]?.includes('/actions/workflows/ci.yml/runs?')) return ok(githubRuns(args[1]))
      const body = JSON.stringify({ jobs: [{ id: 1, status: github.status === 'completed' || github.status === 'queued' ? github.status : 'in_progress',
        steps: github.steps }] })
      const etag = `"${createHash('sha1').update(body).digest('hex')}"`
      if (args.some(value => value.startsWith('If-None-Match:') && value.endsWith(etag))) {
        github.jobReads.push('unchanged')
        return { code: 1, stdout: `HTTP/2.0 304 Not Modified\r\nEtag: ${etag}\r\n\r\n`, stderr: 'gh: HTTP 304' }
      }
      github.jobReads.push('full')
      return ok(`HTTP/2.0 200 OK\r\nEtag: W/${etag}\r\n\r\n${body}`)
    }
    if (args[1] === 'list') return ok(githubRuns())
    if (args[1] === 'cancel') { github.canceled.push(args[2]!); return ok() }
    if (args[1] === 'view' && args.includes('--log')) {
      return github.logError ? { code: 1, stdout: '', stderr: github.logError } : ok(github.log)
    }
    if (args[1] === 'view') return ok(JSON.stringify({ status: github.status, conclusion: github.conclusion, updatedAt: new Date().toISOString() }))
    if (args[1] === 'download') {
      if (github.artifactError) return { code: 1, stdout: '', stderr: github.artifactError }
      if (!github.durations && !github.watchdogFailure) return { code: 1, stdout: '', stderr: 'no artifact' }
      const directory = args[args.indexOf('-D') + 1]!
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'durations.json'), JSON.stringify(github.durations))
      if (github.watchdogFailure) await writeFile(join(directory, 'watchdog-message.json'), JSON.stringify(github.watchdogFailure))
      if (github.suiteLog) await writeFile(join(directory, 'suite.log'), github.suiteLog)
      if (github.testResults) await writeFile(join(directory, 'test-results.json'), JSON.stringify(github.testResults))
      return ok()
    }
    return { code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` }
  } }
  const provider: CloudProvider = options.provider === 'circleci' || options.account ? new CircleCiProvider(ports, { circleToken: async () => null },
    options.account ? { owner: options.account, mirrorNames: new Set(['site-ci']) } : undefined) : new GitHubActionsProvider(ports)
  if (options.userSystemd === false) {
    Object.defineProperty(provider, 'userSystemd', {
      value: { supported: false, reason: 'Executor has no systemd user manager' },
    })
  }
  const reopen = () => new CloudCi('main-1', provider, async workspaceId => options.mirror === false ? null
    : workspaceId === 'ci-workspace' ? 'octo/site-ci' : null, join(root, 'ci-cloud'), ports, git,
    { home: '/home/owner', user: 'owner', host: 'owner-desktop' })
  const cloud = reopen()
  cleanupHooks.waitForCleanup = () => cloud.waitForMirrorCleanup('octo/site', 'octo/site-ci')
  const mirrorGit = (...args: string[]) => run(mirror, ...args)
  return { cloud, reopen, root, commit, ports, dispatched, github, circle, cleanup, git, mirrorGit, dispose, account: provider.account,
    run: (...args: string[]) => run(work, ...args), accountMirrorGit: (...args: string[]) => run(accountMirror, ...args),
    async prune(activeIds: Set<string>) {
      return pruneMirrorBranches({ mirror: 'octo/site-ci', roots: [join(root, 'ci-cloud')],
        activeRuns: { ids: activeIds, readAt: Date.now() },
        git: async args => {
          const result = await git.git(args, { cwd: work, signal: AbortSignal.timeout(30_000) })
          if (result.code !== 0) throw new Error(result.stderr)
          return result.stdout.trim()
        } })
    },
    advance: (milliseconds: number) => { now += milliseconds },
    write: (path: string, text: string) => writeFile(join(work, path), text),
    push: (...refs: string[]) => run(work, 'push', '-q', origin, ...refs),
    async checkoutMirror(ref: string) {
      const directory = await mkdtemp(join(root, 'checkout-'))
      run(root, 'clone', '-q', '--no-checkout', mirror, directory)
      run(directory, 'checkout', '-q', '--detach', run(mirror, 'rev-parse', ref))
      return directory
    } }
}


/** Requests cancellation, then exposes provider termination after the discovery window. */
export async function confirmCancellation(f: Awaited<ReturnType<typeof fixture>>, runId: string) {
  if (f.cloud.provider.id === 'github' && !f.github.listed.length) {
    f.github.listed = [{ databaseId: 8, displayTitle: `ci ${runId}` }]
  }
  await f.cloud.handle({ operation: 'cancel', runId })
  Object.assign(f.github, { status: 'completed', conclusion: 'cancelled' })
  f.circle.runView = { phase: 'ended', current_outcome: 'canceled', workflows: [] }
  f.advance(75_001)
  return f.cloud.handle({ operation: 'cancel', runId })
}
