import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ensureClone, type GitWorktreePorts } from './gitWorktree.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it.each(['EACCES', 'EIO', 'ABORT_ERR'])('preserves %s during a reusable clone probe without cloning', async code => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'git-probe-'))
  roots.push(root)
  await mkdir(join(root, 'clone'))
  const failure = Object.assign(new Error('Repository inspection failed'), { code })
  const git = vi.fn().mockRejectedValueOnce(failure).mockRejectedValue(new Error('Unexpected clone'))
  const ports = { cloneDirectory: () => join(root, 'clone'), git } as unknown as GitWorktreePorts
  await expect(ensureClone(ports, 'example/project', new AbortController().signal)).rejects.toBe(failure)
  expect(git).toHaveBeenCalledOnce()
})
