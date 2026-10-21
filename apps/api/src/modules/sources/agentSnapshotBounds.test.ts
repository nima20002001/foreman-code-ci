import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs, { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { snapshotAgentWorktree } from './agentSnapshot.js'
import { systemGitWorktreePorts } from './gitWorktree.js'

it('rejects an oversized completed bundle without reading its bytes into memory', async () => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'snapshot-bound-'))
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', env: gitFixtureEnvironment(),
  }).trim()
  try {
    git('init', '-q', '-b', 'main')
    await writeFile(join(root, 'app.ts'), 'base\n')
    git('add', '.')
    git('commit', '-qm', 'base')
    const baseCommit = git('rev-parse', 'HEAD')
    await writeFile(join(root, 'large.bin'), randomBytes(33 * 1024 * 1024))
    let bytesRead = 0
    const readFile = fs.readFile
    const reader = vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      const result = await readFile(...args)
      bytesRead += result.length
      return result
    })
    syncBuiltinESMExports()
    try {
      await expect(snapshotAgentWorktree(systemGitWorktreePorts(gitFixtureEnvironment()),
        { path: root, baseCommit }, AbortSignal.timeout(30_000)))
        .rejects.toMatchObject({ code: 'SOURCE_SNAPSHOT_TOO_LARGE' })
      expect(bytesRead).toBe(0)
      expect(git('rev-parse', 'HEAD')).toBe(baseCommit)
      expect(git('for-each-ref', '--format=%(refname)', 'refs/foreman/ci/')).toBe('')
    } finally {
      reader.mockRestore()
      syncBuiltinESMExports()
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
