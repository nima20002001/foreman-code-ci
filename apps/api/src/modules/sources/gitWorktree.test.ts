import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { captureGitSource } from './capture.js'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { addGitWorktree, ensureCommit, systemGitWorktreePorts, type GitWorktreePorts } from './gitWorktree.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8',
  env: gitFixtureEnvironment() }).trim()

it('joins cancelled Git acquisition before returning control to source cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-cancellation-'))
  roots.push(root)
  const bin = join(root, 'bin')
  const marker = join(root, 'started')
  await mkdir(bin)
  await writeFile(join(bin, 'git'), `#!${process.execPath}\n
require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);\n`, { mode: 0o700 })
  const environment = gitFixtureEnvironment()
  const ports = systemGitWorktreePorts({ ...environment, PATH: `${bin}:${environment.PATH}` })
  const lifetime = new AbortController()
  const task = ports.git(['status'], { signal: lifetime.signal })
  try {
    await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toMatch(/^\d+$/))
    const pid = Number(await readFile(marker, 'utf8'))
    lifetime.abort()
    expect((await task).code).not.toBe(0)
    let state = 'gone'
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]!
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    // A zombie has exited and released its files, even before its parent reaps it.
    expect(['gone', 'Z'], 'Git must have ended before acquisition returns').toContain(state)
  } finally {
    lifetime.abort()
    await task
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'git-worktree-')); roots.push(root)
  const origin = join(root, 'origin'); await mkdir(origin)
  git(origin, 'init', '-q', '-b', 'main')
  await writeFile(join(origin, 'README.md'), 'approved\n')
  git(origin, 'add', '.'); git(origin, 'commit', '-qm', 'approved')
  const commit = git(origin, 'rev-parse', 'HEAD')
  const system = systemGitWorktreePorts(gitFixtureEnvironment())
  // The clone reads from a local origin instead of github.com; everything else is the real git flow.
  const ports: GitWorktreePorts = { cloneDirectory: repository => join(root, 'clones', ...repository.split('/')),
    git: (args, options) => system.git(args[0] === 'clone' ? ['clone', '--no-checkout', origin, args.at(-1)!] : args, options) }
  return { root, origin, commit, ports }
}

it('gives each agent its own branch at the approved commit and keeps an earlier attempt\'s commits', async () => {
  const f = await fixture()
  const signal = AbortSignal.timeout(30_000)
  const first = await addGitWorktree(f.ports, { repository: 'octo/site', branch: 'foreman/review/coder-abc' }, f.commit, join(f.root, 'a'), signal)
  expect(first).toEqual({ branch: expect.stringMatching(/^foreman\/review\/coder-abc-[a-f0-9-]+$/), commit: f.commit })
  expect(await readFile(join(f.root, 'a', 'README.md'), 'utf8')).toBe('approved\n')
  await writeFile(join(f.root, 'a', 'work.txt'), 'agent work\n')
  git(join(f.root, 'a'), 'add', '.'); git(join(f.root, 'a'), 'commit', '-qm', 'agent work')
  const second = await addGitWorktree(f.ports, { repository: 'octo/site', branch: 'foreman/review/coder-abc' }, f.commit, join(f.root, 'b'), signal)
  expect(second.branch).not.toBe(first.branch)
  expect(git(join(f.root, 'b'), 'rev-parse', 'HEAD')).toBe(f.commit)
  expect(git(join(f.root, 'a'), 'log', '-1', '--format=%s')).toBe('agent work')
})

it('forgets worktrees whose Run directory was removed while keeping their branches', async () => {
  const f = await fixture()
  const signal = AbortSignal.timeout(30_000)
  const old = await addGitWorktree(f.ports, { repository: 'octo/site', branch: 'foreman/review/coder-old' }, f.commit, join(f.root, 'old'), signal)
  await rm(join(f.root, 'old'), { recursive: true, force: true })
  await addGitWorktree(f.ports, { repository: 'octo/site', branch: 'foreman/review/coder-new' }, f.commit, join(f.root, 'new'), signal)
  const clone = join(f.root, 'clones', 'octo', 'site')
  expect(git(clone, 'worktree', 'list')).not.toContain(join(f.root, 'old'))
  expect(git(clone, 'branch', '--list', old.branch)).toContain(old.branch)
})

it('refuses unsafe repository and branch names before running git', async () => {
  const f = await fixture()
  const signal = AbortSignal.timeout(10_000)
  await expect(addGitWorktree(f.ports, { repository: '../evil', branch: 'foreman/x' }, f.commit, join(f.root, 'x'), signal))
    .rejects.toMatchObject({ code: 'SOURCE_WORKTREE_INVALID' })
  await expect(addGitWorktree(f.ports, { repository: 'octo/site', branch: '--upload-pack=x' }, f.commit, join(f.root, 'x'), signal))
    .rejects.toMatchObject({ code: 'SOURCE_WORKTREE_INVALID' })
  await expect(addGitWorktree(f.ports, { repository: 'octo/site', branch: 'foreman/a..b' }, f.commit, join(f.root, 'x'), signal))
    .rejects.toMatchObject({ code: 'SOURCE_WORKTREE_INVALID' })
})

it('keeps fixture repositories independent of inherited CI Git routing and identity', async () => {
  vi.stubEnv('GIT_DIR', '/uncreated-ci-repository')
  vi.stubEnv('GIT_WORK_TREE', '/uncreated-ci-worktree')
  vi.stubEnv('GIT_AUTHOR_NAME', '')
  vi.stubEnv('GIT_COMMITTER_NAME', '')
  try {
    const f = await fixture()
    const path = join(f.root, 'agent')
    await addGitWorktree(f.ports, { repository: 'octo/site', branch: 'foreman/review/coder-ci' },
      f.commit, path, AbortSignal.timeout(30_000))
    expect(git(path, 'rev-parse', 'HEAD')).toBe(f.commit)
    expect(await readFile(join(path, 'README.md'), 'utf8')).toBe('approved\n')
  } finally { vi.unstubAllEnvs() }
})


it('prepares two agents concurrently on the first use of a repository cache', async () => {
  const f = await fixture()
  const signal = AbortSignal.timeout(30_000)
  const prepared = await Promise.all(['one', 'two'].map(name => addGitWorktree(f.ports,
    { repository: 'octo/site', branch: `foreman/review/${name}` }, f.commit, join(f.root, name), signal)))
  expect(new Set(prepared.map(value => value.branch)).size).toBe(2)
  for (const name of ['one', 'two']) {
    expect(git(join(f.root, name), 'rev-parse', 'HEAD')).toBe(f.commit)
    expect(await readFile(join(f.root, name, 'README.md'), 'utf8')).toBe('approved\n')
  }
})

it('prepares more than twenty occurrences while retaining all earlier branches', async () => {
  const f = await fixture()
  const branches = []
  for (let index = 0; index < 23; index++) {
    branches.push((await addGitWorktree(f.ports, { repository: 'octo/site', branch: 'foreman/repeat/agent' },
      f.commit, join(f.root, `occurrence-${index}`), AbortSignal.timeout(30_000))).branch)
  }
  expect(new Set(branches).size).toBe(23)
  for (const branch of branches) {
    expect(git(f.ports.cloneDirectory('octo/site'), 'rev-parse', branch)).toBe(f.commit)
  }
})


it('fetches promised blobs before isolated source capture needs them offline', async () => {
  const f = await fixture()
  git(f.origin, 'config', 'uploadpack.allowFilter', 'true')
  const clone = f.ports.cloneDirectory('octo/site')
  await mkdir(join(clone, '..'), { recursive: true })
  git(f.root, 'clone', '--no-checkout', '--filter=blob:none', `file://${f.origin}`, clone)
  expect(git(clone, 'rev-list', '--objects', '--missing=print', `${f.commit}^{tree}`)).toContain('\n?')
  await ensureCommit(f.ports, 'octo/site', f.commit, AbortSignal.timeout(30_000))
  await rename(f.origin, join(f.root, 'offline-origin'))
  const captured: Buffer[] = []
  const manifest = await captureGitSource({ root: clone, commit: f.commit, approvedSourceId: randomUUID(),
    executablePolicy: 'strip', sink: {
      async write(_snapshot, _entry, bytes) { captured.push(Buffer.from(bytes)) },
      async commit() {},
      async abort() {},
    } })
  expect(manifest.totalEntries).toBe(1)
  expect(captured.map(bytes => bytes.toString())).toEqual(['approved\n'])
})
