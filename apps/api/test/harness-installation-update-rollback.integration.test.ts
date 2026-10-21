import { describe, expect, it } from 'vitest'
import { SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { placementDigest } from '../src/modules/placement/binding.js'
import { waitForRemoteReview } from './helpers/remoteReviewProduction.js'
import {
  installationUpdateFixture, profileReader, profiles, runningTurn,
  pinnedPlacements, latestEvidence, startWhenReady, completedRun,
}
  from './helpers/harnessInstallationUpdate.js'

describe('installed harness updates', () => {
  it('keeps a Worker Run on its original profile proof through a payload update and rollback', async () => {
    const fixture = await installationUpdateFixture({ workflow: 'single', executionHost: 'worker',
      // Exercise passive update detection at the production cadence without saturating native fixture IO.
      installationRefreshIntervalMs: 5_000 })
    let blocked = false
    try {
      const reader = await profileReader(fixture)
      const before = await profiles(fixture, reader)
      expect(before).toHaveLength(1)
      const original = before[0]!
      await fixture.provider.blockWorkflowTurns()
      blocked = true
      const started = (await startWhenReady(fixture))!
      const active = await waitForRemoteReview(async () => {
        // The process fixture leaves periodic engine reconciliation to the caller.
        await fixture.reconcileReviews()
        const details = SavedRunDetailsSchema.parse(await fixture.value('run_get', {
          detail: 'full', workspaceId: started.run.workspaceId, runId: started.run.id,
        }))
        if (details.run.outcome === 'failed') {
          throw new Error(`Worker Run failed before its blocked turn: ${JSON.stringify(details.run.result)}`)
        }
        return details
      }, details => details.executions.some(execution => execution.state === 'running'
        && execution.nativeSessionId !== undefined), 'active Worker execution through MCP')
      expect(active.run.executionState).toBe('running')
      expect(active.executions).toHaveLength(1)
      const turn = await runningTurn(fixture)
      expect(active.executions[0]!.nativeSessionId).toBe(turn.sessionId)
      const pins = await pinnedPlacements(fixture, started.run.id)
      await fixture.provider.updatePayload()
      await waitForRemoteReview(async () => {
        const values = await profiles(fixture, reader)
        for (const value of values) {
          if (value.target.installationFingerprint === original.target.installationFingerprint) continue
          expect(value.qualificationFailure, JSON.stringify({
            qualification: value.qualification,
            failure: value.qualificationFailure,
            nativeFailures: fixture.failures(),
          })).toBeUndefined()
        }
        return values
      }, values =>
        values.length === before.length && values.every(value => value.qualification === 'qualified'
          && value.revision === original.revision + 1
          && value.target.installationFingerprint !== original.target.installationFingerprint),
      'qualified intermediate payload')
      await fixture.provider.restorePayload()
      await waitForRemoteReview(() => profiles(fixture, reader), values =>
        values.length === before.length && values.every(value => value.qualification === 'qualified'
          && value.revision === original.revision + 2
          && value.target.installationFingerprint === original.target.installationFingerprint), 'qualified rollback')
      const latest = (await latestEvidence(fixture))[0]!
      const next = (await startWhenReady(fixture))!
      const newPins = await pinnedPlacements(fixture, next.run.id)
      expect(newPins[0]!.payload).toMatchObject({ profileProofDigest: placementDigest(latest) })
      expect(newPins[0]!.payload).not.toEqual(pins[0]!.payload)
      expect(process.kill(turn.pid, 0)).toBe(true)
      await fixture.provider.releaseWorkflowTurns()
      blocked = false
      const finished = await completedRun(fixture, started.run.id)
      await completedRun(fixture, next.run.id)
      expect(finished.executions).toHaveLength(1)
      expect(finished.executions[0]).toMatchObject({
        id: active.executions[0]!.id, attempt: active.executions[0]!.attempt,
        nativeSessionId: turn.sessionId, state: 'completed',
      })
      expect(await pinnedPlacements(fixture, started.run.id)).toEqual(pins)
      expect(await fixture.provider.calls()).toContainEqual({ workflowCompleted: turn })
    } finally {
      if (blocked) await fixture.provider.releaseWorkflowTurns()
      await fixture.close()
    }
  }, 240_000)
})
