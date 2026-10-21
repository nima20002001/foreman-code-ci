import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { importAgentSnapshot, snapshotAgentWorktree } from './agentSnapshot.js'
import { systemGitWorktreePorts } from './gitWorktree.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8',
  env: gitFixtureEnvironment() }).trim()

it('returns the base commit without a bundle for an unchanged large Agent worktree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-snapshot-unchanged-'))
  roots.push(root)
  git(root, 'init', '-q', '-b', 'main')
  await writeFile(join(root, 'large.bin'), randomBytes(900 * 1024))
  await writeFile(join(root, '.gitignore'), 'ignored.txt\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'Run start')
  const baseCommit = git(root, 'rev-parse', 'HEAD')
  await writeFile(join(root, 'ignored.txt'), 'runtime output')
  const ports = systemGitWorktreePorts(gitFixtureEnvironment())
  expect(await snapshotAgentWorktree(ports, { path: root, baseCommit }, AbortSignal.timeout(30_000)))
    .toEqual({ commit: baseCommit, bundle: null })
  expect(git(root, 'status', '--porcelain')).toBe('')
})

it('captures and imports a multi-megabyte changed-file bundle without moving the branch', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'agent-snapshot-large-'))
  roots.push(root)
  git(root, 'init', '-q', '-b', 'main')
  await writeFile(join(root, 'app.ts'), 'base\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'base')
  const baseCommit = git(root, 'rev-parse', 'HEAD')
  const receiver = join(root, 'receiver')
  git(root, 'clone', '-q', '--no-checkout', root, receiver)
  await writeFile(join(root, '.gitignore'), 'receiver/\n')
  const bytes = randomBytes(8 * 1024 * 1024)
  await writeFile(join(root, 'changed.bin'), bytes)
  const ports = systemGitWorktreePorts(gitFixtureEnvironment())
  const signal = AbortSignal.timeout(30_000)
  const snapshot = await snapshotAgentWorktree(ports, { path: root, baseCommit }, signal)
  expect(snapshot.bundle!.length).toBeGreaterThan(1024 * 1024)
  expect(git(root, 'rev-parse', 'HEAD')).toBe(baseCommit)
  await importAgentSnapshot(ports, receiver, snapshot, signal)
  const imported = execFileSync('git', ['show', `${snapshot.commit}:changed.bin`], {
    cwd: receiver, env: gitFixtureEnvironment(), maxBuffer: 16 * 1024 * 1024,
  })
  expect(imported.equals(bytes)).toBe(true)
})

it('rejects changed-file bundles above 32 MiB', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'agent-snapshot-oversized-'))
  roots.push(root)
  git(root, 'init', '-q', '-b', 'main')
  await writeFile(join(root, 'app.ts'), 'base\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'base')
  const baseCommit = git(root, 'rev-parse', 'HEAD')
  await writeFile(join(root, 'large.bin'), randomBytes(33 * 1024 * 1024))
  const ports = systemGitWorktreePorts(gitFixtureEnvironment())
  await expect(snapshotAgentWorktree(ports, { path: root, baseCommit }, AbortSignal.timeout(30_000)))
    .rejects.toMatchObject({ code: 'SOURCE_SNAPSHOT_TOO_LARGE' })
})

it('sends an Agent\'s current files, including uncommitted ones, to another clone without moving its branch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-snapshot-')); roots.push(root)
  const origin = join(root, 'origin'); await mkdir(origin)
  git(origin, 'init', '-q', '-b', 'main')
  await writeFile(join(origin, 'app.ts'), 'base\n'); await writeFile(join(origin, '.gitignore'), 'node_modules/\n')
  git(origin, 'add', '.'); git(origin, 'commit', '-qm', 'base')
  const base = git(origin, 'rev-parse', 'HEAD')
  const laptop = join(root, 'laptop'), main = join(root, 'main')
  git(root, 'clone', '-q', origin, laptop); git(root, 'clone', '-q', '--no-checkout', origin, main)
  git(laptop, 'checkout', '-qb', 'foreman/review/coder-1')
  await writeFile(join(laptop, 'app.ts'), 'committed change\n'); git(laptop, 'commit', '-qam', 'agent work')
  const branchHead = git(laptop, 'rev-parse', 'HEAD')
  await writeFile(join(laptop, 'app.ts'), 'uncommitted change\n')
  await writeFile(join(laptop, 'new.ts'), 'untracked file\n')
  await mkdir(join(laptop, 'node_modules')); await writeFile(join(laptop, 'node_modules/x.js'), 'ignored\n')
  const ports = systemGitWorktreePorts(gitFixtureEnvironment())
  const snapshot = await snapshotAgentWorktree(ports, { path: laptop, baseCommit: base }, AbortSignal.timeout(30_000))
  expect(git(laptop, 'rev-parse', 'HEAD')).toBe(branchHead)
  expect(git(laptop, 'status', '--porcelain')).toContain('new.ts')
  await importAgentSnapshot(ports, main, snapshot, AbortSignal.timeout(30_000))
  expect(git(main, 'show', `${snapshot.commit}:app.ts`)).toBe('uncommitted change')
  expect(git(main, 'show', `${snapshot.commit}:new.ts`)).toBe('untracked file')
  expect(git(main, 'ls-tree', '-r', '--name-only', snapshot.commit).split('\n').sort()).toEqual(['.gitignore', 'app.ts', 'new.ts'])
  await expect(snapshotAgentWorktree(ports, { path: laptop, baseCommit: 'f'.repeat(40) }, AbortSignal.timeout(30_000)))
    .rejects.toMatchObject({ code: 'SOURCE_SNAPSHOT_INVALID' })
})

it('keeps concurrent identical snapshots alive until each operation finishes bundling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-snapshot-concurrent-'))
  roots.push(root)
  git(root, 'init', '-q', '-b', 'main')
  await writeFile(join(root, 'app.ts'), 'base\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'base')
  const baseCommit = git(root, 'rev-parse', 'HEAD')
  await writeFile(join(root, 'app.ts'), 'agent change\n')
  const system = systemGitWorktreePorts(gitFixtureEnvironment())
  const dates = { GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' }
  let secondBundling!: () => void
  const secondBundle = new Promise<void>(resolve => { secondBundling = resolve })
  let firstDeleted!: () => void
  const firstDeletion = new Promise<void>(resolve => { firstDeleted = resolve })
  let firstRefCreated!: () => void
  const firstRef = new Promise<void>(resolve => { firstRefCreated = resolve })
  let refs = 0
  let bundles = 0
  const ports = { git: async (...args: Parameters<typeof system.git>) => {
    const creatingRef = args[0][0] === 'update-ref' && args[0][1] !== '-d'
    if (creatingRef && ++refs === 2) await firstRef
    if (args[0][0] === 'bundle') {
      bundles++
      if (bundles === 1) await secondBundle
      else {
        secondBundling()
        await firstDeletion
      }
    }
    const result = await system.git(args[0], { ...args[1], env: { ...args[1].env, ...dates } })
    if (creatingRef) firstRefCreated()
    if (args[0][0] === 'update-ref' && args[0][1] === '-d') firstDeleted()
    return result
  } }
  const signal = AbortSignal.timeout(30_000)
  const results = await Promise.allSettled([
    snapshotAgentWorktree(ports, { path: root, baseCommit }, signal),
    snapshotAgentWorktree(ports, { path: root, baseCommit }, signal),
  ])
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
  const snapshots = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
  expect(snapshots[0]!.commit).toBe(snapshots[1]!.commit)
  const clone = join(root, 'receiver')
  git(root, 'clone', '-q', '--no-checkout', root, clone)
  for (const snapshot of snapshots) {
    await importAgentSnapshot(system, clone, snapshot, signal)
    expect(git(clone, 'show', `${snapshot.commit}:app.ts`)).toBe('agent change')
  }
  expect(git(root, 'for-each-ref', '--format=%(refname)', 'refs/foreman/ci/')).toBe('')
})
