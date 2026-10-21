import { describe, expect, it } from 'vitest'
import { installationUpdateFixture, pinnedPlacements, profileReader, profiles, completedRun }
  from './helpers/harnessInstallationUpdate.js'

describe('installed harness updates', () => {
  it('starts a Main-only workflow while discovery on an unused Worker is still blocked', async () => {
    const fixture = await installationUpdateFixture({ workflow: 'single', executionHost: 'main' })
    try {
      const inventory = await fixture.inventory()
      expect(inventory.installations.find(value => value.driverId === 'claude')!.installed).toBe(false)
      expect(await fixture.value('claude_plugins_list', { view: 'installed' })).toMatchObject({
        items: [], marketplaces: [], total: 0,
      })
      const reader = await profileReader(fixture)
      await fixture.blockWorkerDiscovery()
      const started = await fixture.start()
      expect((await pinnedPlacements(fixture, started.run.id)).every(pin => pin.hostRef.kind === 'main')).toBe(true)
      expect((await profiles(fixture, reader))[0]!.qualification).toBe('qualified')
      await completedRun(fixture, started.run.id)
    } finally {
      await fixture.releaseWorkerDiscovery()
      await fixture.close()
    }
  }, 240_000)
})
