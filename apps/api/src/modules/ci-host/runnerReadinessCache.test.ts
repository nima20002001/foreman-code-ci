import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { HostCiRunner } from './runner.js'

it('caches successful tool and login probes across status polls and retries failed probes', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'ci-readiness-'))
  const clock = vi.spyOn(Date, 'now')
  let now = 0
  let missingTool = false
  clock.mockImplementation(() => now)
  const run = vi.fn(async (file: string) => ({ code: missingTool && file === 'git' ? 127 : 0,
    stdout: '', stderr: '' }))
  const runner = new HostCiRunner(root, { now: () => new Date(), cpus: 8, memoryBytes: 16 * 2 ** 30, run })
  try {
    expect(await runner.handle({ operation: 'status' })).toMatchObject({ ready: true })
    expect(run).toHaveBeenCalledTimes(3)
    now += 120_000
    expect(await runner.handle({ operation: 'status' })).toMatchObject({ ready: true })
    expect(run).toHaveBeenCalledTimes(3)
    now += 300_000
    missingTool = true
    expect(await runner.handle({ operation: 'status' })).toMatchObject({ ready: false,
      reasons: ['git is not installed for the Worker.'] })
    missingTool = false
    expect(await runner.handle({ operation: 'status' })).toMatchObject({ ready: true })
  } finally {
    clock.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
