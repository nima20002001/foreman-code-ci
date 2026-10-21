import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION, type CodexHarnessConfiguration } from '@foreman-code/contracts'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { systemGitWorktreePorts } from '../sources/gitWorktree.js'
import { worktreeSecurity } from './worktreeSecurity.js'

const roots: string[] = []
const configuration: CodexHarnessConfiguration = { harness: 'codex', model: 'gpt-5.4', reasoningEffort: 'medium',
  sandbox: 'workspace-write', serviceTier: 'standard', advanced: DEFAULT_CODEX_ADVANCED_CONFIGURATION }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

it('explicitly grants only linked Git metadata and existing directories for local and Worker checkouts', async () => {
  const parent = process.env.TMPDIR
  if (!parent || parent === '/tmp') throw new Error('These fixtures require a disk-backed TMPDIR.')
  const root = await mkdtemp(join(parent, 'worktree-security-'))
  roots.push(root)
  const environment = gitFixtureEnvironment()
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: environment, encoding: 'utf8' }).trim()
  git('init', '-b', 'main')
  await writeFile(join(root, 'file.txt'), 'base')
  git('add', 'file.txt')
  git('commit', '-m', 'Base')
  for (const host of ['main', 'worker']) {
    const cwd = join(root, host)
    git('worktree', 'add', '-b', `foreman/${host}`, cwd)
    const accepted = { ...configuration, advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION,
      additionalWritableDirectories: ['/already-allowed'] } }
    const resolved = await worktreeSecurity(accepted, cwd, AbortSignal.timeout(30_000), systemGitWorktreePorts(environment))
    expect(resolved.advanced?.additionalWritableDirectories).toEqual([
      '/already-allowed', join(root, '.git'), join(root, '.git', 'worktrees', host),
    ])
    expect(resolved.advanced?.additionalWritableDirectories).not.toContain(root)
    expect(accepted.advanced.additionalWritableDirectories).toEqual(['/already-allowed'])
    expect(await worktreeSecurity({ ...configuration, sandbox: 'read-only', advanced: undefined }, cwd,
      AbortSignal.timeout(30_000))).toMatchObject({ sandbox: 'read-only', advanced: undefined })
  }
  const ordinary = join(root, 'ordinary')
  await mkdir(ordinary)
  expect(await worktreeSecurity(configuration, ordinary, AbortSignal.timeout(30_000))).toBe(configuration)
})
