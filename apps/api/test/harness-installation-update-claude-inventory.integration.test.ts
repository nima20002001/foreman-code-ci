import { describe, expect, it } from 'vitest'
import { waitForRemoteReview } from './helpers/remoteReviewProduction.js'
import {
  installationUpdateFixture, profileReader, profiles, latestEvidence, runningTurn, pinnedPlacements, completedRun,
}
  from './helpers/harnessInstallationUpdate.js'
import { answerWithCompletedEnvelope, completedEnvelopeText } from './helpers/workflowActiveTurnRestart.js'

describe('installed harness updates', () => {
  it('keeps a Main Codex Run and its pinned outputs valid when only Claude inventory changes', async () => {
    const fixture = await installationUpdateFixture({ workflow: 'single', executionHost: 'main', claudeInventory: true })
    let blocked = false
    try {
      const reader = await profileReader(fixture)
      const before = await profiles(fixture, reader)
      const proofs = await latestEvidence(fixture)
      const inventory = await fixture.inventory()
      const claudeFingerprint = inventory.installations.find(value => value.driverId === 'claude')!.installationFingerprint
      await answerWithCompletedEnvelope(fixture)
      await fixture.provider.blockWorkflowTurns()
      blocked = true
      const started = await fixture.start()
      const turn = await runningTurn(fixture)
      const pins = await pinnedPlacements(fixture, started.run.id)
      const measurements = (await fixture.db.pool.query(
        'select qualification,evidence from host_harness_measurements order by identity_hash')).rows
      await fixture.claudeInventory!.updatePayload()
      await waitForRemoteReview(() => fixture.inventory(), value => value.installations.some(installation =>
        installation.driverId === 'claude' && installation.installationFingerprint !== claudeFingerprint),
      'Claude-only inventory replacement')
      await waitForRemoteReview(() => profiles(fixture, reader), values =>
        values.every(value => value.qualification === 'qualified'), 'automatic recovery after Claude-only change')
      expect(await profiles(fixture, reader)).toEqual(before)
      expect(await latestEvidence(fixture)).toEqual(proofs)
      expect((await fixture.db.pool.query(
        'select qualification,evidence from host_harness_measurements order by identity_hash')).rows)
        .toEqual(measurements)
      expect(process.kill(turn.pid, 0)).toBe(true)
      await fixture.provider.releaseWorkflowTurns()
      blocked = false
      await completedRun(fixture, started.run.id)
      expect(await pinnedPlacements(fixture, started.run.id)).toEqual(pins)
      const calls = await fixture.provider.calls()
      expect(calls).toContainEqual({ workflowCompleted: turn })
      const executions = await fixture.executions(started.run.id)
      expect(executions).toHaveLength(1)
      expect(executions[0]!.result).toMatchObject({ outcome: 'succeeded', output: { text: completedEnvelopeText } })
    } finally {
      if (blocked) await fixture.provider.releaseWorkflowTurns()
      await fixture.close()
    }
  }, 240_000)
})
