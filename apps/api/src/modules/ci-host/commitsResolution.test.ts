import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { GitCiCommits } from './commits.js'
import type { GitWorktreePorts } from '../sources/gitWorktree.js'
import { runGitProcess } from '../sources/gitProcess.js'
import { publishCommit } from '../sources/githubPublisher.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function shallowFixture() {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'commit-publication-'))
  roots.push(root)
  const origin = join(root, 'origin.git')
  const writer = join(root, 'writer')
  const clone = join(root, 'clone')
  const environment = gitFixtureEnvironment()
  const run = (cwd: string, ...args: string[]) => execFileSync('git', args, {
    cwd, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  run(root, 'init', '--quiet', '--bare', '--initial-branch=main', origin)
  run(root, 'init', '--quiet', '--initial-branch=main', writer)
  run(writer, 'commit', '--quiet', '--allow-empty', '-m', 'base')
  const base = run(writer, 'rev-parse', 'HEAD')
  run(writer, 'commit', '--quiet', '--allow-empty', '-m', 'requested')
  const commit = run(writer, 'rev-parse', 'HEAD')
  run(writer, 'commit', '--quiet', '--allow-empty', '-m', 'tip')
  const tip = run(writer, 'rev-parse', 'HEAD')
  run(writer, 'push', '--quiet', origin, 'main')
  run(root, 'clone', '--quiet', '--no-checkout', '--depth=1', '--no-tags',
    pathToFileURL(origin).href, clone)
  const git = vi.fn<GitWorktreePorts['git']>((args, options) => runGitProcess(
    args[0] === 'fetch' && args.includes('origin') ? ['fetch', '--depth=1', ...args.slice(1)] : args,
    options, environment))
  const ports: GitWorktreePorts = { git, cloneDirectory: () => clone }
  return { origin, clone, commit, base, tip, run, git, ports, commits: new GitCiCommits(ports) }
}

it('resolves a published non-tip commit missing from a shallow clone without pushing it', async () => {
  const f = await shallowFixture()
  expect(f.run(f.clone, 'rev-parse', '--is-shallow-repository')).toBe('true')
  expect(() => f.run(f.clone, 'cat-file', '-e', `${f.commit}^{commit}`)).toThrow()
  expect(await f.commits.resolve('octo/site', 'main', f.commit, null)).toBe(f.commit)
  expect(f.run(f.clone, 'cat-file', '-t', f.commit)).toBe('commit')
  expect(() => f.run(f.clone, 'cat-file', '-e', `${f.base}^{commit}`)).toThrow()
  expect(f.run(f.origin, 'for-each-ref', '--format=%(refname)', 'refs/heads/')).toBe('refs/heads/main')
  expect(f.git.mock.calls.filter(([args]) => args[0] === 'push')).toHaveLength(0)
  const fetches = f.git.mock.calls.filter(([args]) => args[0] === 'fetch')
  expect(fetches).toHaveLength(1)
  expect(fetches[0]![0]).toEqual(expect.arrayContaining(['--depth=1', 'origin', f.commit]))
})

it('publishes a missing non-tip commit by reading it from origin at depth one', async () => {
  const f = await shallowFixture()
  await expect(publishCommit(f.ports, 'octo/site', f.commit, AbortSignal.timeout(30_000)))
    .resolves.toBeUndefined()
  expect(f.run(f.clone, 'cat-file', '-t', f.commit)).toBe('commit')
  expect(f.git.mock.calls.filter(([args]) => args[0] === 'push')).toHaveLength(0)
})

it('resolves a branch tip Main already holds without pushing it', async () => {
  const f = await shallowFixture()
  expect(await f.commits.resolve('octo/site', 'main', f.tip, null)).toBe(f.tip)
  expect(f.git.mock.calls.filter(([args]) => args[0] === 'push')).toHaveLength(0)
  expect(f.run(f.origin, 'for-each-ref', '--format=%(refname)', 'refs/heads/')).toBe('refs/heads/main')
})

it('pins a published commit Main already holds without moving origin branches', async () => {
  const f = await shallowFixture()
  f.run(f.clone, 'fetch', '--quiet', '--depth=2', 'origin', 'main')
  expect(await f.commits.resolve('octo/site', 'main', f.commit, null)).toBe(f.commit)
  expect(f.run(f.origin, 'rev-parse', `refs/heads/foreman/ci/${f.commit}`)).toBe(f.commit)
  expect(f.run(f.origin, 'rev-parse', 'refs/heads/main')).toBe(f.tip)
})

it('pushes an unpublished local commit so origin can serve it', async () => {
  const f = await shallowFixture()
  f.run(f.clone, 'commit', '--quiet', '--allow-empty', '-m', 'local')
  const local = f.run(f.clone, 'rev-parse', 'HEAD')
  expect(() => f.run(f.origin, 'cat-file', '-e', `${local}^{commit}`)).toThrow()
  expect(await f.commits.resolve('octo/site', 'main', local, null)).toBe(local)
  expect(f.run(f.origin, 'rev-parse', `refs/heads/foreman/ci/${local}`)).toBe(local)
  expect(f.run(f.origin, 'rev-parse', 'refs/heads/main')).toBe(f.tip)
})

it('does not treat a stale remote-tracking branch as published', async () => {
  const f = await shallowFixture()
  f.run(f.clone, 'commit', '--quiet', '--allow-empty', '-m', 'local')
  const local = f.run(f.clone, 'rev-parse', 'HEAD')
  f.run(f.clone, 'update-ref', 'refs/remotes/origin/main', local)
  expect(await f.commits.resolve('octo/site', 'main', local, null)).toBe(local)
  expect(f.run(f.origin, 'rev-parse', `refs/heads/foreman/ci/${local}`)).toBe(local)
})

it('reports a commit absent from both the shallow clone and origin without attempting a push', async () => {
  const f = await shallowFixture()
  await expect(f.commits.resolve('octo/site', 'main', 'f'.repeat(40), null))
    .rejects.toMatchObject({ code: 'SOURCE_GITHUB_PUSH_REQUIRED' })
  expect(f.git.mock.calls.filter(([args]) => args[0] === 'push')).toHaveLength(0)
  expect(f.run(f.origin, 'for-each-ref', '--format=%(refname)', 'refs/heads/')).toBe('refs/heads/main')
})

async function fixture() {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'commit-resolution-'))
  roots.push(root)
  const clone = join(root, 'clone')
  await mkdir(clone)
  let head = 'a'.repeat(40)
  const git = vi.fn<GitWorktreePorts['git']>(async args => {
    if (args[0] === 'rev-parse' && args.includes('--verify')) {
      return { code: 0, stdout: head, stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  })
  const commits = new GitCiCommits({ git, cloneDirectory: () => clone })
  return { commits, git, advance: () => { head = 'b'.repeat(40) } }
}

it('shares publication of a known commit across concurrent resolution and later requests', async () => {
  const f = await fixture()
  const commit = 'a'.repeat(40)
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const run = f.git.getMockImplementation()!
  f.git.mockImplementation(async (args, options) => {
    if (args[0] === 'push') await blocked
    return run(args, options)
  })
  const requests = Array.from({ length: 4 }, () => f.commits.resolve('octo/site', 'main', commit, null))
  release()
  expect(await Promise.all(requests)).toEqual(Array(4).fill(commit))
  expect(await f.commits.resolve('octo/site', 'main', commit, null)).toBe(commit)
  expect(f.git.mock.calls.filter(([args]) => args[0] === 'push')).toHaveLength(1)
  await f.commits.resolve('octo/other', 'main', commit, null)
  expect(f.git.mock.calls.filter(([args]) => args[0] === 'push')).toHaveLength(2)
})

it('retries publication after a failed resolution instead of caching the failure', async () => {
  const f = await fixture()
  const run = f.git.getMockImplementation()!
  let fail = true
  f.git.mockImplementation(async (args, options) => {
    if (args[0] === 'push' && fail) {
      fail = false
      return { code: 1, stdout: '', stderr: 'remote unavailable' }
    }
    return run(args, options)
  })
  const resolve = () => f.commits.resolve('octo/site', 'main', 'a'.repeat(40), null)
  await expect(resolve()).rejects.toMatchObject({ code: 'SOURCE_GITHUB_PUSH_REQUIRED' })
  expect(await resolve()).toBe('a'.repeat(40))
  expect(f.git.mock.calls.filter(([args]) => args[0] === 'push')).toHaveLength(2)
})

it('refreshes a moving default branch while reusing publication of its resolved commit', async () => {
  const f = await fixture()
  expect(await f.commits.resolve('octo/site', 'main', undefined, null)).toBe('a'.repeat(40))
  f.advance()
  expect(await f.commits.resolve('octo/site', 'main', undefined, null)).toBe('b'.repeat(40))
  expect(await f.commits.resolve('octo/site', 'main', 'a'.repeat(40), null)).toBe('a'.repeat(40))
  expect(f.git.mock.calls.filter(([args]) => args[0] === 'fetch')).toHaveLength(2)
  expect(f.git.mock.calls.filter(([args]) => args[0] === 'push')).toHaveLength(2)
})
