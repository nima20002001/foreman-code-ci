import { beforeAll, describe, expect, it } from 'vitest'
import { assertInstalledWorkflowRestart } from './helpers/installedWorkflowRestart.js'
import { installationUpdateFixture } from './helpers/harnessInstallationUpdate.js'

describe('installed Main-local workflows across systemd restart', () => {
  let recovered: Awaited<ReturnType<typeof assertInstalledWorkflowRestart>>
  const setupPhases = new Map<string, number>()
  beforeAll(async () => {
    const fixture = await installationUpdateFixture({
      workflow: 'interval',
      executionHost: 'main',
      installedMainService: true,
      reportPhase: (phase, elapsedMs) => {
        setupPhases.set(phase, elapsedMs)
        if (phase === 'source repository and workflow seed') {
          // Leave the three-minute file budget for native admission, restart and settlement.
          expect(elapsedMs).toBeLessThan(45_000)
        }
      },
    })
    try {
      recovered = await assertInstalledWorkflowRestart('admitting interval', fixture)
    } finally {
      await fixture.close()
    }
  }, 600_000)

  it('packages the installed API within the restart scenario setup budget', () => {
    expect(setupPhases.get('source repository and workflow seed')).toBeLessThan(45_000)
  })

  it('reattaches graph work and its admitting interval check, then closes their processes', () => {
    expect(recovered.run.executionState).toBe('running')
  })

  it('persists both original turn admissions before recovering the blocked interval session', () => {
    const active = recovered.executions.filter(execution => execution.state === 'running')
    expect(active).toHaveLength(2)
    for (const execution of active) {
      expect(recovered.activity.some(activity => activity.harnessExecutionId === execution.id
        && activity.payload.nativeEventType === 'turn.started')).toBe(true)
    }
  })
})
