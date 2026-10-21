import { afterAll, beforeAll } from 'vitest'
import { installationUpdateFixture } from './harnessInstallationUpdate.js'

export function useInstalledRestartFixture() {
  let fixture: Awaited<ReturnType<typeof installationUpdateFixture>> | undefined
  beforeAll(async () => {
    fixture = await installationUpdateFixture({
      workflow: 'interval', executionHost: 'main', installedMainService: true,
    })
  }, 600_000)

  afterAll(async () => { await fixture?.close() }, 600_000)

  return () => {
    if (!fixture) throw new Error('Installed restart fixture setup did not complete.')
    return fixture
  }
}
