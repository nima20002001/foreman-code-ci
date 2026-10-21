import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { addGitWorktree, systemGitWorktreePorts, type GitWorktreePorts } from './gitWorktree.js'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', env: gitFixtureEnvironment(), stdio: ['ignore', 'pipe', 'pipe'],
}).trim()

it('isolates identical prefixes on two computer caches and does not synchronize edits or commits', async () => {
  const parent = process.env.FOREMAN_CODE_TEST_ROOT ?? join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'cross-computer-worktrees-'))
  try {
    const origin = join(root, 'origin')
    await mkdir(origin)
    git(origin, 'init', '-q', '--bare')
    const seed = join(root, 'seed')
    git(root, 'clone', '-q', origin, seed)
    await writeFile(join(seed, 'file.txt'), 'approved\n')
    git(seed, 'add', '.')
    git(seed, 'commit', '-qm', 'Approved source')
    git(seed, 'push', '-q', 'origin', 'HEAD:main')
    const commit = git(seed, 'rev-parse', 'HEAD')
    const system = systemGitWorktreePorts(gitFixtureEnvironment())
    const request = { repository: 'example/project', branch: 'foreman/project/shared' }
    const trees = []
    for (const computer of ['computer-a', 'computer-b']) {
      const directory = join(root, computer)
      await mkdir(directory)
      const ports: GitWorktreePorts = {
        cloneDirectory: () => join(directory, 'clone'),
        git: (args, options) => system.git(args[0] === 'clone'
          ? ['clone', '--no-checkout', origin, args.at(-1)!] : args, options),
      }
      const path = join(directory, 'worktree')
      const worktree = await addGitWorktree(ports, request, commit, path, AbortSignal.timeout(30_000))
      expect(worktree.commit).toBe(commit)
      expect(worktree.branch).toMatch(/^foreman\/project\/shared-[a-f0-9-]+$/)
      trees.push({ path, ...worktree })
    }
    const [first, second] = trees
    expect(first!.branch).not.toBe(second!.branch)
    await writeFile(join(first!.path, 'file.txt'), 'Agent One changes\n')
    git(first!.path, 'commit', '-qam', 'Agent One work')
    const firstCommit = git(first!.path, 'rev-parse', 'HEAD')
    expect(await readFile(join(second!.path, 'file.txt'), 'utf8')).toBe('approved\n')
    expect(git(second!.path, 'rev-parse', 'HEAD')).toBe(commit)
    await writeFile(join(second!.path, 'file.txt'), 'Agent Two changes\n')
    git(second!.path, 'commit', '-qam', 'Agent Two work')
    const secondCommit = git(second!.path, 'rev-parse', 'HEAD')
    for (const tree of trees) git(tree.path, 'push', '-q', 'origin', `HEAD:refs/heads/${tree.branch}`)
    expect(git(origin, 'rev-parse', first!.branch)).toBe(firstCommit)
    expect(git(origin, 'rev-parse', second!.branch)).toBe(secondCommit)
    // A harness explicitly pushing both results to one branch receives Git's conflict; no merge is supplied.
    git(first!.path, 'push', '-q', 'origin', 'HEAD:refs/heads/shared-result')
    const conflict = spawnSync('git', ['push', 'origin', 'HEAD:refs/heads/shared-result'], {
      cwd: second!.path, encoding: 'utf8', env: gitFixtureEnvironment(),
    })
    expect(conflict.status).not.toBe(0)
    expect(conflict.stderr).toMatch(/rejected/)
    expect(git(origin, 'rev-parse', 'shared-result')).toBe(firstCommit)
    expect(git(second!.path, 'rev-parse', 'HEAD')).toBe(secondCommit)
  } finally { await rm(root, { recursive: true, force: true }) }
})
