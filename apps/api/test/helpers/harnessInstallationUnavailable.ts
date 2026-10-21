import { expect } from 'vitest'
import { localWorkflowSourceClosed } from '../../src/modules/sources/workflowCleanup.js'
import { waitForRemoteReview } from './remoteReviewProduction.js'
import {
  installationUpdateFixture, profileReader, profiles, runningTurn, pinnedPlacements, startWhenReady, completedRun,
}
  from './harnessInstallationUpdate.js'

export async function retainsRunAcrossUnavailableInstallation(executionHost: 'main' | 'worker') {
  const fixture = await installationUpdateFixture({ workflow: 'single', executionHost })
  let blocked = false
  try {
    const reader = await profileReader(fixture)
    const before = (await profiles(fixture, reader))[0]!
    await fixture.provider.blockWorkflowTurns()
    blocked = true
    const started = await fixture.start()
    const turn = await runningTurn(fixture)
    const pins = await pinnedPlacements(fixture, started.run.id)
    await fixture.provider.removePayload()
    const unavailable = await waitForRemoteReview(() => fixture.inventory(), value => value.installations.some(installation =>
      installation.driverId === 'codex' && !installation.installed && installation.installationFingerprint === null),
    'unavailable intermediate inventory')
    expect(unavailable.installations.find(installation => installation.driverId === 'codex')).toMatchObject({
      harnessInstallationId: before.target.harnessInstallationId,
      installed: false,
      installationFingerprint: null,
    })
    const unavailableProfiles = await waitForRemoteReview(() => profiles(fixture, reader), values => values.every(value =>
      value.qualification === 'unqualified' && value.qualificationFailure !== undefined), 'unavailable profile readback')
    expect(unavailableProfiles).toHaveLength(1)
    expect(unavailableProfiles[0]).toMatchObject({
      instanceId: before.instanceId,
      revision: before.revision,
      instanceRevision: before.instanceRevision,
      target: before.target,
      configuration: before.configuration,
      qualificationFailure: { code: 'HARNESS_INSTALLATION_UNAVAILABLE' },
    })
    await expect(fixture.start()).rejects.toThrow('HARNESS_INSTALLATION_INVALID')
    expect(process.kill(turn.pid, 0)).toBe(true)
    await fixture.provider.updatePayload()
    await waitForRemoteReview(() => profiles(fixture, reader), values => values.every(value =>
      value.qualification === 'qualified' && value.target.installationFingerprint !== before.target.installationFingerprint),
    'qualified replacement after missing inventory')
    const next = (await startWhenReady(fixture))!
    await fixture.provider.releaseWorkflowTurns()
    blocked = false
    await completedRun(fixture, started.run.id)
    await completedRun(fixture, next.run.id)
    if (executionHost === 'main') {
      const executions = await fixture.db.pool.query<{ id: string }>(
        'select id from harness_executions where run_id=any($1::text[])', [[started.run.id, next.run.id]])
      expect(executions.rows).toHaveLength(2)
      for (const execution of executions.rows) {
        expect(await localWorkflowSourceClosed(fixture.db.pool, execution.id)).toBe(true)
      }
    }
    expect(await pinnedPlacements(fixture, started.run.id)).toEqual(pins)
    expect(await fixture.provider.calls()).toContainEqual({ workflowCompleted: turn })
    expect((await pinnedPlacements(fixture, next.run.id))[0]!.payload).toMatchObject({
      installationFingerprint: (await profiles(fixture, reader))[0]!.target.installationFingerprint,
    })
  } finally {
    if (blocked) await fixture.provider.releaseWorkflowTurns()
    await fixture.close()
  }
}
