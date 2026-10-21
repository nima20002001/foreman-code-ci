import { errorMessage } from '../../shared/errorMessage.js'
import type { ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { open, readdir, lstat, realpath, statfs, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual as same } from 'node:util'
import { JobRuntimeNativeAdmissionRecordSchema, JobQualificationCandidateRecordSchema,
  JobVerificationQualificationCandidateSchema, JobQualificationClosureSchema, type JobRuntimeNativeAdmissionRecord, type JobQualificationCandidateRecord }
  from '@foreman-code/contracts/job-verification-runtime'
import { qualifyVerificationRuntime } from './verificationQualification.js'
import { nativeAgentEnvironment } from '../harnesses/secrets.js'
import { bootIdentity } from '../harnesses/recovery/linuxIdentity.js'
import { NativeProcessRegistry, spawnNativeProcess, nativeProcessExit, type NativeProcessRecovery } from '../harnesses/recovery/processRegistry.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { fallbackOnError } from '../diagnostics/ignoredError.js'
import { qualificationCleanupCommandAllowed, qualificationCreationStopped,
  QUALIFICATION_CLEANUP_COMMAND_LIMIT } from './qualificationJournal.js'
import { inspectInstalledJobRuntimeCandidate, type InstalledRuntimeHostDependencies, type InstalledRuntimeConfigurationLocation } from './installedRuntimeHost.js'
import type { OCIContainerOwnership, OCIHostCertificate } from './executorContainerOwner.js'
import type { z } from 'zod'
import { VerificationJobExecutionSchema } from '@foreman-code/contracts/job-verification'
import { jobSupervisorIdentity } from './executor.js'
import { jobQualificationFingerprint, createQualificationNativeOwner, fingerprintQualificationPath,
  qualifyJobRuntime, jobRuntimeMeasurement, runQualificationCommand, type JobQualificationAuthority } from './qualification.js'
import type { JobRuntimeQualificationResult } from './runtimeProfilePorts.js'

/** Samples the original Job boundary; no host-wide memory/CPU estimate is substituted for its cgroup. */
export async function measureVerificationResourceUsage(input: {
  execution: z.infer<typeof VerificationJobExecutionSchema>
  certificate: OCIHostCertificate
}): Promise<{
  sampledAt: string; allocatedBytes: number; mutableInodes: number; memoryPeakBytes: number;
  pids: number; cpuUsageMicroseconds: number; pressure: boolean; evidenceDigest: string
}> {
  const execution = VerificationJobExecutionSchema.parse(input.execution)
  const subject = input.certificate.scope.subject
  if (subject.kind !== 'job' || subject.executionId !== execution.id || subject.attemptId !== execution.attemptId
    || subject.operationId !== execution.operationId || subject.bindingHash !== execution.acceptedSpec.bindingHash
    || input.certificate.lifecycle !== 'active' || !('owner' in input.certificate.scope)
    || !same(input.certificate.scope.owner, execution.owner)
    || input.certificate.scope.bootId !== bootIdentity()
    || input.certificate.process.bootId !== input.certificate.scope.bootId) {
    throw new Error('Original active Job boundary required for measurement.')
  }
  const boundary = input.certificate.boundary
  const cgroup = await open(boundary.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  let memoryPeakBytes: number
  let pids: number
  let cpuUsageMicroseconds: number
  try {
    const info = await cgroup.stat()
    if (await realpath(boundary.path) !== boundary.path || String(info.dev) !== boundary.device || String(info.ino) !== boundary.inode
      || (await statfs(`/proc/self/fd/${cgroup.fd}`)).type !== 0x63677270) throw new Error('Original cgroup identity changed.')
    const read = async (name: string) => {
      const file = await open(`/proc/self/fd/${cgroup.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const bytes = await file.readFile()
        if (bytes.length > 65536) throw new Error('Cgroup measurement exceeds its reply bound.')
        return bytes.toString('utf8')
      } finally { await file.close() }
    }
    memoryPeakBytes = Number((await read('memory.peak')).trim())
    pids = Number((await read('pids.current')).trim())
    cpuUsageMicroseconds = Number(/^usage_usec (\d+)$/m.exec(await read('cpu.stat'))?.[1])
    if (![memoryPeakBytes, pids, cpuUsageMicroseconds].every(value => Number.isSafeInteger(value) && value >= 0)) {
      throw new Error('Finite measured cgroup counters required.')
    }
  } finally { await cgroup.close() }
  const namespace = dirname(execution.acceptedSpec.target.destination.canonicalProjectRoot)
  const roots = [namespace, join(execution.acceptedSpec.target.destination.managedRuntimeRoot,
    `${jobSupervisorIdentity(execution)}.oci.log`)]
  const seen = new Set<string>()
  let allocatedBytes = 0
  let mutableInodes = 0
  let device: number | undefined
  const resources = execution.acceptedSpec.verification.resources
  const walk = async (path: string): Promise<void> => {
    const info = await lstat(path)
    device ??= info.dev
    if (info.dev !== device) throw new Error('Job accounting escaped its original workload filesystem.')
    const identity = `${info.dev}:${info.ino}`
    if (seen.has(identity)) return
    seen.add(identity)
    mutableInodes++
    allocatedBytes += info.blocks * 512
    if (mutableInodes > resources.mutableInodes || allocatedBytes > resources.limits.diskBytes) return
    if (info.isDirectory()) {
      const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try {
        const pinned = await directory.stat()
        if (pinned.dev !== info.dev || pinned.ino !== info.ino) throw new Error('Job accounting directory changed.')
        for (const entry of await readdir(`/proc/self/fd/${directory.fd}`)) {
          await walk(`/proc/self/fd/${directory.fd}/${entry}`)
          if (mutableInodes > resources.mutableInodes || allocatedBytes > resources.limits.diskBytes) break
        }
      } finally { await directory.close() }
    }
  }
  for (const path of roots) await walk(path)
  const sample = { sampledAt: new Date().toISOString(), allocatedBytes, mutableInodes,
    memoryPeakBytes, pids, cpuUsageMicroseconds,
    pressure: allocatedBytes >= resources.limits.diskBytes || mutableInodes >= resources.mutableInodes
      || pids >= resources.limits.pidsLimit || memoryPeakBytes >= resources.limits.memoryBytes }
  return { ...sample, evidenceDigest: createHash('sha256').update(JSON.stringify(sample)).digest('hex') }
}

export interface InstalledJobQualificationReservation {
  now?: () => number
  admission: JobRuntimeNativeAdmissionRecord
  candidate: JobQualificationCandidateRecord
  /** Current protected installation and actual authenticated connection, not copied caller authority. */
  host: Pick<JobRuntimeNativeAdmissionRecord, 'hostRef' | 'registration' | 'mainInstallationId' | 'bootId' | 'connection'>
  journal: RemoteOperationJournal
  registry: NativeProcessRegistry
  authority: JobQualificationAuthority
  /** Main's persisted admission/live-scope assertion, via W07 on a device. */
  assertAdmission(admission: JobRuntimeNativeAdmissionRecord): Promise<void>
  signal: AbortSignal
  entry?: 'launch' | 'reconcile'
}
/** Entire physical diagnostic stays on its original host. The carrier returns
 * measured result JSON only, never a ChildProcess or a fabricated ready flag. */
export async function runInstalledJobRuntimeQualification(input: InstalledJobQualificationReservation & {
  configuration: InstalledRuntimeConfigurationLocation | null
  publishReport?: import('./qualificationReports.js').QualificationReportPublisher
}): Promise<JobRuntimeQualificationResult> {
  const candidate = JobQualificationCandidateRecordSchema.parse(input.candidate)
  const prior = await input.journal.qualificationStatus(input.admission.operationId)
  if (prior && (!same(prior.admission, input.admission) || !same(prior.candidate, candidate))) {
    throw new Error('Original diagnostic candidate or admission changed.')
  }
  if (prior?.result && prior.phase === 'closed') {
    await releaseQualificationQuotaClaims(input.journal, input.admission.operationId)
    return prior.result
  }
  if (prior && prior.phase !== 'received') return reconcileInstalledJobRuntimeQualification(input)
  await input.journal.qualificationAccept(input.admission, candidate)
  try {
    await input.assertAdmission(JobRuntimeNativeAdmissionRecordSchema.parse(input.admission))
    await inspectInstalledJobRuntimeCandidate({ ...input, candidate })
  } catch (error) {
    await input.journal.qualificationConfirmNonEntry(input.admission.operationId)
    const reason = errorMessage(error, 'Qualification entry validation failed.')
    const result = { outcome: 'denied' as const, closure: 'confirmed' as const, reasons: [reason.slice(0, 500)] }
    await input.journal.qualificationResult(input.admission.operationId, result)
    return result
  }
  const authority: JobQualificationAuthority = { ...input.authority, async reserve(original, signal) {
    if (!same(original, candidate)) throw new Error('Original diagnostic candidate changed.')
    const reserved = await reserveInstalledJobQualification({ ...input, candidate, authority: input.authority, signal })
    return createQualificationNativeOwner(candidate, reserved.native, reserved.ownership, reserved.authority)
  } }
  if (candidate.fingerprint.schemaVersion === 3) {
    const result = await qualifyVerificationRuntime({ ...input,
      candidate: JobVerificationQualificationCandidateSchema.parse(candidate), authority })
    if (await input.journal.qualificationStatus(input.admission.operationId)) {
      await input.journal.qualificationResult(input.admission.operationId, result)
      if (result.outcome === 'qualified' || result.closure === 'confirmed') {
        await releaseQualificationQuotaClaims(input.journal, input.admission.operationId)
      }
    }
    return result
  }
  const { JobQualificationCandidateSchema } = await import('@foreman-code/contracts/job-runtime')
  const record = await qualifyJobRuntime(JobQualificationCandidateSchema.parse(candidate), authority, input.signal,
    { now: input.now ?? Date.now })
  const result: JobRuntimeQualificationResult = record.outcome === 'qualified' ? { outcome: 'qualified', measurement: jobRuntimeMeasurement(record) }
    : { outcome: 'denied', closure: record.closure, reasons: record.reasons.map(reason => reason.slice(0, 500)) }
  if (await input.journal.qualificationStatus(input.admission.operationId)) await input.journal.qualificationResult(input.admission.operationId, result)
  return result
}

/** Genuine human-approved diagnostic. Its single entry and exact process/OCI
 * identities remain in the existing worker journal and native registry. */
export async function reserveInstalledJobQualification(input: InstalledJobQualificationReservation): Promise<Awaited<ReturnType<InstalledRuntimeHostDependencies['reserve']>>> {
  const admission = JobRuntimeNativeAdmissionRecordSchema.parse(input.admission), candidate = JobQualificationCandidateRecordSchema.parse(input.candidate)
  const { authority, journal, registry, signal } = input
  const now = input.now ?? Date.now
  const operationId = admission.operationId
  const host = { hostRef: admission.hostRef, registration: admission.registration, mainInstallationId: admission.mainInstallationId,
    bootId: admission.bootId, connection: admission.connection }
  if (process.platform !== 'linux' || bootIdentity() !== admission.bootId || !same(input.host, host) || admission.approvalId !== candidate.approvalId ||
    admission.qualificationId !== candidate.qualificationId || operationId !== candidate.operationId || admission.profileId !== candidate.fingerprint.profileId ||
    admission.profileRevision !== candidate.fingerprint.profileRevision || admission.workspaceId !== candidate.fingerprint.root.binding.workspaceId ||
    admission.fingerprintDigest !== jobQualificationFingerprint(candidate) || !same(admission.hostRef, candidate.fingerprint.hostRef) ||
    !same(admission.registration, candidate.fingerprint.registration) || admission.mainInstallationId !== candidate.fingerprint.mainInstallationId ||
    admission.bootId !== candidate.fingerprint.bootId) throw new Error('Original installed qualification admission context changed.')
  const assertCurrent = async () => {
    signal.throwIfAborted()
    if (bootIdentity() !== admission.bootId || Date.parse(admission.expiresAt) <= now()) throw new Error('Original installed qualification admission expired or boot changed.')
    await input.assertAdmission(admission)
    await authority.assertCurrent(candidate)
    const approval = await authority.readApproval(admission.approvalId)
    if (!approval || approval.status !== 'approved' || approval.fingerprint !== admission.fingerprintDigest || Date.parse(approval.expiresAt) <= now() ||
      Date.parse(admission.expiresAt) > Date.parse(approval.expiresAt)) throw new Error('Original human qualification approval changed.')
  }
  const assertClosure = async () => {
    const retained = await journal.qualificationStatus(operationId)
    if (!retained || !same(retained.admission, admission) || !same(retained.candidate, candidate)
      || bootIdentity() !== admission.bootId
      || (await fingerprintQualificationPath(candidate.fingerprint.runtimeExecutable, true)).sha256
        !== candidate.fingerprint.runtimeBinarySha256) throw new Error('Original qualification cleanup owner changed.')
  }
  if (input.entry === 'reconcile') await assertClosure()
  else {
    await assertCurrent()
    await journal.qualificationAccept(admission, candidate)
  }
  const original = await journal.qualificationStatus(operationId)
  if (original?.phase === 'closed' && original.result) {
    const noEntry = () => { throw new Error('Completed original qualification cannot launch native work.') }
    return { authority, ownership: { scope: { subject: { kind: 'qualification',
      qualificationId: admission.qualificationId, profileId: admission.profileId, profileRevision: admission.profileRevision,
      operationId, fingerprint: admission.fingerprintDigest }, admission, bootId: admission.bootId },
      assertCurrent, reserveContainerIntent: noEntry, bindContainer: noEntry, launchHelpers: noEntry,
      readCertificate: noEntry, publish: noEntry },
      native: { completedResult: original.result, reserveProcess: async () => noEntry(),
        spawnProcess: noEntry, readNativeExit: async () => noEntry(),
        stopProcess: async () => noEntry(), close: async () => true } }
  }
  const entry = input.entry === 'reconcile'
    ? { reserved: false, receipt: original } : await journal.qualificationReserveEntry(operationId)
  const recovering = !entry.reserved
  if (recovering) await assertClosure()
  const owner = `qualification:${operationId}:${admission.leaseId}`
  const launches = new Map<string, QualificationLaunch>()
  let closed = false
  const ownership = qualificationContainerOwnership({ admission, registry, journal, owner, assertCurrent, assertClosure })
  async function closeLaunch(id: string) {
    const launch = launches.get(id)
    if (!launch) throw new Error('Original native launch reservation missing.')
    if (launch.closed) return true
    if (!launch.child) {
      if (!await registry.abandonReservedLaunch(launch.scope)) return false
    } else await registry.closeRegistration(launch.scope, id)
    await journal.qualificationProcessClosed(operationId, id)
    launch.closed = true; return true
  }
  const cleanupLaunches = new Set<string>()
  const native = {
    recoveryRequired: recovering,
    ...(original?.result ? { originalResult: original.result } : {}),
    ...(original?.container && original.phase !== 'closed' ? { originalContainer: original.container } : {}),
    async recordQuotaClaim(claim: { path: string; namespace: string; device: number; inode: number }) {
      await assertClosure()
      await journal.qualificationQuotaClaim(operationId, claim)
    },
    async reserveCleanupProcess(binary: string, argv: string[]) {
      await assertClosure()
      const receipt = (await journal.qualificationStatus(operationId))!
      if (!qualificationCleanupCommandAllowed(receipt, binary, argv)) {
        throw new Error('Only original-container inspection, stop and confirmed removal are permitted during cleanup.')
      }
      for (const launch of receipt.launches.filter(value => !value.closed)) {
        await registry.closeRegistration({ ...registry.scope(owner), launchId: launch.launchId }, launch.launchId)
        await journal.qualificationProcessClosed(operationId, launch.launchId)
        const local = launches.get(launch.launchId)
        if (local) local.closed = true
      }
      let launchId = ''
      let reservedScope: NativeProcessRecovery | undefined
      const reserve = async () => {
        const scope = await registry.reserveLaunch(owner)
        if (!scope.launchId) throw new Error('Original cleanup process reservation unavailable.')
        launchId = scope.launchId
        reservedScope = scope
        launches.set(scope.launchId, { scope, binary, argv: [...argv], closed: false })
        cleanupLaunches.add(scope.launchId)
        return { launchId: scope.launchId, binary, argv }
      }
      try {
        if (recovering && receipt.launches.length === QUALIFICATION_CLEANUP_COMMAND_LIMIT
          && qualificationCreationStopped(receipt)
          && same(argv, ['--remote=false', 'container', 'exists', receipt.container!.identity])) {
          await journal.qualificationReserveCreationObservation(operationId, async () => {
            if (!await registry.closeOwner(owner)) throw new Error('Original creation owner closure unconfirmed.')
            return reserve()
          })
        } else await journal.qualificationReserveCleanupProcess(operationId, await reserve())
      } catch (error) {
        if (reservedScope && await registry.abandonReservedLaunch(reservedScope)) {
          launches.delete(launchId)
          cleanupLaunches.delete(launchId)
        }
        throw error
      }
      return launchId
    },
    spawnCleanupProcess(id: string, binary: string, argv: string[], options: import('node:child_process').SpawnOptions) {
      if (!cleanupLaunches.has(id)) throw new Error('Original cleanup reservation required.')
      return spawnQualificationProcess({ launch: launches.get(id), closed, binary, argv, options, admission, candidate })
    },
    async recordResult(result: JobRuntimeQualificationResult) {
      await releaseQualificationQuotaClaims(journal, operationId)
      await journal.qualificationResult(operationId, result)
    },
    async readClosure() {
      const receipt = await journal.qualificationStatus(operationId)
      if (!receipt || receipt.launches.some(launch => !launch.closed)) {
        throw new Error('Original qualification commands are still active.')
      }
      return JobQualificationClosureSchema.parse(receipt.container?.certificate)
    },
    async reserveProcess(binary: string, argv: string[]) {
      if (recovering || closed || ![candidate.fingerprint.runtimeExecutable, candidate.findmntBinary,
        ...('quotaPool' in candidate.fingerprint && candidate.fingerprint.quotaPool
          ? [candidate.fingerprint.quotaPool.queryExecutable] : [])].includes(binary) || argv.some(value => typeof value !== 'string' || value.includes('\0'))) throw new Error('Installed diagnostic executable/argv changed.')
      await assertCurrent()
      const pool = 'quotaPool' in candidate.fingerprint ? candidate.fingerprint.quotaPool : undefined
      if (pool && binary === pool.queryExecutable) {
        const permitted = pool.slots.some(slot => argv[0] === `${candidate.sourceParent}/${slot.namespace}`
          || argv[0]?.startsWith(`${candidate.sourceParent}/${slot.namespace}/`))
        if (!permitted || argv.length !== 2 || argv[1] !== pool.blockDevice
          || (await fingerprintQualificationPath(binary, true)).sha256 !== pool.queryBinarySha256) {
          throw new Error('Original read-only quota observer changed.')
        }
      }
      const scope = await registry.reserveLaunch(owner)
      if (!scope.launchId) throw new Error('Original guarded native reservation unavailable.')
      const launch = { scope, binary, argv: [...argv], closed: false }
      launches.set(scope.launchId, launch)
      try { await journal.qualificationReserveProcess(operationId, { launchId: scope.launchId, binary, argv: [...argv] }) }
      catch (error) {
        await registry.abandonReservedLaunch(scope).catch(fallbackOnError(
          false, 'jobs', 'abandon qualification launch', { operationId, launchId: scope.launchId },
        ))
        throw error
      }
      return scope.launchId
    },
    spawnProcess(id: string, binary: string, argv: string[], options: import('node:child_process').SpawnOptions) {
      signal.throwIfAborted()
      if (recovering || Date.parse(admission.expiresAt) <= now()) throw new Error('Original qualification cannot launch work.')
      return spawnQualificationProcess({ launch: launches.get(id), closed, binary, argv, options, admission, candidate })
    },
    async readNativeExit(id: string, child: ChildProcess) {
      const launch = launches.get(id)
      if (!launch || launch.child !== child) throw new Error('Original native exit target changed.')
      const exit = nativeProcessExit(child, { exitCode: null, exitSignal: null })
      if (exit.exitCode === null && exit.exitSignal === null) return { confirmed: false, exitCode: null }
      await journal.qualificationProcessExit(operationId, id, { exitCode: exit.exitCode, signal: exit.exitSignal })
      await closeLaunch(id)
      return { confirmed: true, exitCode: exit.exitCode }
    },
    stopProcess: closeLaunch,
    async close() {
      if (closed) return true
      for (const id of launches.keys()) if (!await closeLaunch(id)) return false
      if (!await registry.closeOwner(owner)) return false
      const receipt = (await journal.qualificationStatus(operationId))!
      for (const launch of receipt.launches.filter(value => !value.closed)) {
        await journal.qualificationProcessClosed(operationId, launch.launchId)
      }
      await journal.qualificationClose(operationId)
      closed = true; return true
    },
  }

  return { authority, ownership, native }
}

interface QualificationLaunch {
  scope: NativeProcessRecovery
  binary: string
  argv: string[]
  child?: ChildProcess
  closed: boolean
}

function spawnQualificationProcess(input: {
  launch: QualificationLaunch | undefined
  closed: boolean
  binary: string
  argv: string[]
  options: import('node:child_process').SpawnOptions
  admission: JobRuntimeNativeAdmissionRecord
  candidate: JobQualificationCandidateRecord
}) {
  const { launch, closed, binary, argv, options, admission, candidate } = input
  if (closed || !launch || launch.child || launch.closed || launch.binary !== binary || !same(launch.argv, argv)
    || bootIdentity() !== admission.bootId || options.shell !== false
    || !same(options.stdio, ['ignore', 'pipe', 'pipe'])
    || !same(options.env, candidate.controllerEnvironment)) {
    throw new Error('Original noninteractive guarded native entry changed.')
  }
  const environment = nativeAgentEnvironment(binary, candidate.runtimeRoot, candidate.controllerEnvironment)
  const child = spawnNativeProcess(binary, argv, {
    cwd: candidate.runtimeRoot, env: environment, recovery: launch.scope,
  })
  launch.child = child
  child.stdin.end()
  return child
}

export async function releaseQualificationQuotaClaims(journal: RemoteOperationJournal, operationId: string): Promise<void> {
  const receipt = await journal.qualificationStatus(operationId)
  if (!receipt || receipt.phase !== 'closed') throw new Error('Positive qualification closure required before quota reclamation.')
  for (const claim of receipt.quotaClaims) {
    const pool = receipt.candidate.fingerprint.schemaVersion === 3 ? receipt.candidate.fingerprint.quotaPool : undefined
    const slot = pool?.slots.find(value => claim.path === join(receipt.candidate.sourceParent, `quota-${value.namespace}.claim.json`)
      && claim.namespace === join(receipt.candidate.sourceParent, value.namespace, operationId))
    if (!slot) throw new Error('Original qualification quota namespace changed.')
    const file = await open(claim.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      .catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (!file) {
      const directory = await open(dirname(claim.path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { await directory.sync() } finally { await directory.close() }
      continue
    }
    try {
      const metadata = await file.stat()
      const identity = JSON.parse(await file.readFile('utf8'))
      if (!metadata.isFile() || metadata.nlink !== 1 || metadata.dev !== claim.device || metadata.ino !== claim.inode
        || !same(identity, { kind: 'qualification', qualificationId: receipt.admission.qualificationId, operationId })) {
        throw new Error('Original qualification quota claim changed.')
      }
      await rm(claim.namespace, { recursive: true, force: true })
      const slotDirectory = await open(dirname(claim.namespace), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { await slotDirectory.sync() } finally { await slotDirectory.close() }
      await rm(claim.path)
      const rootDirectory = await open(dirname(claim.path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { await rootDirectory.sync() } finally { await rootDirectory.close() }
    } finally { await file.close() }
  }
  if (receipt.quotaClaims.length) await journal.qualificationReleaseQuotaClaims(operationId)
}

export async function reconcileInstalledJobRuntimeQualification(input: InstalledJobQualificationReservation)
  : Promise<JobRuntimeQualificationResult> {
  const prior = await input.journal.qualificationStatus(input.admission.operationId)
  if (!prior || !same(prior.admission, input.admission) || !same(prior.candidate, input.candidate)) {
    throw new Error('Original qualification reconciliation receipt required.')
  }
  if (prior.phase === 'received') {
    await input.journal.qualificationConfirmNonEntry(input.admission.operationId)
    const result = { outcome: 'denied' as const, closure: 'confirmed' as const,
      reasons: ['Qualification was interrupted before native entry.'] }
    await input.journal.qualificationResult(input.admission.operationId, result)
    return result
  }
  if (prior.result && prior.phase === 'closed') {
    await releaseQualificationQuotaClaims(input.journal, input.admission.operationId)
    return prior.result
  }
  const reserved = await reserveInstalledJobQualification({ ...input, entry: 'reconcile' })
  const owner = createQualificationNativeOwner(input.candidate, reserved.native, reserved.ownership, reserved.authority)
  let closed = false
  let reason = 'Qualification was interrupted before its result was retained.'
  try {
    // A stopped create needs one absence query, even if failed inspections consumed its cleanup budget.
    if (prior.launches.length === QUALIFICATION_CLEANUP_COMMAND_LIMIT && qualificationCreationStopped(prior)) {
      const identity = prior.container!.identity
      const observation = await runQualificationCommand({ ...reserved.native,
        reserveProcess: reserved.native.reserveCleanupProcess!, spawnProcess: reserved.native.spawnCleanupProcess! },
      input.candidate.fingerprint.runtimeExecutable, ['--remote=false', 'container', 'exists', identity],
      input.candidate.controllerEnvironment, AbortSignal.timeout(30000))
      closed = observation.exitCode === 1 && await reserved.ownership.confirmFailedCreation!(identity)
        && await reserved.native.close()
    } else closed = await owner.close()
  }
  catch (error) { reason = error instanceof Error ? error.message : reason }
  const result: JobRuntimeQualificationResult = { outcome: 'denied',
    closure: closed ? 'confirmed' : 'unconfirmed',
    reasons: prior.result?.outcome === 'denied' ? prior.result.reasons : [reason.slice(0, 500)] }
  if (closed) await reserved.native.recordResult!(result)
  return result
}

export async function recoverInstalledJobRuntimeQualifications(input: {
  journal: RemoteOperationJournal; registry: NativeProcessRegistry
  host: Pick<JobRuntimeNativeAdmissionRecord, 'hostRef' | 'registration' | 'mainInstallationId' | 'bootId'>
}): Promise<void> {
  for (const receipt of await input.journal.pendingQualifications()) {
    const admission = receipt.admission
    if (!same(admission.hostRef, input.host.hostRef)
      || admission.registration?.workerInstallationId !== input.host.registration?.workerInstallationId
      || admission.mainInstallationId !== input.host.mainInstallationId
      || receipt.phase !== 'received' && admission.bootId !== input.host.bootId) {
      throw new Error('Original qualification installation required for restart reconciliation.')
    }
    const unavailable = async () => { throw new Error('Restart reconciliation cannot authorize fresh qualification work.') }
    const result = await reconcileInstalledJobRuntimeQualification({ ...input,
      candidate: receipt.candidate, admission, host: { ...input.host, registration: admission.registration,
        connection: admission.connection }, signal: new AbortController().signal,
      assertAdmission: unavailable, authority: { assertCurrent: unavailable, readApproval: unavailable, reserve: unavailable } })
    if (result.outcome === 'denied' && result.closure !== 'confirmed') throw new Error('Original qualification cleanup remains unconfirmed.')
  }
}

function qualificationContainerOwnership(input: {
  admission: JobRuntimeNativeAdmissionRecord
  registry: NativeProcessRegistry
  journal: RemoteOperationJournal
  owner: string
  assertCurrent(): Promise<void>
  assertClosure(): Promise<void>
}): OCIContainerOwnership {
  const { admission, registry, journal, owner, assertCurrent, assertClosure } = input
  const operationId = admission.operationId
  return {
    scope: { subject: { kind: 'qualification', qualificationId: admission.qualificationId, profileId: admission.profileId,
      profileRevision: admission.profileRevision, operationId, fingerprint: admission.fingerprintDigest }, admission, bootId: admission.bootId },
    assertCurrent, assertClosure,
    async reserveContainerIntent(identity, fingerprint) { await assertCurrent(); await journal.qualificationContainerIntent(operationId, identity, fingerprint) },
    async bindContainer(identity, containerId) { await assertClosure(); await journal.qualificationBindContainer(operationId, identity, containerId) },
    async launchHelpers() {
      const rows = registry.snapshot().launches.filter(row => row.owner === owner && row.lifecycle === 'active')
      if (rows.some(row => !row.guardian || !row.boundary || row.bootId !== admission.bootId)) throw new Error('Original launcher boundary unavailable.')
      return rows.map(row => ({ kind: 'launcher' as const, process: { ...row.guardian!, bootId: row.bootId }, boundary: row.boundary! }))
    },
    async readCertificate(containerId) {
      const receipt = await journal.qualificationStatus(operationId)
      if (!receipt || !same(receipt.admission, admission) || receipt.container?.containerId !== containerId) throw new Error('Original qualification container receipt unavailable.')
      return receipt.container.certificate
    },
    async publish(certificate) { await journal.qualificationCertificate(operationId, certificate) },
    async confirmFailedCreation(identity) {
      await assertClosure()
      const receipt = await journal.qualificationStatus(operationId)
      if (!receipt || receipt.container?.identity !== identity || !qualificationCreationStopped(receipt)) return false
      let closed = false
      await journal.qualificationCreationAbsent(operationId, identity, async () => {
        closed = await registry.closeOwner(owner)
        return closed
      })
      if (!closed) return false
      return true
    },
  }
}
