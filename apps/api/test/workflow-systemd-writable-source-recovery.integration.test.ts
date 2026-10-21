import { describe, it } from 'vitest'
import { assertInstalledWorkflowRestart } from './helpers/installedWorkflowRestart.js'

describe('installed Main-local workflows across systemd restart', () => {
  it('reattaches graph work and its writable source check, then closes their processes', async () => {
    await assertInstalledWorkflowRestart('writable source')
  }, 600_000)
})
