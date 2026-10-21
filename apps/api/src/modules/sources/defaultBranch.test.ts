import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { latestDefaultCommit } from './defaultBranch.js'
import { systemGitWorktreePorts } from './gitWorktree.js'

const roots: string[] = []
const git = (cwd: string, ...args: string[]) => execFileSync('/bin/sh', [
  '-c', 'umask 077 && exec git "$@"', 'git', ...args,
], {
  cwd, encoding: 'utf8', env: gitFixtureEnvironment(),
}).trim()

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(options: { location: 'workspace' | 'cache'; history: 'full' | 'shallow' }) {
  const root = await mkdtemp(join(persistentFixtureRoot, 'default-branch-'))
  roots.push(root)
  const origin = join(root, 'origin')
  await mkdir(origin, { mode: 0o700 })
  git(origin, 'init', '--template=', '-q', '-b', 'main')
  await writeFile(join(origin, 'source.txt'), 'first revision')
  git(origin, 'add', '.')
  git(origin, 'commit', '-qm', 'First revision')
  await writeFile(join(origin, 'source.txt'), 'second revision')
  git(origin, 'commit', '-qam', 'Second revision')
  const history = git(origin, 'rev-list', 'HEAD')
  const ports = systemGitWorktreePorts({ ...gitFixtureEnvironment(), HOME: join(root, 'home') })
  const repository = options.location === 'cache' ? ports.cloneDirectory('fixture/project') : join(root, 'workspace')
  await mkdir(dirname(repository), { recursive: true, mode: 0o700 })
  await mkdir(repository, { mode: 0o700 })
  git(root, 'clone', '-q', '--template=', '--no-local',
    ...(options.history === 'shallow' ? ['--depth=1'] : []), `file://${origin}`, repository)
  return { origin, repository, ports, history }
}

it.each(['workspace', 'cache'] as const)(
  'keeps a full %s repository and its history complete after default-branch lookup', async location => {
    const f = await fixture({ location, history: 'full' })
    expect(git(f.repository, 'rev-parse', '--is-shallow-repository')).toBe('false')
    expect(git(f.repository, 'rev-list', 'HEAD')).toBe(f.history)

    const commit = await latestDefaultCommit(f.ports, f.repository, AbortSignal.timeout(30_000))

    expect(commit).toBe(git(f.origin, 'rev-parse', 'HEAD'))
    expect({
      shallow: git(f.repository, 'rev-parse', '--is-shallow-repository'),
      history: git(f.repository, 'rev-list', 'HEAD'),
      defaultHistory: git(f.repository, 'rev-list', commit),
    }).toEqual({ shallow: 'false', history: f.history, defaultHistory: f.history })
  },
)

it.each([
  { location: 'workspace' as const, expectedCommits: '2' },
  { location: 'cache' as const, expectedCommits: '1' },
])('limits fetched history only in an already-shallow cache ($location)', async ({ location, expectedCommits }) => {
  const f = await fixture({ location, history: 'shallow' })
  expect(git(f.repository, 'rev-parse', '--is-shallow-repository')).toBe('true')
  await writeFile(join(f.origin, 'source.txt'), 'third revision')
  git(f.origin, 'commit', '-qam', 'Third revision')

  const commit = await latestDefaultCommit(f.ports, f.repository, AbortSignal.timeout(30_000))

  expect(commit).toBe(git(f.origin, 'rev-parse', 'HEAD'))
  expect(git(f.repository, 'rev-parse', '--is-shallow-repository')).toBe('true')
  expect(git(f.repository, 'rev-list', '--count', commit)).toBe(expectedCommits)
})
