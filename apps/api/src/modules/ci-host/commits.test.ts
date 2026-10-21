import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { GitCiCommits } from './commits.js'
import { systemGitWorktreePorts } from '../sources/gitWorktree.js'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

it('tests the unchanged Agent commit without importing files or selecting a newer default head', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'ci-unchanged-agent-'))
  directories.push(directory)
  const origin = join(directory, 'origin')
  await mkdir(origin)
  const environment = gitFixtureEnvironment()
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
    cwd, env: environment, encoding: 'utf8',
  }).trim()
  git(origin, 'init', '-q', '-b', 'main')
  await writeFile(join(origin, 'source.txt'), 'Run-start source')
  git(origin, 'add', '.')
  git(origin, 'commit', '-qm', 'Run start')
  const baseCommit = git(origin, 'rev-parse', 'HEAD')
  const clone = join(directory, 'clone')
  git(directory, 'clone', '-q', '--no-checkout', origin, clone)
  await writeFile(join(origin, 'source.txt'), 'Newer default source')
  git(origin, 'commit', '-qam', 'Advance main')
  const defaultHead = git(origin, 'rev-parse', 'HEAD')
  const system = systemGitWorktreePorts(environment)
  const run = vi.fn(system.git)
  const commits = new GitCiCommits({ ...system, git: run, cloneDirectory: () => clone })
  expect(await commits.resolve('octo/site', 'main', undefined,
    { commit: baseCommit, baseCommit, bundle: null })).toBe(baseCommit)
  expect(await commits.resolve('octo/site', 'main', undefined,
    { commit: baseCommit, baseCommit, bundle: null })).toBe(baseCommit)
  expect(git(clone, 'show', `${baseCommit}:source.txt`)).toBe('Run-start source')
  expect(git(origin, 'rev-parse', 'refs/heads/main')).toBe(defaultHead)
  expect(git(origin, 'rev-parse', `refs/heads/foreman/ci/${baseCommit}`)).toBe(baseCommit)
  expect(git(origin, 'show', `${baseCommit}:source.txt`)).toBe('Run-start source')
  expect(run.mock.calls.some(([args]) => args[0] === 'bundle')).toBe(false)
})

it('classifies Git changes including deletions, mixed commits and renames into CI paths', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'ci-commit-priority-'))
  directories.push(directory)
  const origin = join(directory, 'origin')
  await mkdir(join(origin, 'scripts'), { recursive: true })
  const environment = gitFixtureEnvironment()
  const git = (...args: string[]) => execFileSync('git', args, { cwd: origin, env: environment, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  await writeFile(join(origin, 'scripts/ci-example.mjs'), 'export const value = 1')
  git('add', '.')
  git('commit', '-qm', 'CI setup')
  const commits = new GitCiCommits({ ...systemGitWorktreePorts(environment), cloneDirectory: () => origin })
  const classify = () => commits.infrastructureOnly('octo/site', git('rev-parse', 'HEAD'))
  expect(await classify()).toBe(true)
  git('commit', '--allow-empty', '-qm', 'Empty change')
  expect(await classify()).toBe(false)
  await writeFile(join(origin, 'product.txt'), 'Product')
  await writeFile(join(origin, 'scripts/ci-example.mjs'), 'export const value = 2')
  git('add', '.')
  git('commit', '-qm', 'Mixed change')
  expect(await classify()).toBe(false)
  git('mv', 'product.txt', 'scripts/ci-product.mjs')
  git('commit', '-qm', 'Move product')
  expect(await classify()).toBe(false)
  git('rm', 'scripts/ci-example.mjs')
  git('commit', '-qm', 'Remove CI example')
  expect(await classify()).toBe(true)
})

it('resolves branch identity and ancestry from published Git commits while protecting main and ambiguous refs', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'ci-commit-lineage-'))
  directories.push(directory)
  const origin = join(directory, 'origin')
  await mkdir(origin)
  const environment = gitFixtureEnvironment()
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
    cwd, env: environment, encoding: 'utf8',
  }).trim()
  git(origin, 'init', '-q', '-b', 'main')
  await writeFile(join(origin, 'source.txt'), 'Base')
  git(origin, 'add', '.')
  git(origin, 'commit', '-qm', 'Base')
  const main = git(origin, 'rev-parse', 'HEAD')
  git(origin, 'checkout', '-qb', 'feature')
  await writeFile(join(origin, 'source.txt'), 'First')
  git(origin, 'commit', '-qam', 'First')
  const first = git(origin, 'rev-parse', 'HEAD')
  await writeFile(join(origin, 'source.txt'), 'Second')
  git(origin, 'commit', '-qam', 'Second')
  const second = git(origin, 'rev-parse', 'HEAD')
  git(origin, 'branch', `foreman/ci/${second}`, second)
  git(origin, 'checkout', '-qb', 'other', main)
  await writeFile(join(origin, 'source.txt'), 'Unrelated')
  git(origin, 'commit', '-qam', 'Unrelated')
  const unrelated = git(origin, 'rev-parse', 'HEAD')
  const clone = join(directory, 'clone')
  git(directory, 'clone', '-q', '--no-checkout', origin, clone)
  const system = systemGitWorktreePorts(environment)
  const commits = new GitCiCommits({ ...system, cloneDirectory: () => clone })
  expect(await commits.branch('octo/site', 'main', first)).toBe('feature')
  expect(await commits.branch('octo/site', 'main', second)).toBe('feature')
  expect(await commits.branch('octo/site', 'main', main)).toBe('main')
  expect(await commits.branch('octo/site', 'main', unrelated)).toBe('other')
  expect(await commits.isAncestor('octo/site', first, second)).toBe(true)
  expect(await commits.isAncestor('octo/site', second, first)).toBe(false)
  expect(await commits.isAncestor('octo/site', first, unrelated)).toBe(false)
  git(clone, 'update-ref', 'refs/remotes/origin/ambiguous', second)
  expect(await commits.branch('octo/site', 'main', first)).toBeNull()
})

it('discovers CI test inventories without loading committed duration snapshots', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'ci-inventory-'))
  directories.push(directory)
  const environment = gitFixtureEnvironment()
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: directory, env: environment, encoding: 'utf8',
  }).trim()
  await mkdir(join(directory, 'scripts'))
  await mkdir(join(directory, 'apps/api/test'), { recursive: true })
  await writeFile(join(directory, 'apps/api/test/workflow.test.ts'), 'export {}')
  await writeFile(join(directory, 'apps/api/test/workflow.integration.test.ts'), 'export {}')
  for (const suite of ['unit', 'integration']) {
    await writeFile(join(directory, `scripts/${suite}-durations.json`), JSON.stringify({ obsolete: 999 }))
  }
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('commit', '-qm', 'Inventory')
  const commits = new GitCiCommits({ ...systemGitWorktreePorts(environment), cloneDirectory: () => directory })
  const commit = git('rev-parse', 'HEAD')
  expect(await commits.unitInventory('example/project', commit)).toEqual({
    files: ['apps/api/test/workflow.test.ts'], durations: {}, heavy: [],
  })
  expect(await commits.integrationInventory('example/project', commit)).toEqual({
    files: ['apps/api/test/workflow.integration.test.ts'], durations: {},
  })
})
