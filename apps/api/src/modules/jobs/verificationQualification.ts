import { errorMessage } from '../../shared/errorMessage.js'
import { captureVerificationInventory } from '../../../../../scripts/verification-runner.mjs'
import { constants } from 'node:fs'
import { mkdir, open, readFile, readlink, rm, statfs, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { release } from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import type { z } from 'zod'
import type { FileHandle } from 'node:fs/promises'
import { JobTargetSchema } from '@foreman-code/contracts/jobs'
import { JobVerificationReportSchema } from '@foreman-code/contracts/job-verification'
import { JOB_VERIFICATION_OWNER_CONFIGURATION, qualificationUnitWorkers, qualificationIntegrationShards } from '@foreman-code/contracts/job-verification-policy'
import { JOB_INPUT_DIRECTORY, JobBuildInputManifestSchema } from '@foreman-code/contracts/job-inputs'
import { JobVerificationQualificationCandidateSchema, JobVerificationRepositoryContextSchema,
  JobVerificationRuntimeQualificationResultSchema, JobVerificationRuntimeMeasurementSchema,
  JobVerificationOfflineSeedReceiptSchema, JOB_VERIFICATION_BASE_CHECKS,
  type JobRuntimeNativeAdmissionRecord, type JobQualificationCandidateRecord }
  from '@foreman-code/contracts/job-verification-runtime'
import { readInstalledVerificationConfiguration } from './installedVerificationRuntime.js'
import { readProtectedRuntimeFile,
  type InstalledRuntimeConfigurationLocation } from './installedRuntimeConfiguration.js'
import { podmanIsolationCreateArgv, ensureEmptyPodmanHooks, type PodmanIsolationInput } from './executorPodman.js'
import { assertJobRuntimeEntryContext, jobQualificationFingerprint, runQualificationCommand,
  validateVerificationIsolationObservation, type JobQualificationAuthority, type QualificationNativeOwner }
  from './qualification.js'
import { prepareVerificationQualificationSource, restoreVerificationQualificationSource, resetVerificationQualificationWorkload, writeVerificationQualificationContext } from './verificationQualificationSource.js'
import { JobProjectQuotaReadbackSchema, readVerificationQuotaPool, verifyJobQuotaOwnership,
  isKernelQuotaDenial, type JobQuotaReader } from './quotaOwnership.js'
import { JOB_GIT_ENVIRONMENT } from './privateGitMounts.js'
import { jobDigest } from './digest.js'
import { SourceMaterializationRecordSchema } from '@foreman-code/contracts/source-admission'
import { sourceBindingHash } from '../sources/bindingHash.js'
import { createHash } from 'node:crypto'
import { qualificationExecution, publishFailedQualification } from './qualificationExecution.js'
import { reserveVerificationReportSpace, readBoundedJobFile } from './executorOutputs.js'
import { finalizeVerificationPublication } from './verificationPublication.js'
import { interruptActiveQualification } from './qualificationCancellation.js'
import type { QualificationReportPublisher } from './qualificationReports.js'
import type { JobQualificationReport } from '@foreman-code/contracts/job-verification-runtime'

const reportLimits = { 'summary.json': 'summaryBytes', 'junit.xml': 'junitBytes',
  'vitest.json': 'vitestBytes', 'logs.tar.gz': 'logsArchiveBytes' } as const
const reportFiles = Object.keys(reportLimits) as Array<keyof typeof reportLimits>
const idle = 'setInterval(()=>{},1000)'
export async function startVerificationContainer(input: {
  candidate: z.infer<typeof JobVerificationQualificationCandidateSchema>
  owner: Pick<QualificationNativeOwner, 'registerContainer' | 'observeContainer' | 'enterContainer'>
  plan: PodmanIsolationInput
  checked(argv: string[], timeoutMs: number): Promise<string>
}): Promise<string> {
  const { candidate, owner, plan, checked } = input
  await owner.registerContainer(plan.identity, jobQualificationFingerprint(candidate))
  const timeout = candidate.profile.spec.policy.preparationTimeoutMs
  const id = (await checked(podmanIsolationCreateArgv(plan), timeout)).trim()
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Original verification container identity missing.')
  await owner.observeContainer(plan.identity, id)
  await checked(['start', id], timeout)
  await owner.enterContainer(plan.identity, id)
  return id
}
const quotaProbe = `const fs=require('node:fs');const input=JSON.parse(process.argv[1]);
const file='/job-scratch/quota-bytes';let byteError=null,inodeError=null,byteErrno=null,inodeErrno=null,inodeCreated=0;
if(input.phase==='bytes'){
try{const fd=fs.openSync(file,'wx',0o600);try{const bytes=Buffer.alloc(1048576,1);
for(let n=0;n<=Math.ceil(input.bytes/bytes.length);n++){fs.writeSync(fd,bytes);fs.fsyncSync(fd)}}finally{fs.closeSync(fd)}}catch(e){byteError=e.code;byteErrno=e.errno}
}else{
fs.rmSync(file,{force:true});fs.mkdirSync('/job-scratch/quota-inodes',{mode:0o700});
try{for(let n=0;n<=input.inodes;n++){fs.closeSync(fs.openSync('/job-scratch/quota-inodes/'+n,'wx',0o600));inodeCreated++}}catch(e){inodeError=e.code;inodeErrno=e.errno}
fs.rmSync('/job-scratch/quota-inodes',{recursive:true});}
console.log(JSON.stringify({byteError,inodeError,byteErrno,inodeErrno,inodeCreated}));`

/** Every pass comes from full ordinary commands in the admitted image and original quota namespace. */
export async function qualifyVerificationRuntime(input: {
  candidate: JobQualificationCandidateRecord
  admission: JobRuntimeNativeAdmissionRecord
  configuration: InstalledRuntimeConfigurationLocation | null
  authority: JobQualificationAuthority
  signal: AbortSignal
  publishReport?: QualificationReportPublisher | undefined
  now?: () => number
}) {
  const now = input.now ?? Date.now
  const candidate = JobVerificationQualificationCandidateSchema.parse(input.candidate)
  if (!input.publishReport) throw new Error('Canonical qualification Job publication is unavailable.')
  const fingerprint = candidate.fingerprint
  const configuration = await readInstalledVerificationConfiguration(input.configuration, candidate.profile)
  const approval = await input.authority.readApproval(candidate.approvalId)
  if (!approval || approval.status !== 'approved' || approval.fingerprint !== jobQualificationFingerprint(candidate)
    || Date.parse(approval.expiresAt) <= now()) {
    return { outcome: 'denied' as const, closure: 'not_started' as const, reasons: ['approval_denied_or_expired'] }
  }
  const pool = fingerprint.quotaPool
  if (!pool || !isDeepStrictEqual(pool, configuration.descriptor.quotaPool)) {
    throw new Error('Protected per-Job quota pool required for physical qualification.')
  }
  await input.authority.assertCurrent(candidate)
  const owner = await input.authority.reserve(candidate, input.signal)
  if (owner.completedResult) return JobVerificationRuntimeQualificationResultSchema.parse(owner.completedResult)
  if (owner.recoveryRequired) {
    const closed = await owner.close()
    const result = { outcome: 'denied' as const, closure: closed ? 'confirmed' as const : 'unconfirmed' as const,
      reasons: owner.originalResult?.outcome === 'denied' ? owner.originalResult.reasons
        : ['Original qualification was interrupted; its retained owner was reconciled.'] }
    if (closed) await owner.recordResult?.(result)
    return result
  }
  const run = async (binary: string, argv: string[], timeoutMs = 30000) => {
    input.signal.throwIfAborted()
    await input.authority.assertCurrent(candidate)
    await assertJobRuntimeEntryContext(candidate)
    return runQualificationCommand(owner, binary, argv, candidate.controllerEnvironment, input.signal, timeoutMs)
  }
  const podman = (argv: string[], timeoutMs?: number) => run(fingerprint.runtimeExecutable,
    argv[0] === '--remote=false' ? argv : ['--remote=false', ...argv], timeoutMs)
  const checked = async (argv: string[], timeoutMs?: number) => {
    const result = await podman(argv, timeoutMs)
    if (result.exitCode !== 0) {
      throw new Error(`Physical verification ${argv[0]} failed with exit ${result.exitCode}: ${result.stderr.slice(0, 300)}`)
    }
    return result.stdout
  }
  const readQuota: JobQuotaReader = async (saved, directory, signal) => {
    signal.throwIfAborted()
    const result = await run(saved.queryExecutable, [directory, saved.blockDevice])
    if (result.exitCode !== 0) throw new Error('Physical quota readback failed.')
    return JobProjectQuotaReadbackSchema.parse(JSON.parse(result.stdout))
  }
  const claims: Array<{ path: string; file: FileHandle; namespace: string }> = []
  let closed = false
  let denial: Error | undefined
  let result: ReturnType<typeof JobVerificationRuntimeQualificationResultSchema.parse> | undefined
  let pendingReport: Omit<Parameters<typeof publishFailedQualification>[0], 'closeContainer' | 'failure'> | undefined
  try {
    const quotas = await readVerificationQuotaPool(pool, fingerprint.root.binding, input.signal, readQuota)
    for (const slot of pool.slots) {
      const path = join(candidate.sourceParent, `quota-${slot.namespace}.claim.json`)
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      const namespace = join(candidate.sourceParent, slot.namespace, candidate.operationId)
      claims.push({ path, file, namespace })
      await file.writeFile(JSON.stringify({ kind: 'qualification', qualificationId: candidate.qualificationId, operationId: candidate.operationId }))
      await file.sync()
      const claim = await file.stat()
      if (!owner.recordQuotaClaim) throw new Error('Protected qualification quota journal required.')
      await owner.recordQuotaClaim({ path, namespace, device: claim.dev, inode: claim.ino })
      await mkdir(namespace, { mode: 0o700 })
      await verifyJobQuotaOwnership({ pool, binding: fingerprint.root.binding, slot, directory: namespace,
        signal: input.signal, read: readQuota })
    }
    const namespace = claims[0]!.namespace
    const source = await prepareVerificationQualificationSource({ ...configuration.qualificationSource,
      namespace, signal: input.signal })
    const inputRoot = join(source.sourceRoot, JOB_INPUT_DIRECTORY)
    const scratch = join(namespace, 'job-scratch')
    await mkdir(inputRoot, { mode: 0o700 })
    await mkdir(scratch, { mode: 0o700 })
    await writeFile(join(inputRoot, 'manifest.json'), JSON.stringify(JobBuildInputManifestSchema.parse({ version: 1,
      inputSnapshotDigest: jobDigest({ inputs: [], workflowInput: null }), workflowInput: null, files: [] })), { mode: 0o444 })
    await ensureEmptyPodmanHooks(candidate.runtimeRoot)
    const info = JSON.parse(await checked(['info', '--format=json']))
    if (info.host?.serviceIsRemote !== false || info.host?.security?.rootless !== true
      || info.host.cgroupVersion !== 'v2' || info.host.cgroupManager !== 'systemd'
      || info.host.kernel !== release() || info.host.ociRuntime?.path !== fingerprint.ociExecutable) {
      throw new Error('Local rootless cgroup-v2 runtime required.')
    }
    const images = JSON.parse(await checked(['image', 'inspect', fingerprint.imageDigest]))
    const imageId = images[0]?.Id?.replace(/^sha256:/, '')
    if (images.length !== 1 || !/^[a-f0-9]{64}$/.test(imageId ?? '')
      || `sha256:${imageId}` !== fingerprint.imageDigest) {
      throw new Error('The approved immutable verification image changed.')
    }
    let containerSequence = 0
    const createContainer = async () => {
      const identity = `graphql-ci-qualification-${candidate.qualificationId}-${++containerSequence}`
      return startVerificationContainer({ candidate, owner, checked, plan: { identity, ...source,
        runtimeRoot: candidate.runtimeRoot, cwd: source.sourceRoot, argv: ['node', '-e', idle], inputRoot,
        profile: { ...fingerprint.limits, imageDigest: fingerprint.imageDigest }, spoolBytes: candidate.spoolBytes,
        labels: { 'graphql.qualification.identity': identity,
          'graphql.qualification.fingerprint': jobQualificationFingerprint(candidate) },
        verification: { resources: fingerprint.resources, scratchDirectory: scratch },
      } })
    }
    let containerId = await createContainer()
    const ownerSentinel = join(candidate.runtimeRoot, `qualification-${candidate.operationId}-owner-sentinel`)
    await writeFile(ownerSentinel, 'private controller state', { mode: 0o600, flag: 'wx' })
    let observation: Record<string, unknown>
    try {
      observation = JSON.parse(await checked(['exec', containerId, 'node',
        '/opt/graphql-ci/verification-observation.mjs', JSON.stringify({ ownerSentinelPaths: [ownerSentinel],
          tools: fingerprint.tools })]))
    } finally { await rm(ownerSentinel, { force: true }) }
    validateVerificationIsolationObservation({ observation, resources: fingerprint.resources,
      hostPidNamespace: await readlink('/proc/self/ns/pid'), hostNetworkNamespace: await readlink('/proc/self/ns/net'),
      hostCgroupNamespace: await readlink('/proc/self/ns/cgroup'),
      ownerSentinelPaths: [ownerSentinel] })
    const environment = ['CI', 'FOREMAN_CODE_JOB_INPUT_MANIFEST', 'GRAPHQL_JOB_INPUT_MANIFEST',
      'FOREMAN_CODE_VERIFICATION_ENVIRONMENT', 'HOME', 'LANG',
      'PATH', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', ...Object.keys(JOB_GIT_ENVIRONMENT)]
    if (Array.isArray(observation.environment) && observation.environment.includes('HOSTNAME')) environment.push('HOSTNAME')
    if (!isDeepStrictEqual(observation.environment, environment.sort()) || jobDigest(observation.toolchain) !== fingerprint.toolchainDigest
      || !isDeepStrictEqual(observation.tools, fingerprint.tools) || observation.rootfsWriteError !== 'EROFS'
      || observation.gitWriteErrors !== 'EROFS,EROFS,EROFS' || observation.schedulerWrite !== true
      || !Number.isSafeInteger(observation.detachedChildPid) || Number(observation.detachedChildPid) <= 0) {
      throw new Error('Physical image, tools and private Git isolation changed.')
    }
    const quotaResult = JSON.parse(await checked(['exec', containerId, 'node', '-e', quotaProbe,
      JSON.stringify({ phase: 'bytes', bytes: pool.slots[0]!.hardLimitBytes })],
    Math.min(600000, Date.parse(approval.expiresAt) - now())))
    if (!isKernelQuotaDenial(quotaResult.byteErrno)) {
      throw new Error(`Per-Job byte pressure did not report quota denial: ${JSON.stringify(quotaResult)}`)
    }
    const independence = []
    for (const claim of claims.slice(1)) {
      const path = join(claim.namespace, 'independent-quota')
      await writeFile(path, 'independent Job capacity', { mode: 0o600, flag: 'wx' })
      independence.push(await readFile(path, 'utf8'))
    }
    const quotaInodes = JSON.parse(await checked(['exec', containerId, 'node', '-e', quotaProbe,
      JSON.stringify({ phase: 'inodes', inodes: pool.slots[0]!.hardInodes })],
    Math.min(600000, Date.parse(approval.expiresAt) - now())))
    if (!isKernelQuotaDenial(quotaInodes.inodeErrno)) {
      throw new Error(`Per-Job inode pressure did not report quota denial: ${JSON.stringify(quotaInodes)}`)
    }
    const seedBytes = await readProtectedRuntimeFile({ path: configuration.seedReceiptPath,
      ownerUid: input.configuration!.ownerUid }, 16 * 1024 * 1024)
    const seed = JobVerificationOfflineSeedReceiptSchema.parse(JSON.parse(seedBytes.toString('utf8')))
    const checkedAt = new Date(now()).toISOString()
    const expiresAt = new Date(Math.min(Date.parse(approval.expiresAt),
      Date.parse(checkedAt) + candidate.ttlSeconds * 1000)).toISOString()
    const profileIdentity = { profileId: fingerprint.profileId, profileRevision: fingerprint.profileRevision,
      qualificationId: candidate.qualificationId, rootId: fingerprint.root.binding.rootId,
      bindingRevision: fingerprint.root.binding.bindingRevision, fingerprintDigest: jobQualificationFingerprint(candidate),
      imageDigest: fingerprint.imageDigest, toolchainDigest: fingerprint.toolchainDigest, network: fingerprint.network,
      approvalId: candidate.approvalId, approvalExpiresAt: approval.expiresAt, qualificationExpiresAt: expiresAt }
    const target = JobTargetSchema.parse({ schemaVersion: 1, mainId: fingerprint.mainInstallationId,
      hostRef: fingerprint.hostRef, registration: fingerprint.registration, mainInstallationId: fingerprint.mainInstallationId,
      destination: { canonicalProjectRoot: source.sourceRoot, canonicalCwd: source.sourceRoot,
        managedRuntimeRoot: candidate.runtimeRoot, directoryIdentityHash: jobDigest(namespace),
        rootPolicyId: fingerprint.root.selection.rootPolicyId,
        rootPolicyRevision: fingerprint.root.selection.rootPolicyRevision,
        locationRevision: fingerprint.root.selection.locationRevision, attestationId: fingerprint.root.attestationId,
        attestationHash: fingerprint.root.attestationDigest } })
    const ownerConcurrency = fingerprint.hostRef.kind === 'main'
      ? JOB_VERIFICATION_OWNER_CONFIGURATION.mainConcurrentJobs : JOB_VERIFICATION_OWNER_CONFIGURATION.laptopConcurrentJobs
    const concurrency = Math.min(ownerConcurrency, pool.slots.length,
      ...Object.keys(fingerprint.limits).map(key => Math.floor(
        Reflect.get(fingerprint.deviceLimits, key) / Reflect.get(fingerprint.limits, key))))
    if (concurrency < 1) throw new Error('Measured device resource headroom cannot reserve one verification Job.')
    const suites = []
    const reports = []
    const publications: NonNullable<import('@foreman-code/contracts/job-verification-runtime')
      .JobVerificationRuntimeMeasurement['publications']> = []
    if (!owner.closeContainer || !owner.readClosure) throw new Error('Physical container closure authority required.')
    const materialize = (context: JobQualificationReport['context'], verified: {
      filesystem: { device: string; inode: string; mountId: string }; verifiedAt: string
    }) => {
      const attempt = { executionId: context.identity.executionId, attemptId: context.identity.attemptId,
        keyRevision: fingerprint.registration?.keyRevision ?? null,
        authorizationRevision: fingerprint.registration?.authorizationRevision ?? null }
      const placementHash = sourceBindingHash(candidate.profile.root, attempt, context.identity.executionId)
      return SourceMaterializationRecordSchema.parse({ receipt: { version: 1,
        materializationId: candidate.qualificationId, binding: candidate.profile.root.binding,
        quota: pool.slots[0], placementHash, ...attempt,
        verifiedManifestDigest: context.identity.manifestDigest,
        verifiedEntries: configuration.qualificationSource.manifest.totalEntries,
        verifiedBytes: configuration.qualificationSource.manifest.totalBytes,
        verifiedAt: verified.verifiedAt, localTreeIdentity: verified.filesystem },
        rootPolicyId: candidate.profile.root.selection.rootPolicyId,
        rootPolicyRevision: candidate.profile.root.selection.rootPolicyRevision,
        operationId: context.identity.executionId, reservationId: candidate.qualificationId,
        sourceBindingHash: placementHash, finalDispatchBindingHash: null, state: 'prepared' })
    }
    const restore = () => restoreVerificationQualificationSource({ ...configuration.qualificationSource,
      sourceRoot: source.sourceRoot, signal: input.signal })
    const publish = async (context: JobQualificationReport['context'], startedAt: string,
      terminal: JobQualificationReport['terminal'], reserve: Awaited<ReturnType<typeof reserveVerificationReportSpace>>,
      materialization: JobQualificationReport['materialization']) => {
      const closure = await owner.readClosure!()
      if (closure.containerId !== containerId) {
        throw new Error('Report publication requires the original container closure certificate.')
      }
      const execution = qualificationExecution(candidate, { context, startedAt, terminal, materialization })
      await finalizeVerificationPublication(execution, { ...terminal, processStopped: true,
        closureEvidenceDigest: jobDigest(closure), resultDigest: jobDigest(terminal),
        logsTruncated: false, logGapPossible: false, outputCollectionError: false, artifactDigests: [] },
      { context, reserve, finalizedAt: null }, async () => {})
      const artifacts = []
      for (const file of reportFiles) {
        const bytes = await readBoundedReport(source.sourceRoot, file,
          context.limits[reportLimits[file]])
        const artifact = await input.publishReport!(candidate, { context, closure, terminal, startedAt, materialization,
          path: `.logs/verification/${file}` as JobQualificationReport['path'],
          sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length }, bytes)
        if (artifact.state !== 'available' || artifact.byteSize !== bytes.length
          || artifact.sha256 !== createHash('sha256').update(bytes).digest('hex')) {
          throw new Error('Canonical qualification report readback failed.')
        }
        artifacts.push(artifact)
      }
      publications.push({ executionId: context.identity.executionId, artifacts })
      const summaryBytes = await readBoundedReport(source.sourceRoot, 'summary.json', context.limits.summaryBytes)
      return JobVerificationReportSchema.parse(JSON.parse(summaryBytes.toString('utf8')))
    }
    let failureContext: ReturnType<typeof JobVerificationRepositoryContextSchema.parse> | undefined
    for (const suite of candidate.profile.spec.suites) {
      await resetVerificationQualificationWorkload(source.sourceRoot, scratch, configuration.qualificationSource.manifest.entries.map(file => file.path))
      if (suites.length) containerId = await createContainer()
      const verified = await restore()
      target.destination.directoryIdentityHash = jobDigest(verified.filesystem)
      const startedAt = new Date(now()).toISOString()
      const before = await statfs(namespace)
      const bytesBefore = (before.blocks - before.bfree) * before.bsize
      const inodesBefore = before.files - before.ffree
      const maxBytes = Math.floor(Math.min(fingerprint.resources.reportBytes,
        candidate.profile.spec.policy.maxOutputBytes) / reportFiles.length)
      const context = JobVerificationRepositoryContextSchema.parse({
        identity: { commit: fingerprint.sourceCommit, manifestDigest: fingerprint.root.source.manifestDigest,
          definitionVersionId: `${fingerprint.profileId}:${fingerprint.profileRevision}:${candidate.qualificationId}:${suite}`,
          suite, executionId: `${candidate.operationId}:${suite}`, attemptId: `${candidate.qualificationId}:${suite}`, target,
          profile: profileIdentity, resources: fingerprint.resources,
          parameters: { unitWorkers: qualificationUnitWorkers(fingerprint.resources.limits),
            integrationShards: suite === 'integration' ? qualificationIntegrationShards(fingerprint.resources) : 1 } },
        requiredPortions: captureVerificationInventory(source.sourceRoot, suite, { qualification: true }),
        privateGit: source.privateGit, executionTimeoutMs: candidate.profile.spec.policy.executionTimeoutMs,
        cancellationTimeoutMs: Math.max(1, candidate.profile.spec.policy.cancellationGraceMs),
        qualifiedUnitWorkers: qualificationUnitWorkers(fingerprint.resources.limits),
        qualifiedIntegrationShards: suite === 'integration' ? qualificationIntegrationShards(fingerprint.resources) : 1,
        limits: { summaryBytes: maxBytes, junitBytes: maxBytes, vitestBytes: maxBytes,
          logsArchiveBytes: maxBytes, logBytes: Math.min(maxBytes, candidate.profile.spec.policy.maxLogBytes) },
        mutableDirectory: '/job-scratch', storeDirectory: '/job-scratch/pnpm-store',
        preseedReceipt: { lockfileSha256: seed.dependencyInputs.find(file => file.path === 'pnpm-lock.yaml')!.sha256,
          pnpmVersion: '11.27.0', platform: 'linux', architecture: 'x64', provenanceDigest: seed.provenanceDigest,
          minimumReleaseAgeMinutes: 2880, releaseAgeVerified: true },
        unitCodex: fingerprint.tools.filter(tool => tool.kind === 'codex').map(({ executable, binarySha256, version }) =>
          ({ executable, binarySha256, version }))[0],
      })
      if (!failureContext || suite === 'unit') failureContext = context
      const materialization = materialize(context, verified)
      const reserve = await reserveVerificationReportSpace(qualificationExecution(candidate,
        { context, startedAt, materialization, terminal: { outcome: 'build_failed', exitCode: null, signal: null, finishedAt: startedAt } }))
      await writeVerificationQualificationContext(inputRoot, JSON.stringify({ ...context,
        measurement: { mutableDirectory: '/job-scratch', cgroupDirectory: '/sys/fs/cgroup' } }))
      const execution = await podman(['exec', containerId, 'node', '/opt/graphql-ci/verification/verify-repository.mjs',
        '--context', `/workspace/${JOB_INPUT_DIRECTORY}/qualification-context.json`],
      context.executionTimeoutMs + context.cancellationTimeoutMs + candidate.profile.spec.policy.publicationTimeoutMs)
      const terminal = { outcome: execution.exitCode === 0 ? 'succeeded' as const : 'build_failed' as const,
        exitCode: execution.exitCode, signal: null, finishedAt: new Date(now()).toISOString() }
      const publishOrdinaryReport = async () => {
        const report = await publish(context, startedAt, terminal, reserve, materialization)
        pendingReport = undefined
        return report
      }
      pendingReport = { suite, exitCode: execution.exitCode, stderr: execution.stderr, publish: publishOrdinaryReport }
      if (execution.exitCode !== 0) {
        await publishFailedQualification({ suite, exitCode: execution.exitCode, stderr: execution.stderr,
          closeContainer: () => owner.closeContainer!(),
          publish: publishOrdinaryReport })
      }
      if (!await owner.closeContainer!()) throw new Error('Ordinary verification descendants are still active.')
      const samples = JSON.parse((await readBoundedJobFile(source.sourceRoot,
        '.logs/verification/parts/resource-samples.json', context.limits.vitestBytes)).toString('utf8'))
      if (!samples.samples?.length || samples.samples.some((sample: { error?: string }) => sample.error)) {
        throw new Error('Complete cold-cache resource samples required.')
      }
      const quota = await verifyJobQuotaOwnership({ pool, binding: fingerprint.root.binding,
        slot: pool.slots[0]!, directory: namespace, signal: input.signal, read: readQuota })
      const coldCachePeakBytes = Math.max(quota.usedBytes, samples.sampledPeaks.mutableBytes - bytesBefore, 1)
      const coldCachePeakInodes = Math.max(quota.usedInodes, samples.sampledPeaks.mutableInodes - inodesBefore, 1)
      const report = await publishOrdinaryReport()
      if (report.outcome !== 'passed' || report.completeness !== 'complete') {
        throw new Error(`Canonical ${suite} report did not establish a complete pass.`)
      }
      reports.push({ report, expected: context.identity, artifacts: publications.at(-1)!.artifacts })
      suites.push({ suite, resources: fingerprint.resources, coldCachePeakBytes, coldCachePeakInodes,
        maxConcurrentHeavyJobs: concurrency, maxUnitWorkers: context.identity.parameters.unitWorkers,
        maxIntegrationShards: context.identity.parameters.integrationShards,
        evidenceDigest: jobDigest({ report, samples, quota, artifacts: reports.at(-1)!.artifacts }) })
    }
    if (!failureContext) throw new Error('An ordinary suite is required for qualification.')
    const failures = []
    for (const outcome of ['timed_out', 'cancelled'] as const) {
      await resetVerificationQualificationWorkload(source.sourceRoot, scratch, configuration.qualificationSource.manifest.entries.map(file => file.path))
      const verified = await restore()
      target.destination.directoryIdentityHash = jobDigest(verified.filesystem)
      const startedAt = new Date(now()).toISOString()
      const context = JobVerificationRepositoryContextSchema.parse({ ...failureContext,
        identity: { ...failureContext.identity, executionId: `${candidate.operationId}:${outcome}`,
          definitionVersionId: `${fingerprint.profileId}:${fingerprint.profileRevision}:${candidate.qualificationId}:${outcome}`,
          attemptId: `${candidate.qualificationId}:${outcome}` } })
      const materialization = materialize(context, verified)
      const reserve = await reserveVerificationReportSpace(qualificationExecution(candidate,
        { context, startedAt, materialization, terminal: { outcome: 'build_failed', exitCode: null, signal: null, finishedAt: startedAt } }))
      await writeVerificationQualificationContext(inputRoot, JSON.stringify({ ...context,
        measurement: { mutableDirectory: '/job-scratch', cgroupDirectory: '/sys/fs/cgroup' } }))
      containerId = await createContainer()
      await input.authority.assertCurrent(candidate)
      const terminal = await interruptActiveQualification({ owner, candidate, containerId,
        contextPath: `/workspace/${JOB_INPUT_DIRECTORY}/qualification-context.json`, startedAt, outcome, signal: input.signal })
      const report = await publish(context, startedAt, terminal, reserve, materialization)
      if (report.outcome !== outcome || report.attemptId !== context.identity.attemptId) {
        throw new Error('Canonical interruption report changed its original attempt or outcome.')
      }
      failures.push(report)
    }
    closed = await owner.close()
    if (!closed) throw new Error('Physical verification descendant closure is unconfirmed.')
    await input.authority.assertCurrent(candidate)
    const runtime = { ...fingerprint.limits, workspaceLayout: fingerprint.workspaceLayout,
      policyId: fingerprint.profileId, policyRevision: fingerprint.profileRevision,
      qualificationId: candidate.qualificationId, imageDigest: fingerprint.imageDigest,
      toolchainDigest: fingerprint.toolchainDigest, runtimeVersion: info.version.Version,
      ociRuntimeVersion: info.host.ociRuntime.version.split('\n')[0], kernelVersion: release(),
      rootless: true, cgroupV2: true, filesystemBounded: true, descendantContainment: true,
      network: fingerprint.network, quota: fingerprint.quota, deviceLimits: fingerprint.deviceLimits,
      resourcePolicyRevision: fingerprint.resourcePolicyRevision, resourcePolicyDigest: fingerprint.resourcePolicyDigest,
      runtimeApprovalId: fingerprint.runtimeApprovalId, runtimeApprovalRevision: fingerprint.runtimeApprovalRevision,
      provisioningSuite: fingerprint.provisioningSuite, aggregateCgroupIdentityDigest: fingerprint.aggregateCgroupIdentityDigest,
      imageManifestDigest: fingerprint.imageManifestDigest, imageConfigDigest: fingerprint.imageConfigDigest }
    const evidence = { observation, quotas, quotaResult, quotaInodes, independence, suites, reports, failures, publications, containerId, closed }
    const measurement = JobVerificationRuntimeMeasurementSchema.parse({ schemaVersion: 2, fingerprint,
      identity: profileIdentity, origin: 'real-runtime', approvedAt: candidate.approvedAt, checkedAt, expiresAt, suites, publications,
      checks: [...JOB_VERIFICATION_BASE_CHECKS, 'network-none',
        ...(suites.some(suite => suite.suite === 'integration') ? ['postgres-isolation'] : [])].map(id => ({ id, passed: true,
        evidenceDigest: jobDigest({ id, evidence }) })) })
    result = JobVerificationRuntimeQualificationResultSchema.parse({ outcome: 'qualified', measurement, runtime })
  } catch (error) {
    denial = error instanceof Error ? error : new Error('Physical verification qualification failed.')
  } finally {
    if (!closed) {
      try { closed = await owner.close() }
      catch (error) {
        const message = errorMessage(error, 'Qualification closure failed.')
        denial = new Error(`${denial?.message ?? 'Qualification failed.'} Closure failed: ${message}`.slice(0, 500),
          { cause: error })
      }
    }
    if (closed && denial && pendingReport) {
      try {
        await publishFailedQualification({ ...pendingReport, failure: denial, closeContainer: async () => closed })
      } catch (error) {
        denial = error instanceof Error ? error : new Error('Qualification report publication failed.')
      }
    }
    for (const claim of claims) await claim.file.close()
  }

  if (!closed || denial) {
    const denied = { outcome: 'denied' as const, closure: closed ? 'confirmed' as const : 'unconfirmed' as const,
      reasons: [(denial?.message ?? 'Physical verification closure is unconfirmed.').slice(0, 500)] }
    if (closed) await owner.recordResult?.(denied)
    return denied
  }
  if (!result) throw new Error('Physical qualification produced no result.')
  await owner.recordResult?.(result)
  return result
}

async function readBoundedReport(root: string, name: string, limit: number): Promise<Buffer> {
  return readBoundedJobFile(root, `.logs/verification/${name}`, limit)
}
