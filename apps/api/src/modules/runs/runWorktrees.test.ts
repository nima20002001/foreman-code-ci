import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { systemGitWorktreePorts } from '../sources/gitWorktree.js'
import { removeCommittedWorktree } from '../sources/worktreeCleanup.js'
import { latestDefaultCommit } from './runWorktrees.js'

const roots: string[] = []
const environment = gitFixtureEnvironment()
const ports = systemGitWorktreePorts(environment)
const signal = () => AbortSignal.timeout(30_000)
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: environment }).trim()
async function repository() {
  const parent = process.env.TMPDIR
  if (!parent || parent === '/tmp') throw new Error('These fixtures require a disk-backed TMPDIR.')
  const root = await mkdtemp(join(parent, 'run-worktree-'))
  roots.push(root)
  git(root, 'init', '-b', 'main')
  await writeFile(join(root, 'file.txt'), 'default branch')
  git(root, 'add', 'file.txt')
  git(root, 'commit', '-m', 'Default')
  return root
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('Run Git isolation', () => {
  it('uses local main even when a dirty feature branch is checked out', async () => {
    const root = await repository()
    const base = git(root, 'rev-parse', 'HEAD')
    git(root, 'checkout', '-b', 'feature')
    await writeFile(join(root, 'file.txt'), 'other run changes')
    expect(await latestDefaultCommit(ports, root, signal())).toBe(base)
    expect(git(root, 'branch', '--show-current')).toBe('feature')
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('other run changes')
  })

  it('fetches the remote default branch rather than the current or stale local branch', async () => {
    const upstream = await repository()
    git(upstream, 'branch', '-m', 'trunk')
    const root = join(upstream, 'clone')
    // The Run Git cache accepts only roots that exclude other writers, whatever umask the host gives fixtures.
    execFileSync('/bin/sh', ['-c', 'umask 077 && exec git "$@"', 'git', 'clone', '--no-hardlinks', upstream, root],
      { env: environment })
    git(root, 'checkout', '-b', 'feature')
    await writeFile(join(upstream, 'file.txt'), 'latest default')
    git(upstream, 'add', 'file.txt')
    git(upstream, 'commit', '-m', 'Latest')
    expect(await latestDefaultCommit(ports, root, signal())).toBe(git(upstream, 'rev-parse', 'HEAD'))
    expect(git(root, 'branch', '--show-current')).toBe('feature')
  })

  it('removes a clean terminal checkout and retains its committed branch', async () => {
    const root = await repository()
    const directory = join(root, 'runs', 'one')
    await mkdir(join(directory, '..'))
    const baseCommit = git(root, 'rev-parse', 'HEAD')
    git(root, 'worktree', 'add', '-b', 'foreman/one', directory, baseCommit)
    await writeFile(join(directory, 'file.txt'), 'run commit')
    git(directory, 'add', 'file.txt')
    git(directory, 'commit', '-m', 'Run result')
    const commit = git(directory, 'rev-parse', 'HEAD')
    const tree = { workingDirectory: directory, branch: 'foreman/one', baseCommit, state: 'active' as const }
    expect(await removeCommittedWorktree(ports, root, tree, signal())).toMatchObject({ state: 'removed' })
    expect(git(root, 'rev-parse', 'foreman/one')).toBe(commit)
    expect(await removeCommittedWorktree(ports, root, tree, signal())).toMatchObject({ state: 'removed' })
  })

  it('retains and reports uncommitted changes without affecting another checkout', async () => {
    const root = await repository()
    const directory = join(root, 'runs', 'dirty')
    await mkdir(join(directory, '..'))
    const baseCommit = git(root, 'rev-parse', 'HEAD')
    git(root, 'worktree', 'add', '-b', 'foreman/dirty', directory, baseCommit)
    await writeFile(join(directory, 'untracked.txt'), 'keep me')
    const tree = { workingDirectory: directory, branch: 'foreman/dirty', baseCommit, state: 'active' as const }
    expect(await removeCommittedWorktree(ports, root, tree, signal())).toMatchObject({ state: 'retained', message: expect.any(String) })
    expect(await readFile(join(directory, 'untracked.txt'), 'utf8')).toBe('keep me')
    expect(git(root, 'branch', '--show-current')).toBe('main')
  })
})
