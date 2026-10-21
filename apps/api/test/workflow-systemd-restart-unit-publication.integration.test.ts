import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { publishRestartUnit } from './helpers/installedRestartService.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'

describe('installed Main-local workflows across systemd restart', () => {
  it('publishes the restart service when its configuration directory does not exist', async () => {
    const directory = await privateFixtureDirectory('restart-unit-')
    try {
      const unit = join(directory, '.config/systemd/user/restart.service')
      const service = '[Service]\nExecStart=/usr/bin/true\n'
      await publishRestartUnit(unit, service)
      expect(await readFile(unit, 'utf8')).toBe(service)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
