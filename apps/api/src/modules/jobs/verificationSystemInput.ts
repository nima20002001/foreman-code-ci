import { captureVerificationInventory } from '../../../../../scripts/verification-runner.mjs'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { JobVerificationOfflineSeedReceiptSchema, JobVerificationRepositoryContextSchema, JobVerificationQualificationCandidateSchema }
  from '@foreman-code/contracts/job-verification-runtime'
import type { JobSystemInput } from '../files/jobInputs/delivery.js'
import type { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { readProtectedRuntimeFile,
  type InstalledRuntimeConfigurationLocation } from './installedRuntimeHost.js'
import { readInstalledVerificationConfiguration } from './installedVerificationRuntime.js'
import { requireJobGitMounts, verifyJobGitMounts } from './privateGitMounts.js'
import { verificationRepositoryContext } from './executorOutputs.js'

export function createVerificationSystemInput(input: {
  configuration: InstalledRuntimeConfigurationLocation | null
  journal(): Promise<RemoteOperationJournal>
}): JobSystemInput {
  return async (execution, source, signal) => {
    if (execution.schemaVersion !== 2) return undefined
    signal.throwIfAborted()
    const journal = await input.journal()
    const qualification = await journal.qualifiedJobRuntime(execution)
    const result = qualification.result
    if (result?.outcome !== 'qualified' || result.measurement.schemaVersion !== 2
      || qualification.candidate.fingerprint.schemaVersion !== 3) {
      throw new Error('Original verification measurement required for input preparation.')
    }
    const candidate = JobVerificationQualificationCandidateSchema.parse(qualification.candidate)
    const configuration = await readInstalledVerificationConfiguration(input.configuration, candidate.profile)
    const bytes = await readProtectedRuntimeFile({ path: configuration.seedReceiptPath,
      ownerUid: input.configuration!.ownerUid }, 16 * 1024 * 1024)
    const seedDigest = createHash('sha256').update(bytes).digest('hex')
    if (seedDigest !== configuration.seedReceiptSha256
      || seedDigest !== qualification.candidate.fingerprint.seedReceiptSha256) {
      throw new Error('Protected offline seed receipt changed after qualification.')
    }
    const seed = JobVerificationOfflineSeedReceiptSchema.parse(JSON.parse(bytes.toString('utf8')))
    if (!isDeepStrictEqual(configuration.machine.resources, execution.acceptedSpec.verification.resources)) {
      throw new Error('Protected verification resources differ from acceptance.')
    }
    const lockfile = seed.dependencyInputs.find(value => value.path === 'pnpm-lock.yaml')!
    await verifyJobGitMounts(execution, source)
    signal.throwIfAborted()
    return JobVerificationRepositoryContextSchema.parse(verificationRepositoryContext({
      execution, measurement: result.measurement,
      requiredPortions: captureVerificationInventory(source.privateRepositoryRoot, execution.acceptedSpec.verification.suite,
        { partition: execution.acceptedSpec.verification.parameters.partition }), gitMounts: requireJobGitMounts(execution, source),
      preseedFacts: { lockfileSha256: lockfile.sha256, pnpmVersion: '11.27.0',
        platform: seed.platform.os, architecture: seed.platform.arch,
        provenanceDigest: seed.provenanceDigest, minimumReleaseAgeMinutes: seed.minimumReleaseAge,
        releaseAgeVerified: true },
    }))
  }
}
