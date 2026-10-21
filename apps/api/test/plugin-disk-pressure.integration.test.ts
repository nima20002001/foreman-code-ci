import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('restores the working plugin without writing another copy when file growth is exhausted', async () => {
  const root = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(root, { recursive: true })
  const home = await mkdtemp(join(root, 'plugin-pressure-'))
  try {
    const result = await promisify(execFile)(process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('./helpers/pluginDiskPressure.mjs', import.meta.url)), home],
      { signal: AbortSignal.timeout(15_000) })
    expect(result.stdout).toBe('restored')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
