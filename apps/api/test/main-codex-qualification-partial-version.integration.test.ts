import { expect, it } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { HarnessQualificationListSchema } from '@foreman-code/contracts/harness-qualification'
import { installationUpdateFixture, profileReader, startWhenReady, completedRun }
  from './helpers/harnessInstallationUpdate.js'
import { waitForRemoteReview } from './helpers/remoteReviewProduction.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

it('automatically recovers qualification after partial version output from an unchanged binary on restart', async () => {
  const fixture = await installationUpdateFixture({ workflow: 'single', executionHost: 'main' })
  let invalidVersions = false
  try {
    const reader = await profileReader(fixture)
    const qualifications = async () => {
      const response = await fixture.call('harness_qualifications_list', {}, reader)
      expect(response.isError).not.toBe(true)
      return HarnessQualificationListSchema.parse(decodeMcpToolResult(response))
    }
    const original = (await qualifications()).qualifications.find(record => record.status === 'qualified')!
    expect(original).toBeDefined()
    await expectMcpAccessDenied(fixture.call('harness_qualification_run', { harness: 'codex' }, reader))
    await fixture.restartMain({ mode: 'graceful', workingDirectory: fixture.directory,
      afterShutdown: async () => {
        await fixture.provider.invalidateVersions()
        invalidVersions = true
      } })
    await waitForRemoteReview(() => fixture.provider.startupActivity(), activity =>
      activity.some(event => event.invalidVersion === true), 'partial startup version output')
    expect((await qualifications()).qualifications.some(record => record.status === 'failed'
      && record.binarySha256 === original.binarySha256)).toBe(false)
    // One attempt: the shared MCP helper replays retryable answers, which would outwait the check.
    await expect(fixture.start({ replay: false })).rejects.toThrow('HARNESS_PROFILE_CHECK_PENDING')
    await fixture.provider.restoreVersions()
    invalidVersions = false
    await waitForRemoteReview(qualifications, result => result.qualifications.some(record =>
      record.status === 'qualified' && record.binarySha256 === original.binarySha256
        && record.startedAt !== original.startedAt), 'automatic qualification after partial version output')
    await expectMcpAccessDenied(fixture.call('harness_qualification_run', { harness: 'codex' }, reader))
    const started = (await startWhenReady(fixture))!
    expect((await completedRun(fixture, started.run.id)).run.workflowVersionId).toBe(fixture.version.id)
  } finally {
    if (invalidVersions) await fixture.provider.restoreVersions()
    await fixture.close()
  }
}, 240_000)
