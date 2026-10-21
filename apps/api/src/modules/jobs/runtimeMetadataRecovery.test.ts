import { JobVerificationPolicyRequirementsSchema } from '@foreman-code/contracts/job-verification-policy'
import { setImmediate } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { JobVerificationProfileSchema, type JobRuntimeProfileRecord }
  from '@foreman-code/contracts/job-verification-runtime'
import { jobPolicyRequirementsRecord } from '@foreman-code/contracts/job-verification'
import { verificationRuntimeFixture } from '../../../test/helpers/verificationRuntimeFixture.js'
import { buildComputerFixture } from '../../../test/helpers/buildComputerFixture.js'
import { jobRuntimeMetadataFixture } from '../../../test/helpers/jobRuntimeMetadataFixture.js'
import { JOB_RUNTIME_INSPECTION_RETRY_MS, JobRuntimeMetadataRecovery } from './runtimeMetadataRecovery.js'
import type { InstalledJobRuntimeHost } from './runtimeProfileFactory.js'
import { DomainError } from '../errors.js'

function profiles(): JobRuntimeProfileRecord[] {
  const f = verificationRuntimeFixture()
  const fingerprint = f.measurement.fingerprint
  const verification = JobVerificationProfileSchema.parse({ schemaVersion: 2,
    id: fingerprint.profileId, revision: fingerprint.profileRevision,
    workspaceId: fingerprint.root.binding.workspaceId, name: 'Verification runtime',
    root: fingerprint.root, sourceCommit: fingerprint.sourceCommit, specDigest: fingerprint.specDigest,
    approvalConfig: fingerprint.approvalConfig, status: 'qualified', measurement: f.measurement,
    spec: { rootId: fingerprint.root.binding.rootId, bindingRevision: fingerprint.root.binding.bindingRevision,
      resources: f.spec.verification.resources, policy: JobVerificationPolicyRequirementsSchema.parse(jobPolicyRequirementsRecord(f.spec.policy)),
      suites: ['unit'], approvalConfig: { approvalLifetimeMs: fingerprint.approvalConfig.approvalLifetimeMs } },
    createdAt: f.measurement.checkedAt, updatedAt: f.measurement.checkedAt })
  const build = buildComputerFixture(fingerprint.mainInstallationId, fingerprint.root.binding.workspaceId).candidate.profile
  if (build.schemaVersion !== 1) throw new Error('Build fixture required')
  return [verification, jobRuntimeMetadataFixture(build, randomUUID()).profile]
}

describe('mixed runtime metadata recovery', () => {
  it('restores both retained record versions after each Main restart', async () => {
    const saved = profiles()
    for (let restart = 0; restart < 2; restart++) {
      const capture = vi.fn(async (profile: JobRuntimeProfileRecord) => profile.measurement!.fingerprint)
      const host = { currentMetadata: async () => null, capture } as unknown as InstalledJobRuntimeHost
      const pool = { query: async () => ({ rows: saved.map(record => ({ record })) }) } as unknown as pg.Pool
      const recovery = new JobRuntimeMetadataRecovery(pool, host, vi.fn())
      recovery.request()
      await recovery.close()
      expect(capture.mock.calls.map(([profile]) => profile.schemaVersion)).toEqual([2, 1])
      expect(capture.mock.calls.map(([profile]) => profile.id)).toEqual(saved.map(profile => profile.id))
    }
  })
  it('refreshes a verification execution through its saved profile version on reconnect', async () => {
    const saved = profiles()[0]!
    const capture = vi.fn(async () => saved.measurement!.fingerprint)
    const host = { currentMetadata: async () => null, capture } as unknown as InstalledJobRuntimeHost
    const pool = { query: async () => ({ rows: [{ record: saved }] }) } as unknown as pg.Pool
    const recovery = new JobRuntimeMetadataRecovery(pool, host, vi.fn())
    await recovery.refreshExecution('retained-execution')
    await recovery.close()
    expect(capture).toHaveBeenCalledWith(saved)
  })
  it('waits before re-inspecting a profile the installed worker rejected', async () => {
    const saved = profiles()[0]!
    let now = 1_000_000
    const capture = vi.fn<() => Promise<unknown>>(async () => { throw new Error('Protected verification installation differs from this profile.') })
    const host = { currentMetadata: async () => null, capture } as unknown as InstalledJobRuntimeHost
    const pool = { query: async () => ({ rows: [{ record: saved }] }) } as unknown as pg.Pool
    const recovery = new JobRuntimeMetadataRecovery(pool, host, vi.fn(), () => now)
    const scan = async () => {
      recovery.request()
      // All fixture ports resolve immediately; a turn drains their promise chains.
      await setImmediate()
    }
    await scan()
    await scan()
    expect(capture).toHaveBeenCalledTimes(1)
    now += JOB_RUNTIME_INSPECTION_RETRY_MS
    capture.mockImplementationOnce(async () => saved.measurement!.fingerprint)
    await scan()
    await scan()
    expect(capture).toHaveBeenCalledTimes(3)
    await recovery.close()
  })
  it('retries an inspection that only waited for the worker connection', async () => {
    const saved = profiles()[0]!
    const capture = vi.fn<() => Promise<unknown>>(async () => {
      throw new DomainError('JOB_RUNTIME_CONNECTION_CHANGED', 'The original installed qualification connection is unavailable or changed.', 409)
    })
    const host = { currentMetadata: async () => null, capture } as unknown as InstalledJobRuntimeHost
    const pool = { query: async () => ({ rows: [{ record: saved }] }) } as unknown as pg.Pool
    const recovery = new JobRuntimeMetadataRecovery(pool, host, vi.fn(), () => 1_000_000)
    const scan = async () => {
      recovery.request()
      // All fixture ports resolve immediately; a turn drains their promise chains.
      await setImmediate()
    }
    await scan()
    capture.mockImplementationOnce(async () => saved.measurement!.fingerprint)
    await scan()
    expect(capture).toHaveBeenCalledTimes(2)
    await recovery.close()
  })
})
