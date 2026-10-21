import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { HostCiRunner } from './runner.js'

it('preserves a GitHub readiness probe failure instead of telling the owner to log in', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'ci-readiness-error-'))
  const failure = Object.assign(new Error('Readiness probe timed out'), { code: 'ETIMEDOUT' })
  const runner = new HostCiRunner(root, { now: () => new Date(), cpus: 8, memoryBytes: 16 * 2 ** 30,
    run: async binary => {
      if (binary === 'gh') throw failure
      return { code: 0, stdout: '', stderr: '' }
    } })
  try {
    await expect(runner.handle({ operation: 'status' })).rejects.toBe(failure)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
