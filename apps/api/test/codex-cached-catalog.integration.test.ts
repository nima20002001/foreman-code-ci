import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { HostHarnessInstanceCheckResultSchema, HostHarnessOverrideListSchema } from '@foreman-code/contracts/harness-registry'
import { remoteReviewProduction, waitForRemoteReview } from './helpers/remoteReviewProduction.js'
import { latestEvidence } from './helpers/workerProfileRequalification.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

it.each([false, true])('checks cached Codex catalogs through authenticated MCP (missing model: %s)', async missing => {
  const f = await remoteReviewProduction({ workflow: 'sequential', parallelProfileChecks: true, parallelSetup: true })
  try {
    await f.provider.failModelRefresh()
    if (missing) await f.provider.hideModels()
    const profile = f.profiles[0]!
    const input = { commandId: randomUUID(), instanceId: profile.instanceId,
      expectedRevision: profile.revision, target: profile.target }
    const reader = await f.access.issue({ name: 'Profile reader', audience: 'operator',
      grants: [{ actions: ['harnesses:read'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
    await expectMcpAccessDenied(f.call('harness_instance_check', input, reader.token))
    const checked = HostHarnessInstanceCheckResultSchema.parse(await f.value('harness_instance_check', input))
    expect(checked.proof.qualified).toBe(!missing)
    if (missing) {
      expect(checked.proof.failure?.code).toBe('CODEX_MODEL_UNAVAILABLE')
      expect(checked.proof.completedNativeQualification?.record.checks)
        .toContainEqual({ id: 'selected-profile', passed: false, detail: 'CODEX_MODEL_UNAVAILABLE' })
      await expect(f.start()).rejects.toThrow('CODEX_MODEL_UNAVAILABLE')
      expect((await f.db.pool.query('select id from runs')).rows).toEqual([])
    } else {
      expect(checked.proof).toMatchObject({ modelCatalogSource: 'cached' })
      const started = await f.start()
      await waitForRemoteReview(() => f.details(started.run.id), details =>
        details.executions.some(execution => Boolean(execution.nativeSessionId)), 'native launch with cached catalog')
    }
    const persisted = (await latestEvidence(f)).find(proof =>
      proof.configurationFingerprint === checked.proof.configurationFingerprint
      && proof.checkedAt === checked.proof.checkedAt)
    expect(persisted).toEqual(checked.proof)
    const listed = HostHarnessOverrideListSchema.parse(await f.value('harness_instances_list', {
      hostRef: f.hostRef, applicationInstallationId: profile.target.applicationInstallationId,
    }))
    expect(listed.overrides.find(value => value.instanceId === profile.instanceId)?.qualification)
      .toBe(missing ? 'unqualified' : 'qualified')
  } finally { await f.close() }
}, 240_000)
