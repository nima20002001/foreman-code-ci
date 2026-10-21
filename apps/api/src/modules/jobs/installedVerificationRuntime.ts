import { InstalledVerificationRuntimeConfigurationSchema, InstalledVerificationRuntimeCaptureInputSchema,
  MAX_VERIFICATION_CONFIGURATION_BYTES, type InstalledVerificationRuntimeCaptureInput,
  type InstalledVerificationRuntimeConfiguration } from './installedVerificationConfiguration.js'
import { readVerificationQuotaPool } from './quotaOwnership.js'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { verifySourceManifest } from '../sources/manifest.js'
import { openPrivateRoot } from '../sources/privateFilesystem.js'
import { verifyMaterializedSourceTree } from '../sources/materialization.js'
import { bootIdentity } from '../harnesses/recovery/linuxIdentity.js'
import { JobVerificationRuntimeFingerprintSchema, JobVerificationOfflineSeedReceiptSchema, JobVerificationQualificationCandidateSchema,
  type JobVerificationProfile, type JobQualificationCandidateRecord }
  from '@foreman-code/contracts/job-verification-runtime'
import { DomainError } from '../errors.js'
import { captureJobRuntimeConfiguration, fingerprintQualificationPath, qualificationMountId } from './qualification.js'
import { readFile } from 'node:fs/promises'
import { readProtectedRuntimeFile, type InstalledRuntimeConfigurationLocation,
  type InstalledRuntimeObservedHost } from './installedRuntimeConfiguration.js'
import { findRetainedRuntimeConfiguration } from './retainedRuntimeConfiguration.js'

const hash = (value: unknown) => createHash('sha256').update(canonicalGraphJson(value)).digest('hex')

export async function readInstalledVerificationConfiguration(
  location: InstalledRuntimeConfigurationLocation | null, profile: JobVerificationProfile,
): Promise<InstalledVerificationRuntimeConfiguration> {
  const configuration = await findRetainedRuntimeConfiguration(location, InstalledVerificationRuntimeConfigurationSchema,
    value => isDeepStrictEqual(value.root, profile.root)
      && value.machine.sourceCommit === profile.sourceCommit
      && value.machine.imageDigest === profile.spec.policy.imageDigest
      && value.machine.toolchainDigest === profile.spec.policy.toolchainDigest
      && isDeepStrictEqual(value.machine.resources, profile.spec.resources)
      && isDeepStrictEqual(value.machine.network, profile.spec.policy.network)
      && isDeepStrictEqual(value.machine.approvalConfig, profile.approvalConfig), MAX_VERIFICATION_CONFIGURATION_BYTES)
  if (!configuration) {
    throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED', 'No protected runtime matches this project and profile.', 409)
  }
  return configuration
}

/** Reads installer-selected protected bytes; it does not run or qualify a runtime. */
export async function captureInstalledVerificationRuntimeConfiguration(raw: InstalledVerificationRuntimeCaptureInput) {
  const input = InstalledVerificationRuntimeCaptureInputSchema.parse(raw)
  const descriptor = input.descriptor
  const [runtime, oci, findmnt] = await Promise.all([
    fingerprintQualificationPath(descriptor.runtimeExecutable, true),
    fingerprintQualificationPath(descriptor.ociExecutable, true),
    fingerprintQualificationPath(descriptor.findmntExecutable, true),
  ])
  if (!descriptor.quotaPool) throw new DomainError('JOB_QUOTA_UNAVAILABLE', 'Protected per-Job quota pool is required.', 409)
  const quotaReadbacks = await readVerificationQuotaPool(descriptor.quotaPool, input.root.binding, AbortSignal.timeout(30_000))
  const filesystemUuid = quotaReadbacks[0]?.filesystemUuid
  if (!filesystemUuid || quotaReadbacks.some(value => value.filesystemUuid !== filesystemUuid)) {
    throw new DomainError('JOB_QUOTA_UNAVAILABLE', 'Kernel filesystem UUID readback is required for recovery.', 409)
  }
  const quotaPool = { ...descriptor.quotaPool, filesystemUuid }
  const source = await openPrivateRoot(input.qualificationSource.directory)
  try { await verifyMaterializedSourceTree(source, verifySourceManifest(input.qualificationSource.manifest)) }
  finally { await source.close() }
  const receiptBytes = await readProtectedRuntimeFile({ path: input.seedReceiptPath, ownerUid: process.getuid!() },
    16 * 1024 * 1024)
  const seed = JobVerificationOfflineSeedReceiptSchema.parse(JSON.parse(receiptBytes.toString('utf8')))
  if (!seed.dependencyInputs.every(entry => input.qualificationSource.manifest.entries
    .some(file => file.path === entry.path && file.sha256 === entry.sha256))) {
    throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED', 'Offline seed differs from the approved qualification source.', 409)
  }
  const seedReceiptSha256 = createHash('sha256').update(receiptBytes).digest('hex')
  const tools = await Promise.all(input.toolSources.map(async tool => ({
    kind: tool.kind, executable: tool.executable, version: tool.version,
    binarySha256: (await fingerprintQualificationPath(tool.sourceExecutable, true)).sha256,
  })))
  const configurationDigest = hash(await captureJobRuntimeConfiguration(descriptor.runtimeRoot,
    descriptor.controllerEnvironment, { findmntBinary: descriptor.findmntExecutable,
      findmntBinarySha256: findmnt.sha256!, backingFile: descriptor.backingFile,
      backingBytes: descriptor.backingFile === null ? null : descriptor.volumeCapacityBytes }))
  return InstalledVerificationRuntimeConfigurationSchema.parse({
    schemaVersion: 2, root: input.root,
    descriptor: { ...descriptor, quotaPool, findmntBinarySha256: findmnt.sha256 },
    qualificationSource: input.qualificationSource, seedReceiptPath: input.seedReceiptPath, seedReceiptSha256,
    machine: { ...input.machine, quotaPool, bootId: bootIdentity(), runtimeBinarySha256: runtime.sha256,
      ociBinarySha256: oci.sha256, configurationDigest, seedReceiptSha256, tools },
  })
}

async function assertSeedReceipt(configuration: InstalledVerificationRuntimeConfiguration, ownerUid: number) {
  const bytes = await readProtectedRuntimeFile({ path: configuration.seedReceiptPath, ownerUid }, 16 * 1024 * 1024)
  if (createHash('sha256').update(bytes).digest('hex') !== configuration.seedReceiptSha256) {
    throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED', 'Protected offline seed receipt changed.', 409)
  }
  return JobVerificationOfflineSeedReceiptSchema.parse(JSON.parse(bytes.toString('utf8')))
}

export async function assertVerificationRuntimeEntryContext(candidate: JobQualificationCandidateRecord): Promise<void> {
  if (candidate.fingerprint.schemaVersion !== 3) throw new Error('Verification candidate required.')
  const fingerprint = candidate.fingerprint
  const [runtime, oci, findmnt, root] = await Promise.all([
    fingerprintQualificationPath(fingerprint.runtimeExecutable, true),
    fingerprintQualificationPath(fingerprint.ociExecutable, true),
    fingerprintQualificationPath(candidate.findmntBinary, true),
    fingerprintQualificationPath(candidate.sourceParent),
  ])
  if (fingerprint.bootId !== bootIdentity() || runtime.sha256 !== fingerprint.runtimeBinarySha256
    || oci.sha256 !== fingerprint.ociBinarySha256 || findmnt.sha256 !== candidate.findmntBinarySha256
    || root.device !== fingerprint.root.binding.filesystem.device
    || root.inode !== fingerprint.root.binding.filesystem.inode
    || qualificationMountId(root.path, await readFile('/proc/self/mountinfo', 'utf8')) !== fingerprint.root.binding.filesystem.mountId
    || hash(await captureJobRuntimeConfiguration(candidate.runtimeRoot, candidate.controllerEnvironment, candidate))
      !== fingerprint.configurationDigest) {
    throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED', 'The original verification entry context changed.', 409)
  }
}

export async function inspectInstalledVerificationRuntime(input: {
  configuration: InstalledRuntimeConfigurationLocation | null
  profile: JobVerificationProfile
  host: InstalledRuntimeObservedHost
}) {
  const configuration = await readInstalledVerificationConfiguration(input.configuration, input.profile)
  const { descriptor, machine: recorded } = configuration
  const profile = input.profile
  await assertSeedReceipt(configuration, input.configuration!.ownerUid)
  if (!isDeepStrictEqual(configuration.root, profile.root)
    || !isDeepStrictEqual(descriptor.target.hostRef, input.host.hostRef)
    || !isDeepStrictEqual(descriptor.target.registration, input.host.registration)
    || descriptor.target.mainInstallationId !== input.host.mainInstallationId
    || recorded.bootId !== bootIdentity() || recorded.bootId !== input.host.bootId
    || !isDeepStrictEqual(recorded.resources, profile.spec.resources)
    || !isDeepStrictEqual(recorded.approvalConfig, profile.approvalConfig)
    || !isDeepStrictEqual(recorded.network, profile.spec.policy.network)
    || recorded.imageDigest !== profile.spec.policy.imageDigest
    || recorded.toolchainDigest !== profile.spec.policy.toolchainDigest
    || !profile.sourceCommit || recorded.sourceCommit !== profile.sourceCommit
    || recorded.seedReceiptSha256 !== configuration.seedReceiptSha256) {
    throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED', 'Protected verification installation differs from this profile.', 409)
  }
  const [runtime, oci, findmnt, root] = await Promise.all([
    fingerprintQualificationPath(descriptor.runtimeExecutable, true),
    fingerprintQualificationPath(descriptor.ociExecutable, true),
    fingerprintQualificationPath(descriptor.findmntExecutable, true),
    fingerprintQualificationPath(profile.root.binding.canonicalPath),
  ])
  if (runtime.sha256 !== recorded.runtimeBinarySha256 || oci.sha256 !== recorded.ociBinarySha256
    || findmnt.sha256 !== descriptor.findmntBinarySha256
    || root.device !== profile.root.binding.filesystem.device || root.inode !== profile.root.binding.filesystem.inode
    || qualificationMountId(root.path, await readFile('/proc/self/mountinfo', 'utf8')) !== profile.root.binding.filesystem.mountId) {
    throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED', 'Verification binary or source namespace changed.', 409)
  }
  const configurationDigest = hash(await captureJobRuntimeConfiguration(descriptor.runtimeRoot,
    descriptor.controllerEnvironment, { findmntBinary: descriptor.findmntExecutable,
      findmntBinarySha256: findmnt.sha256!, backingFile: descriptor.backingFile,
      backingBytes: descriptor.backingFile === null ? null : descriptor.volumeCapacityBytes }))
  if (configurationDigest !== recorded.configurationDigest) {
    throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED', 'Verification runtime configuration changed.', 409)
  }
  const fingerprint = JobVerificationRuntimeFingerprintSchema.parse({ ...recorded,
    schemaVersion: 3, profileId: profile.id, profileRevision: profile.revision, specDigest: profile.specDigest,
    root: profile.root, ...descriptor.target })
  return { descriptor, fingerprint, configuration }
}

export async function inspectInstalledVerificationCandidate(input: {
  configuration: InstalledRuntimeConfigurationLocation | null
  candidate: JobQualificationCandidateRecord
  host: InstalledRuntimeObservedHost
}) {
  const candidate = JobVerificationQualificationCandidateSchema.parse(input.candidate)
  const configuration = await readInstalledVerificationConfiguration(input.configuration, candidate.profile)
  await assertSeedReceipt(configuration, input.configuration!.ownerUid)
  const observed = JobVerificationRuntimeFingerprintSchema.parse({ ...configuration.machine,
    schemaVersion: 3, profileId: candidate.fingerprint.profileId,
    profileRevision: candidate.fingerprint.profileRevision, specDigest: candidate.fingerprint.specDigest,
    root: configuration.root, ...configuration.descriptor.target })
  if (!isDeepStrictEqual(observed, candidate.fingerprint)
    || candidate.runtimeRoot !== configuration.descriptor.runtimeRoot
    || candidate.sourceParent !== configuration.root.binding.canonicalPath
    || candidate.findmntBinary !== configuration.descriptor.findmntExecutable
    || candidate.findmntBinarySha256 !== configuration.descriptor.findmntBinarySha256
    || !isDeepStrictEqual(candidate.controllerEnvironment, configuration.descriptor.controllerEnvironment)
    || !isDeepStrictEqual(observed.hostRef, input.host.hostRef)
    || !isDeepStrictEqual(observed.registration, input.host.registration)
    || observed.mainInstallationId !== input.host.mainInstallationId || observed.bootId !== input.host.bootId
    || bootIdentity() !== observed.bootId) {
    throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED', 'The original verification installation changed.', 409)
  }
  await assertVerificationRuntimeEntryContext(candidate)
  const [runtime, oci, root] = await Promise.all([
    fingerprintQualificationPath(observed.runtimeExecutable, true), fingerprintQualificationPath(observed.ociExecutable, true),
    fingerprintQualificationPath(observed.root.binding.canonicalPath),
  ])
  if (runtime.sha256 !== observed.runtimeBinarySha256 || oci.sha256 !== observed.ociBinarySha256
    || root.device !== observed.root.binding.filesystem.device || root.inode !== observed.root.binding.filesystem.inode
    || qualificationMountId(root.path, await readFile('/proc/self/mountinfo', 'utf8')) !== observed.root.binding.filesystem.mountId) {
    throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED', 'The original verification binaries or root changed.', 409)
  }
}
