import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { HostHarnessOverrideListSchema } from '@foreman-code/contracts/harness-registry'
import { HarnessQualificationListSchema } from '@foreman-code/contracts/harness-qualification'
import { waitForRemoteReview } from './helpers/remoteReviewProduction.js'
import { installationUpdateFixture } from './helpers/harnessInstallationUpdate.js'
import { latestEvidence } from './helpers/workerProfileRequalification.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'

const execute = promisify(execFile)

describe('automatic Worker profile qualification', () => {
  it('builds the committed Worker execution graph and starts its packaged CLI', async () => {
    const directory = await privateFixtureDirectory('worker-qualification-artifact-')
    try {
      const repository = fileURLToPath(new URL('../../../', import.meta.url))
      const release = join(directory, 'release')
      await execute(process.execPath, [join(repository, 'scripts/build-worker-artifact.mjs'),
        'apps/worker/artifacts/ubuntu-26.04-x64-target.json', release],
      { cwd: repository, maxBuffer: 4 * 1024 * 1024 })
      const { stdout } = await execute(process.execPath, [join(release, 'src/cli.mjs'), '--help'])
      expect(stdout).toContain('graphql-worker run|doctor|identity-request|initialize-native-runtime')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)

  it('persists a failed automatic check and refuses Start without borrowing the previous installation', async () => {
    const fixture = await installationUpdateFixture({ workflow: 'sequential' })
    try {
      const before = await latestEvidence(fixture)
      expect(before).toHaveLength(fixture.profiles.length)
      expect(before.every(proof => proof.qualified)).toBe(true)
      await fixture.provider.hideModels()
      await fixture.provider.updatePayload()
      const evidence = await waitForRemoteReview(() => latestEvidence(fixture), proofs =>
        proofs.length === fixture.profiles.length && proofs.every(proof =>
          proof.target.installationFingerprint !== before[0]!.target.installationFingerprint && !proof.qualified),
      'persisted failed automatic profile checks')
      expect(evidence.every(proof => proof.failure !== undefined)).toBe(true)
      // Drain independent readbacks before fixture cleanup can stop the Worker.
      const results = await Promise.allSettled([
        waitForRemoteReview(async () => HostHarnessOverrideListSchema.parse(
          await fixture.value('harness_instances_list', { hostRef: fixture.hostRef,
            applicationInstallationId: fixture.profiles[0]!.target.applicationInstallationId })),
        value => value.overrides.every(profile => profile.qualification === 'unqualified'), 'unqualified MCP readback'),
        waitForRemoteReview(async () => {
          try { await fixture.start() } catch (error) { return error }
          throw new Error('A failed profile check admitted a Run.')
        }, error => error instanceof Error && error.message.includes(evidence[0]!.failure!.code),
        'Run refusal after the failed automatic check'),
        fixture.value('harness_qualifications_list', {}).then(result => HarnessQualificationListSchema.parse(result)),
      ])
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Failed automatic profile check readback failed.')
      const value = <T,>(result: PromiseSettledResult<T>): T => {
        if (result.status === 'rejected') throw result.reason
        return result.value
      }
      const profiles = value(results[0])
      const refusal = value(results[1])
      const qualifications = value(results[2])
      expect(profiles.overrides).toHaveLength(fixture.profiles.length)
      expect(refusal).toBeInstanceOf(Error)
      expect((await fixture.db.pool.query('select id from runs')).rows).toEqual([])
      expect(qualifications.qualifications.some(record => record.status === 'failed'
        && evidence.some(proof => proof.checkedAt === record.checkedAt))).toBe(true)
    } finally { await fixture.close() }
  }, 240_000)
})
