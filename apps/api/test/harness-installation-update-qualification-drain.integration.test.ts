import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { waitForRemoteReview } from './helpers/remoteReviewProduction.js'
import { installationUpdateFixture, profileReader, profiles, latestEvidence, startWhenReady, completedRun }
  from './helpers/harnessInstallationUpdate.js'

describe('installed harness updates', () => {
  it('runs the updated Main suite after an explicit qualification of the previous payload drains', async () => {
    const fixture = await installationUpdateFixture({ workflow: 'single', executionHost: 'main' })
    let blocked = false
    try {
      const reader = await profileReader(fixture)
      const before = (await profiles(fixture, reader))[0]!
      const previousCalls = (await fixture.provider.calls()).length
      await fixture.provider.blockQualification()
      blocked = true
      await fixture.value('harness_qualification_run', { harness: 'codex' })
      await waitForRemoteReview(() => fixture.provider.calls(), calls => calls.slice(previousCalls)
        .some(call => call.qualificationSuite !== undefined), 'held explicit suite for the previous payload')
      await fixture.provider.updatePayload()
      const updatedSha = createHash('sha256').update(await readFile(fixture.provider.binary)).digest('hex')
      await waitForRemoteReview(() => profiles(fixture, reader), values =>
        values.every(value => value.qualification === 'qualifying'), 'automatic recovery waiting for the old suite')
      await expect(fixture.start()).rejects.toThrow('HARNESS_PROFILE_CHECK_PENDING')
      expect((await fixture.provider.calls()).slice(previousCalls).filter(call => call.qualificationSuite)).toHaveLength(1)
      await fixture.provider.releaseQualification()
      blocked = false
      await waitForRemoteReview(() => fixture.provider.calls(), calls => calls.some(call =>
        (call.qualificationSuite as { binarySha256?: string } | undefined)?.binarySha256 === updatedSha),
      'the native suite executing against the updated binary')
      await waitForRemoteReview(() => profiles(fixture, reader), values => values.every(value =>
        value.qualification === 'qualified' && value.target.installationFingerprint !== before.target.installationFingerprint),
      'persisted qualification for the new installation')
      const proof = (await latestEvidence(fixture))[0]!
      expect(proof.qualified).toBe(true)
      expect(proof.target.installationFingerprint).toBe((await profiles(fixture, reader))[0]!.target.installationFingerprint)
      const result = await fixture.db.pool.query<{ status: string }>(
        'select status from harness_qualifications where binary_sha256=$1', [updatedSha])
      expect(result.rows.map(row => row.status)).toEqual(['passed'])
      await completedRun(fixture, (await startWhenReady(fixture))!.run.id)
    } finally {
      if (blocked) await fixture.provider.releaseQualification()
      await fixture.close()
    }
  }, 240_000)
})
