import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { HostHarnessInstanceCheckResultSchema } from '@foreman-code/contracts/harness-registry'
import { installationUpdateFixture, startWhenReady, runningTurn, completedRun, profileReader, profiles }
  from './helpers/harnessInstallationUpdate.js'
import { waitForRemoteReview } from './helpers/remoteReviewProduction.js'

describe('planned API restart near a worker credential expiry', () => {
  it('renews the surviving Agent credential before detaching, so the restarted API keeps the same execution', async () => {
    const fixture = await installationUpdateFixture({ workflow: 'single', executionHost: 'main' })
    let blocked = false
    try {
      await fixture.provider.blockWorkflowTurns()
      blocked = true
      const started = (await startWhenReady(fixture))!
      const original = await runningTurn(fixture)
      const [execution] = await waitForRemoteReview(() => fixture.executions(started.run.id), executions =>
        executions.some(item => item.nativeSessionId === original.sessionId && item.state === 'running'),
      'persisted active execution')
      await waitForRemoteReview(() => fixture.details(started.run.id), details =>
        details.activity.some(activity => activity.harnessExecutionId === execution!.id
          && activity.payload.nativeEventType === 'turn.started'), 'persisted native turn admission')
      const reader = await profileReader(fixture)
      const profile = (await profiles(fixture, reader))[0]!
      // Requalification can finish between native admission and restart recovery.
      const checked = HostHarnessInstanceCheckResultSchema.parse(await fixture.value('harness_instance_check', {
        commandId: randomUUID(), instanceId: profile.instanceId,
        expectedRevision: profile.revision, target: profile.target,
      }))
      expect(checked.proof.qualified).toBe(true)
      expect((await profiles(fixture, reader))[0]).toMatchObject({
        instanceRevision: profile.instanceRevision, target: profile.target, qualification: 'qualified',
      })
      // The deploy begins shortly before the persisted lease would expire, outside the in-process renewal window.
      const shortened = await fixture.db.pool.query(`update management_principals p
        set expires_at=clock_timestamp()+interval '10 seconds' from worker_credential_bindings b
        where b.principal_id=p.id and b.execution_id=$1 and b.revoked_at is null and p.revoked_at is null
        returning p.expires_at`, [execution!.id])
      expect(shortened.rowCount).toBe(1)
      const originalExpiry = shortened.rows[0]!.expires_at as Date
      const lease = async () => (await fixture.db.pool.query<{ live: boolean; remaining_ms: number }>(
        `select p.revoked_at is null and b.revoked_at is null and p.expires_at>clock_timestamp() as live,
          (extract(epoch from (p.expires_at-clock_timestamp()))*1000)::float8 as remaining_ms
         from worker_credential_bindings b join management_principals p on p.id=b.principal_id
         where b.execution_id=$1 and b.purpose='workflow'`, [execution!.id])).rows[0]!
      await fixture.restartMain({ mode: 'graceful', afterShutdown: async () => {
        expect(await lease()).toMatchObject({ live: true })
        expect((await lease()).remaining_ms).toBeGreaterThan(5 * 60_000)
        // The API stays down past the original expiry, as a full install does.
        await waitForRemoteReview(async () => (await fixture.db.pool.query<{ passed: boolean }>(
          'select clock_timestamp()>$1::timestamptz as passed', [originalExpiry])).rows[0]!.passed,
        passed => passed, 'the original credential expiry passing while the API is down')
        expect(() => process.kill(original.pid, 0)).not.toThrow()
      } })
      await fixture.provider.releaseWorkflowTurns()
      blocked = false
      const finished = await completedRun(fixture, started.run.id)
      expect(finished.executions).toHaveLength(1)
      expect(finished.executions[0]).toMatchObject({ id: execution!.id, attempt: execution!.attempt,
        nativeSessionId: original.sessionId, state: 'completed', result: { outcome: 'succeeded' } })
    } finally {
      if (blocked) await fixture.provider.releaseWorkflowTurns()
      await fixture.close()
    }
  }, 240_000)
})
