import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { runCiRuntimeCommand } from './ciRuntimeCommands.js'

describe('CI preparation command ownership', () => {
  it('returns command output and preserves a failed command status', async () => {
    expect(await runCiRuntimeCommand(process.execPath, ['-e', 'process.stdout.write("prepared")'],
      { env: process.env })).toMatchObject({ stdout: 'prepared' })
    await expect(runCiRuntimeCommand(process.execPath, ['-e', 'process.exit(2)'],
      { env: process.env })).rejects.toMatchObject({ code: 2 })
  })

  it('kills and joins the original process before cancelled preparation returns', async () => {
    const root = await privateFixtureDirectory('ci-preparation-child-')
    const marker = join(root, 'started')
    const lifetime = new AbortController()
    const script = `require('node:fs').writeFileSync(process.argv[1], String(process.pid));
      process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`
    const task = runCiRuntimeCommand(process.execPath, ['-e', script, marker],
      { env: process.env, signal: lifetime.signal })
    const result = task.catch(error => error as Error)
    try {
      await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toMatch(/^\d+$/))
      const pid = Number(await readFile(marker, 'utf8'))
      lifetime.abort()
      expect(await result).toMatchObject({ name: 'AbortError' })
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    } finally {
      lifetime.abort()
      await result
      await rm(root, { recursive: true, force: true })
    }
  })
})
