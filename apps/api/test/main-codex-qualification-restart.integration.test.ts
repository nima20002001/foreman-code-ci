import { expect, it } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { HarnessCompatibilityListSchema } from '@foreman-code/contracts'
import { HarnessQualificationListSchema } from '@foreman-code/contracts/harness-qualification'
import { installationUpdateFixture, profileReader, pinnedPlacements, startWhenReady, completedRun }
  from './helpers/harnessInstallationUpdate.js'
import { waitForRemoteReview } from './helpers/remoteReviewProduction.js'

it('automatically restores Main Codex admission after deployment and cold-start inspection timeouts', async () => {
  const fixture = await installationUpdateFixture({ workflow: 'single', executionHost: 'main' })
  let versionsBlocked = false
  try {
    const reader = await profileReader(fixture)
    const qualifications = async () => {
      const response = await fixture.call('harness_qualifications_list', {}, reader)
      expect(response.isError).not.toBe(true)
      return HarnessQualificationListSchema.parse(decodeMcpToolResult(response))
    }
    const original = (await qualifications()).qualifications.find(record => record.status === 'qualified')!
    expect(original).toBeDefined()
    const installation = (await fixture.inventory()).installations.find(record => record.driverId === 'codex')!
    await fixture.restartMain({ mode: 'graceful', workingDirectory: fixture.directory,
      afterShutdown: async () => {
        await fixture.provider.blockVersions()
        versionsBlocked = true
      } })
    const changed = (await fixture.inventory()).installations.find(record => record.driverId === 'codex')!
    expect(changed.installationFingerprint).toBe(installation.installationFingerprint)
    expect(changed.launcher.resolvedLauncher).toBe(installation.launcher.resolvedLauncher)
    expect(changed.environmentGeneration).not.toBe(installation.environmentGeneration)
    expect(changed.connectionGeneration).not.toBe(installation.connectionGeneration)
    const timedOut = await waitForRemoteReview(async () => HarnessCompatibilityListSchema.parse(
      await fixture.value('harness_compatibility_list', {})), result => result.harnesses.some(report =>
      report.status === 'unavailable' && report.reason?.code === 'CHECK_TIMEOUT' && report.installedVersion === null),
    'startup compatibility timeout')
    const firstCheckId = timedOut.harnesses.find(report => report.reason?.code === 'CHECK_TIMEOUT')!.checkId
    await waitForRemoteReview(async () => HarnessCompatibilityListSchema.parse(
      await fixture.value('harness_compatibility_list', {})), result => result.harnesses.some(report =>
      report.checkId !== firstCheckId && report.status === 'unavailable'
        && report.reason?.code === 'CHECK_TIMEOUT' && report.installedVersion === null),
    'automatic compatibility retry timeout while version commands remain blocked')
    await expect(fixture.start()).rejects.toThrow('HARNESS_PROFILE_CHECK_PENDING')
    await fixture.provider.releaseVersions()
    versionsBlocked = false
    await waitForRemoteReview(qualifications, result => result.qualifications.some(record =>
      record.status === 'qualified' && record.binarySha256 === original.binarySha256
        && record.suiteRevision === original.suiteRevision && record.startedAt !== original.startedAt),
    'automatic Main qualification readback')
    await waitForRemoteReview(async () => HarnessCompatibilityListSchema.parse(
      await fixture.value('harness_compatibility_list', {})), result => result.harnesses.some(report =>
      report.status === 'probe-passed' && report.installedVersion === original.version),
    'automatic compatibility recovery')
    await profileReader(fixture)
    const started = (await startWhenReady(fixture))!
    const placements = await pinnedPlacements(fixture, started.run.id)
    expect(placements.filter(placement => placement.payload.kind === 'agent').map(placement => placement.hostRef))
      .toEqual([fixture.hostRef])
    expect((await completedRun(fixture, started.run.id)).run.workflowVersionId).toBe(fixture.version.id)
  } finally {
    if (versionsBlocked) await fixture.provider.releaseVersions()
    await fixture.close()
  }
}, 240_000)
