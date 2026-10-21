import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { AcceptedWorkflowRunV3Schema } from '@foreman-code/contracts/wave25'
import { currentUnitSnapshot } from '../../../test/helpers/currentUnitSnapshot.js'
import { RunWorktrees } from '../runs/runWorktrees.js'
import { addGitWorktree, systemGitWorktreePorts, type GitWorktreePorts } from './gitWorktree.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const parent = process.env.TMPDIR
  if (!parent || parent === '/tmp') throw new Error('Git identity fixtures require a disk-backed TMPDIR.')
  const root = await mkdtemp(join(parent, 'git-identity-'))
  roots.push(root)
  const home = join(root, 'home')
  const origin = join(root, 'origin')
  await mkdir(home)
  await mkdir(origin)
  // Require an explicit identity, with no host config or inherited Git identity.
  await writeFile(join(home, '.gitconfig'), '[user]\n\tuseConfigOnly = true\n')
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.startsWith('GIT_') && key !== 'EMAIL'))
  Object.assign(environment, { HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1' })
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
    cwd, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  const commit = (cwd: string, message: string) => git(cwd,
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message)
  git(origin, 'init', '-q', '-b', 'main')
  await writeFile(join(origin, 'base.txt'), 'base\n')
  git(origin, 'add', '.')
  commit(origin, 'base')
  const baseCommit = git(origin, 'rev-parse', 'HEAD')
  git(origin, 'checkout', '-qb', 'topic')
  await writeFile(join(origin, 'topic.txt'), 'topic\n')
  git(origin, 'add', '.')
  commit(origin, 'topic')
  git(origin, 'checkout', '-q', 'main')
  const system = systemGitWorktreePorts(environment)
  const ports: GitWorktreePorts = {
    cloneDirectory: repository => join(root, 'clones', ...repository.split('/')),
    git: (args, options) => system.git(args[0] === 'clone'
      ? ['clone', '--no-checkout', origin, args.at(-1)!] : args, options),
  }
  return { root, origin, baseCommit, ports, git }
}

async function mergeAsAgent(f: Awaited<ReturnType<typeof fixture>>, path: string, topic: string) {
  await writeFile(join(path, 'agent.txt'), 'agent work\n')
  f.git(path, 'add', 'agent.txt')
  f.git(path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'agent work')
  const before = f.git(path, 'rev-parse', 'HEAD')
  let topicCommit: string
  if (topic.startsWith('origin/')) {
    topicCommit = f.git(f.origin, 'rev-parse', topic.slice('origin/'.length))
    f.git(path, 'fetch', '--no-tags', '--no-write-fetch-head', 'origin', topicCommit)
  } else {
    topicCommit = f.git(path, 'rev-parse', topic)
  }
  f.git(path, 'merge', '--no-ff', '--no-edit', topicCommit)
  expect(f.git(path, 'show', '-s', '--format=%P')).toBe(`${before} ${topicCommit}`)
  const committer = f.git(path, 'show', '-s', '--format=%cn <%ce>')
  f.git(path, 'commit', '--allow-empty', '-qm', 'agent follow-up')
  expect(f.git(path, 'show', '-s', '--format=%cn <%ce>')).toBe(committer)
  return committer
}

it.each(['Main', 'Worker'])('lets an Agent on %s commit and merge without a host identity', async host => {
  const f = await fixture()
  const path = join(f.root, 'agent')
  await addGitWorktree(f.ports, { repository: 'octo/site', branch: `foreman/${host.toLowerCase()}` },
    f.baseCommit, path, AbortSignal.timeout(30_000), { checkout: 'deferred' })
  f.git(path, 'checkout-index', '-a')
  expect(await mergeAsAgent(f, path, 'origin/topic')).toBe('Foreman Code Agent <agent@foreman-code.invalid>')
  expect(f.git(path, 'config', '--local', '--get', 'user.name')).toBe('Foreman Code Agent')
  expect(f.git(path, 'config', '--local', '--get', 'user.email')).toBe('agent@foreman-code.invalid')
  expect(() => f.git(f.origin, 'var', 'GIT_COMMITTER_IDENT')).toThrow()
})

it('preserves the repository identity when preparing another Agent worktree', async () => {
  const f = await fixture()
  const clone = f.ports.cloneDirectory('octo/site')
  await mkdir(join(clone, '..'), { recursive: true })
  f.git(f.root, 'clone', '--no-checkout', f.origin, clone)
  f.git(clone, 'config', '--local', 'user.name', 'Workspace Owner')
  f.git(clone, 'config', '--local', 'user.email', 'owner@example.invalid')
  const path = join(f.root, 'agent')
  await addGitWorktree(f.ports, { repository: 'octo/site', branch: 'foreman/agent' },
    f.baseCommit, path, AbortSignal.timeout(30_000))
  expect(await mergeAsAgent(f, path, 'origin/topic')).toBe('Workspace Owner <owner@example.invalid>')
})

it('sets identity safely when Agents allocate worktrees concurrently in one repository', async () => {
  const f = await fixture()
  const results = await Promise.allSettled(['one', 'two'].map(async name => {
    const path = join(f.root, name)
    await addGitWorktree(f.ports, { repository: 'octo/site', branch: `foreman/${name}` },
      f.baseCommit, path, AbortSignal.timeout(30_000))
    expect(await mergeAsAgent(f, path, 'origin/topic')).toBe('Foreman Code Agent <agent@foreman-code.invalid>')
  }))
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason
  }
})

it('sets identity on a Main Run worktree and repairs it when the persisted worktree is reused', async () => {
  const f = await fixture()
  let persisted: { repository_root: string; record: unknown; checkout_root: string; cleanup_attempts: number } | undefined
  const sql = {
    query: vi.fn(async (statement: string, values?: unknown[]) => {
      if (statement.startsWith('select pg_try_advisory_lock')) return { rows: [{ locked: true }] }
      if (statement.startsWith('select repository_root,record')) return { rows: persisted ? [persisted] : [] }
      if (statement.startsWith('select execution_state')) return { rows: [{ execution_state: 'running' }] }
      if (statement.startsWith('insert into run_worktrees')) {
        persisted = { repository_root: values![1] as string, record: JSON.parse(values![2] as string),
          checkout_root: values![4] as string, cleanup_attempts: 0 }
      }
      if (statement.startsWith('update run_worktrees') && persisted) {
        persisted.record = JSON.parse(values![1] as string)
      }
      return { rows: [] }
    }),
    release: vi.fn(),
  }
  const pool = { connect: async () => sql } as unknown as pg.Pool
  const fixtureRun = currentUnitSnapshot('git-identity').run
  const run = AcceptedWorkflowRunV3Schema.parse({ ...fixtureRun,
    executionLocation: { ...fixtureRun.executionLocation, rootPath: f.origin },
  })
  const worktrees = new RunWorktrees(pool, join(f.root, 'runs'), f.ports)
  const tree = await worktrees.prepare(run)
  expect(tree).toBeDefined()
  const path = tree!.workingDirectory
  expect(await mergeAsAgent(f, path, 'topic')).toBe('Foreman Code Agent <agent@foreman-code.invalid>')
  const merged = f.git(path, 'rev-parse', 'HEAD')
  f.git(path, 'config', '--local', 'user.name', '')
  f.git(path, 'config', '--local', '--unset', 'user.email')
  expect(() => f.git(path, 'var', 'GIT_COMMITTER_IDENT')).toThrow()
  expect(await worktrees.prepare(run)).toEqual(tree)
  f.git(path, 'commit', '--allow-empty', '-qm', 'resumed agent')
  expect(f.git(path, 'show', '-s', '--format=%cn <%ce>')).toBe('Foreman Code Agent <agent@foreman-code.invalid>')
  expect(f.git(path, 'rev-parse', 'HEAD^')).toBe(merged)
})

it('merges a nondefault branch into an Agent worktree without inheriting host identity', async () => {
  const f = await fixture()
  const path = join(f.root, 'agent')
  await addGitWorktree(f.ports, { repository: 'octo/site', branch: 'foreman/merge' },
    f.baseCommit, path, AbortSignal.timeout(30_000))
  expect(await mergeAsAgent(f, path, 'origin/topic')).toBe('Foreman Code Agent <agent@foreman-code.invalid>')
  expect(await readFile(join(path, 'topic.txt'), 'utf8')).toBe('topic\n')
  expect(await readFile(join(path, 'agent.txt'), 'utf8')).toBe('agent work\n')
})
