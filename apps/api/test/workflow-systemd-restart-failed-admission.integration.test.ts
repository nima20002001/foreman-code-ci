import { RuntimeBuildIdentitySchema } from '@foreman-code/contracts'
import { describe, expect, it } from 'vitest'
import { installationUpdateFixture } from './helpers/harnessInstallationUpdate.js'
import { assertInstalledWorkflowRestart } from './helpers/installedWorkflowRestart.js'

describe('installed Main-local workflows across systemd restart', () => {
  it('closes the failed interval admission and preserves graph work during restart', async () => {
    const fixture = await installationUpdateFixture({ workflow: 'interval', executionHost: 'main',
      installedMainService: true, sourceAccessMode: 'read-only' })
    try {
      const buildIdentityUrl = () => new URL('/api/runtime/build-identity/v1', fixture.origin())
      const readBuildIdentity = () => fetch(buildIdentityUrl(), {
        headers: { authorization: `Bearer ${fixture.writer.token}` },
      })
      const denied = await fetch(buildIdentityUrl(), {
        headers: { authorization: 'Bearer invalid-fixture-credential' },
      })
      expect(denied.status).toBe(401)
      const response = await readBuildIdentity()
      expect(response.status).toBe(200)
      const identity = RuntimeBuildIdentitySchema.parse(await response.json())
      await assertInstalledWorkflowRestart('failed admission', fixture)
      const restartedResponse = await readBuildIdentity()
      expect(restartedResponse.status).toBe(200)
      expect(RuntimeBuildIdentitySchema.parse(await restartedResponse.json())).toEqual(identity)
    } finally {
      await fixture.close()
    }
  }, 600_000)
})
