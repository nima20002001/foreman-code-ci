import { verifyJobInputDirectory } from './inputs.js'
import { componentLogger } from '../diagnostics/logger.js'
import { isDeepStrictEqual as same } from 'node:util'
import { constants } from 'node:fs'
import { open, realpath, readFile } from 'node:fs/promises'
import { JOB_VERIFICATION_OWNER_CONFIGURATION } from '@foreman-code/contracts/job-verification-policy'
import { identity } from '../sources/privateFilesystem.js'
import type { ChildProcess } from 'node:child_process'
import { JobExecutionRecordSchema, type JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { JobQualificationCandidateRecord } from '@foreman-code/contracts/job-verification-runtime'
import { JobQualificationCandidateSchema } from '@foreman-code/contracts/job-runtime'
import { acceptedJobSpecDigests } from '@foreman-code/contracts/jobs-node'
import { createVerificationSystemInput } from './verificationSystemInput.js'
import { createVerificationPublication } from './verificationPublication.js'
import { reserveVerificationReportSpace } from './executorOutputs.js'
import { verificationContextPin } from '../files/jobInputs/manifest.js'
import { bootIdentity } from '../harnesses/recovery/linuxIdentity.js'
import { NativeProcessRegistry, spawnNativeProcess, nativeProcessExit, type NativeProcessRecovery } from '../harnesses/recovery/processRegistry.js'
import { nativeAgentEnvironment } from '../harnesses/secrets.js'
import { jobContainerNonEntryObserved } from './executorJournal.js'
import { RemoteJobExecutionHost, type RemoteJobExecutionHostPorts } from '../runs/remote/jobExecutionHost.js'
import { inspectInstalledJobRuntimeCandidate, type InstalledRuntimeConfigurationLocation } from './installedRuntimeHost.js'
import { PodmanJobSupervisor, type PodmanCommandRunner } from './executorPodman.js'
import type { OCIContainerOwnership } from './executorContainerOwner.js'
import { assertJobRuntimeEntryContext } from './qualification.js'
import type { QualifiedJobProfile } from './executor.js'
import { requireJobGitMounts, verifyJobGitMounts } from './privateGitMounts.js'
import { ignoreError } from '../diagnostics/ignoredError.js'

export type InstalledJobExecutionHostInput = Omit<RemoteJobExecutionHostPorts, 'supervisor'> & {
  configuration: InstalledRuntimeConfigurationLocation | null
  registry: NativeProcessRegistry
  currentBinding?(): Readonly<DeviceSessionBinding>
}
/** Actual Job execution, separate from diagnostics. HRT mounts handle on the
 * existing channel and supplies W09's canonical source/input/output adapters.
 * The caller opens the ORIGINAL journal without initializeNewInstallation.
 */
export function createInstalledJobExecutionHost(input: InstalledJobExecutionHostInput): RemoteJobExecutionHost {
  return new RemoteJobExecutionHost(createInstalledJobExecutionPorts(input))
}

export function createInstalledJobExecutionPorts(input: InstalledJobExecutionHostInput): RemoteJobExecutionHostPorts {
  const admissions = new Map<string, { execution: JobExecutionRecord; filesystem: { device: string; mountId: string } }>()
  const supervisors = new Map<string, Promise<PodmanJobSupervisor<JobExecutionRecord>>>()
  const supervisor = (execution: JobExecutionRecord) => {
    let value = supervisors.get(execution.operationId)
    if (!value) {
      const original = structuredClone(execution)
      value = installedSupervisor(input, original, filesystem => admissions.set(original.operationId, {
        execution: original, filesystem: structuredClone(filesystem),
      }))
      supervisors.set(execution.operationId, value)
    }
    return value
  }
  const systemInput = createVerificationSystemInput({ configuration: input.configuration,
    journal: async () => input.journal })
  const contexts = new Map<string, NonNullable<Awaited<ReturnType<typeof systemInput>>>>()
  return { ...input, supervisor, preparePublication: createVerificationPublication(input.journal),
    releaseOperation(execution) {
      admissions.delete(execution.operationId)
      supervisors.delete(execution.operationId)
      contexts.delete(execution.operationId)
      input.releaseOperation?.(execution)
    },
    async verification(execution) {
      const qualification = await input.journal.qualifiedJobRuntime(execution)
      const result = qualification.result
      if (result?.outcome !== 'qualified' || result.measurement.schemaVersion !== 2) {
        throw new Error('Original verification measurement unavailable.')
      }
      return {
        measurement: result.measurement, dispatchAt: execution.acceptedSpec.lifecycle.dispatchAt,
        async verifyAcceptedSpec(spec) {
          const expected = acceptedJobSpecDigests(spec)
          if (Object.entries(expected).some(([key, value]) => spec[key as keyof typeof expected] !== value)) {
            throw new Error('Accepted verification digests changed.')
          }
        },
        inputs: {
          prepare: input.inputs.prepare.bind(input.inputs),
          async verify(job, source, receipt, signal) {
            const context = await systemInput(job, source, signal)
            if (!context || !same(receipt.verificationContext, verificationContextPin({ verificationContext: context }))) {
              throw new Error('Delivered verification context differs from protected runtime facts.')
            }
            await verifyJobInputDirectory(job, source, receipt, signal)
            contexts.set(job.operationId, context)
          },
        },
        async prepareOutputs(job, signal) {
          const context = contexts.get(job.operationId)
          if (!context) throw new Error('Verified context required before report reservation.')
          const reserve = await reserveVerificationReportSpace(job, signal)
          await input.journal.jobPrepareVerification(job.operationId, { context,
            contextPin: verificationContextPin({ verificationContext: context })!, reserve, finalizedAt: null })
          contexts.delete(job.operationId)
          await input.prepareOutputs?.(job, signal)
        },
      }
    }, source: { async verify(spec, signal) {
    const matches = [...admissions.values()].filter(value => same(value.execution.acceptedSpec, spec))
    if (matches.length !== 1) throw new Error('Unique original installed Job admission missing')
    const { execution, filesystem } = matches[0]!
    const binding = 'deviceId' in input.connection ? structuredClone(input.currentBinding?.()) : null
    const assertCurrent = async () => {
      signal.throwIfAborted()
      if ('deviceId' in input.connection && (!binding || !same(input.currentBinding?.(), binding))) throw new Error('Actual Job channel changed')
      const status = await input.journal.jobStatus(execution.operationId)
      signal.throwIfAborted()
      if (status.status !== 'known' || !same(status.receipt.execution, execution) || !same(status.receipt.connection, input.connection) ||
        status.receipt.stopFence || status.receipt.terminal) throw new Error('Original Job source owner changed')
      await input.authorize(status.receipt.intent, execution, 'start')
      signal.throwIfAborted()
      if ('deviceId' in input.connection && (!binding || !same(input.currentBinding?.(), binding))) throw new Error('Actual Job channel changed')
    }
    await assertCurrent()
    const source = await input.source.verify(spec, signal)
    await assertCurrent()
    const mounts = requireJobGitMounts(execution, source)
    await verifyJobGitMounts(execution, source)
    await assertCurrent()
    for (const mount of [{ directory: source.privateRepositoryRoot, filesystem: undefined }, mounts.git, mounts.scheduler]) {
      const root = await open(mount.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try {
        await assertCurrent()
        if (await realpath(mount.directory) !== mount.directory) throw new Error('Private Job mount retargeted')
        await assertCurrent()
        const observed = await identity(root)
        await assertCurrent()
        // Leaf receipts pin each inode; common admission independently bounds
        // every mount to the originally qualified filesystem.
        if ((mount.filesystem && !same(observed, mount.filesystem)) ||
          observed.device !== filesystem.device || observed.mountId !== filesystem.mountId) throw new Error('Private Job mount escapes qualified filesystem or identity')
      } finally { await root.close() }
      await assertCurrent()
    }
    return source
  } } }
}

async function installedSupervisor(input: InstalledJobExecutionHostInput, raw: JobExecutionRecord, admitted: (filesystem: { device: string; mountId: string }) => void): Promise<PodmanJobSupervisor<JobExecutionRecord>> {
  const execution = JobExecutionRecordSchema.parse(raw), target = execution.acceptedSpec.target, connection = input.connection
  const unavailable: PodmanCommandRunner = { async run() { throw new Error('Original qualified OCI runtime unavailable') }, async attach() { throw new Error('Original qualified OCI runtime unavailable') } }
  const observedHost = () => {
    const binding = 'deviceId' in connection ? input.currentBinding?.() : null
    if ('deviceId' in connection && (!binding || binding.mainId !== connection.mainId || binding.deviceId !== connection.deviceId ||
      binding.workerInstallationId !== connection.workerInstallationId || binding.keyRevision !== connection.keyRevision ||
      binding.authorizationRevision !== connection.authorizationRevision || binding.bootId !== connection.bootId)) throw new Error('Actual Job channel unavailable')
    return { hostRef: target.hostRef, registration: target.registration, mainInstallationId: target.mainInstallationId, bootId: connection.bootId, connection: binding ?? null }
  }
  let candidate: JobQualificationCandidateRecord, profile: QualifiedJobProfile, measurementExpiresAt: string
  try {
    const original = await input.journal.qualifiedJobRuntime(execution)
    if (original.result?.outcome !== 'qualified') throw new Error('Original runtime measurement missing')
    candidate = original.candidate
    const result = original.result
    if ('runtime' in result) profile = result.runtime
    else profile = result.measurement.runtime
    measurementExpiresAt = result.measurement.expiresAt
    const root = candidate.sourceParent, repository = target.destination.canonicalProjectRoot
    if (bootIdentity() !== connection.bootId || candidate.fingerprint.bootId !== connection.bootId ||
      target.destination.managedRuntimeRoot !== candidate.runtimeRoot || !repository.startsWith(`${root}/`) ||
      repository.slice(root.length + 1).split('/').some(part => !part || part === '.' || part === '..') ||
      !same(original.result.measurement.fingerprint, candidate.fingerprint) ||
      (original.result.measurement.schemaVersion === 1 ? original.result.measurement.fingerprintDigest : original.result.measurement.identity.fingerprintDigest) !== original.admission.fingerprintDigest ||
      (original.result.measurement.schemaVersion === 1 ? original.result.measurement.qualificationId : original.result.measurement.identity.qualificationId) !== candidate.qualificationId ||
      (original.result.measurement.schemaVersion === 1 ? original.result.measurement.approvalId : original.result.measurement.identity.approvalId) !== candidate.approvalId) throw new Error('Original measured Job placement changed')
    await inspectInstalledJobRuntimeCandidate({ configuration: input.configuration, candidate, host: {
      hostRef: target.hostRef, registration: target.registration, mainInstallationId: target.mainInstallationId, bootId: connection.bootId,
      // Retained diagnostic connection is physical provenance only. Every fresh
      // create/start below still requires the current authenticated Main channel.
      connection: original.admission.connection,
    } })
  } catch (error) {
    componentLogger('jobs').error({ err: error, executionId: execution.id }, 'Installed Job qualification read failed')
    // executeJob records a positive pre-entry preparation failure; never downgrade isolation.
    return new PodmanJobSupervisor<JobExecutionRecord>(null, unavailable, async () => { throw new Error('Job isolation unavailable') })
  }
  admitted(candidate.fingerprint.root.binding.filesystem)
  const owner = `job:${execution.operationId}:${execution.owner.grantId}:${execution.owner.epoch}`
  const processOwners = [owner, `${owner}:control`, `${owner}:wait`]
  const hostIdentity = (value: typeof connection) => 'deviceId' in value
    ? { mainId: value.mainId, deviceId: value.deviceId, workerInstallationId: value.workerInstallationId,
      bootId: value.bootId, keyRevision: value.keyRevision, authorizationRevision: value.authorizationRevision }
    : value
  const launches = new Map<string, { scope: NativeProcessRecovery; child?: ChildProcess; closed: boolean }>()
  const assertLocal = async () => {
    if (candidate.fingerprint.schemaVersion === 3) {
      await inspectInstalledJobRuntimeCandidate({ configuration: input.configuration, candidate, host: observedHost() })
    } else await assertJobRuntimeEntryContext(JobQualificationCandidateSchema.parse(candidate))
    if (bootIdentity() !== connection.bootId) throw new Error('Original Job boot changed; no automatic reboot relaunch')
    const status = await input.journal.jobStatus(execution.operationId)
    if (status.status !== 'known' || !same(status.receipt.intent.owner, execution.owner) || !same(status.receipt.execution.acceptedSpec, execution.acceptedSpec) ||
      !same(hostIdentity(status.receipt.connection), hostIdentity(connection)) || !status.receipt.entryAttempted) throw new Error('Original Job native owner changed')
  }
  async function closeLaunch(id: string) {
    const launch = launches.get(id)
    if (!launch) throw new Error('Original guarded Job reservation missing')
    if (launch.closed) return
    if (!launch.child) {
      if (!await input.registry.abandonReservedLaunch(launch.scope)) throw new Error('Job reservation closure unconfirmed')
    } else await input.registry.closeRegistration(launch.scope, id)
    const exit = launch.child ? nativeProcessExit(launch.child, { exitCode: null, exitSignal: null }) : null
    await input.journal.jobProcessClosed(execution.operationId, id, exit ? { exitCode: exit.exitCode, signal: exit.exitSignal } : undefined)
    launch.closed = true
  }
  const spawn = async (argv: string[], purpose: 'attachment' | 'control' | 'wait') => {
    await assertLocal()
    const exact = argv[0] === '--remote=false' ? argv : ['--remote=false', ...argv]
    if (exact.some(value => value.includes('\0'))) throw new Error('Invalid Job runtime argv')
    const binary = candidate.fingerprint.runtimeExecutable
    const env = nativeAgentEnvironment(binary, candidate.runtimeRoot, candidate.controllerEnvironment)
    if (!same(nativeAgentEnvironment(binary, candidate.runtimeRoot, env), env)) throw new Error('Protected Job runtime environment changed')
    const processOwner = purpose === 'attachment' ? owner : `${owner}:${purpose}`
    const scope = await input.registry.reserveLaunch(processOwner)
    if (!scope.launchId) throw new Error('Original Job native scope missing')
    const launch: { scope: NativeProcessRecovery; child?: ChildProcess; closed: boolean } = { scope, closed: false }
    launches.set(scope.launchId, launch)
    try {
      await input.journal.jobReserveProcess(execution.operationId, { launchId: scope.launchId, processOwner, binary, argv: exact })
      const status = await input.journal.jobStatus(execution.operationId)
      await authorizeJobContainerEntry({ argv: exact, execution, measurementExpiresAt,
        readStatus: () => input.journal.jobStatus(execution.operationId),
        async authorize() {
          if (status.status !== 'known') throw new Error('Original Job receipt missing')
          await input.authorize(status.receipt.intent, execution, 'start')
        },
        inspect: () => inspectInstalledJobRuntimeCandidate({ configuration: input.configuration,
          candidate, host: observedHost() }),
        async memoryHeadroom() {
          const operations = await input.journal.jobOperations()
          const running = operations.filter(receipt => receipt.execution.schemaVersion === 2
            && receipt.terminal?.processStopped !== true).length
          const meminfo = await readFile('/proc/meminfo', 'utf8')
          const availableKb = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1]
          return { running, availableBytes: availableKb ? Number(availableKb) * 1024 : NaN }
        },
      })
      const child = spawnNativeProcess(binary, exact, { cwd: candidate.runtimeRoot, env, recovery: scope })
      launch.child = child; child.stdin.end()
      return { child, id: scope.launchId }
    } catch (error) { await closeLaunch(scope.launchId); throw error }
  }
  const commands = jobCommandRunner(spawn, closeLaunch)
  const ownership: OCIContainerOwnership = {
    scope: { subject: { kind: 'job', executionId: execution.id, attemptId: execution.attemptId, operationId: execution.operationId, bindingHash: execution.acceptedSpec.bindingHash },
      // W08's admitted operation is the lease, not the diagnostic's human admission.
      leaseId: execution.operationId, owner: execution.owner, observedDeviceId: target.hostRef.kind === 'device' ? target.hostRef.deviceId : null,
      observedInstallationId: target.registration?.workerInstallationId ?? target.mainInstallationId, bootId: connection.bootId },
    assertCurrent: assertLocal,
    reserveContainerIntent: (identity, fingerprint) => input.journal.jobContainerIntent(execution.operationId, identity, fingerprint, candidate.operationId),
    bindContainer: (identity, containerId) => input.journal.jobBindContainer(execution.operationId, identity, containerId),
    async launchHelpers() {
      // A stopped container must also join its original attached launcher. This
      // never kills a PID inferred from absence or borrowed from another owner.
      for (const [id, launch] of launches) if (!launch.closed && launch.child?.exitCode !== null && launch.child?.exitCode !== undefined) await closeLaunch(id)
      const retained = await input.journal.jobNativeOwner(execution.operationId)
      for (const launch of retained?.launches ?? []) {
        if (launch.closed || launches.has(launch.launchId)) continue
        const processOwner = launch.processOwner ?? owner
        if (!processOwners.includes(processOwner)) throw new Error('Original Job controller owner changed')
        await input.registry.closeRegistration(input.registry.scope(processOwner), launch.launchId)
        await input.journal.jobProcessClosed(execution.operationId, launch.launchId)
      }
      const rows = input.registry.snapshot().launches.filter(row => processOwners.includes(row.owner) && row.lifecycle === 'active')
      if (rows.some(row => !row.guardian || !row.boundary || row.bootId !== connection.bootId
        || !retained?.launches.some(launch => launch.launchId === row.launchId && (launch.processOwner ?? owner) === row.owner))) {
        throw new Error('Original Job launcher boundary unavailable')
      }
      return rows.map(row => ({ kind: 'launcher' as const, process: { ...row.guardian!, bootId: row.bootId }, boundary: row.boundary! }))
    },
    async closeHelpers() {
      const retained = await input.journal.jobNativeOwner(execution.operationId)
      for (const launch of retained?.launches ?? []) {
        if (launch.closed) continue
        if (launches.has(launch.launchId)) await closeLaunch(launch.launchId)
        else {
          const processOwner = launch.processOwner ?? owner
          if (!processOwners.includes(processOwner)) throw new Error('Original Job controller owner changed')
          await input.registry.closeRegistration(input.registry.scope(processOwner), launch.launchId)
          await input.journal.jobProcessClosed(execution.operationId, launch.launchId)
        }
      }
      const recordedOwners = new Set((retained?.launches ?? []).map(launch => launch.processOwner ?? owner))
      const closed = await Promise.all([...recordedOwners].map(processOwner => input.registry.closeOwner(processOwner)))
      return closed.every(Boolean)
    },
    async confirmUnreleasedClosure(containerId) {
      const retained = await input.journal.jobNativeOwner(execution.operationId)
      if (!retained?.container || retained.container.containerId !== containerId
        || retained.container.certificate || retained.launches.some(launch => !launch.closed)) return false
      // The command gate is released only after a durable certificate and an
      // explicitly journaled exec. A stopped bootstrap never ran user argv.
      if (retained.launches.some(launch => {
        const argv = launch.argv[0] === '--remote=false' ? launch.argv.slice(1) : launch.argv
        return argv[0] === 'exec'
      })) return false
      await input.journal.jobConfirmUnreleasedClosure(execution.operationId, containerId)
      return true
    },
    async confirmFailedCreation(identity) {
      const retained = await input.journal.jobNativeOwner(execution.operationId)
      if (!retained || retained.container?.identity !== identity || !jobContainerNonEntryObserved(retained)
        || retained.launches.some(launch => launch.binary !== candidate.fingerprint.runtimeExecutable)) return false
      const active = input.registry.snapshot().launches.filter(launch => processOwners.includes(launch.owner)
        && launch.lifecycle !== 'closed')
      if (active.some(launch => !retained.launches.some(recorded => recorded.launchId === launch.launchId
        && (recorded.processOwner ?? owner) === launch.owner))) return false
      const recordedOwners = new Set(retained.launches.map(launch => launch.processOwner ?? owner))
      if (!(await Promise.all([...recordedOwners].map(processOwner => input.registry.closeOwner(processOwner)))).every(Boolean)) return false
      await input.journal.jobConfirmContainerNonEntry(execution.operationId, candidate.fingerprint.runtimeExecutable)
      return true
    },
    async readCertificate(containerId) {
      const native = await input.journal.jobNativeOwner(execution.operationId)
      if (!native?.container || native.container.containerId !== containerId) throw new Error('Original Job container evidence missing')
      return native.container.certificate
    },
    publish: certificate => input.journal.jobCertificate(execution.operationId, certificate),
  }
  const qualification = await input.journal.qualifiedJobRuntime(execution)
  const verification = execution.schemaVersion === 2 && qualification.result?.outcome === 'qualified'
    && qualification.result.measurement.schemaVersion === 2 ? {
      measurement: qualification.result.measurement, dispatchAt: execution.acceptedSpec.lifecycle.dispatchAt,
      verifyGit: verifyJobGitMounts, verifyInputs: async (job: import('./executor.js').VerificationExecution,
        source: import('./inputs.js').VerifiedJobSource, receipt: import('@foreman-code/contracts/job-inputs').JobInputDeliveryReceipt, signal: AbortSignal) => {
        await verifyJobInputDirectory(job,source,receipt,signal)
      },
    } : undefined
  return new PodmanJobSupervisor<JobExecutionRecord>(profile, commands, async current => {
    if (!same(current.acceptedSpec, execution.acceptedSpec) || current.id !== execution.id || current.attemptId !== execution.attemptId) throw new Error('Original Job supervisor subject changed')
    return ownership
  }, {
    async deadlineMs() { const owner = await input.journal.jobNativeOwner(execution.operationId); if (!owner?.container?.deadlineAt) throw new Error('Original Job deadline missing'); return Date.parse(owner.container.deadlineAt) },
    markTimeout: () => input.journal.jobTimedOut(execution.operationId),
    async isTimedOut() { return (await input.journal.jobNativeOwner(execution.operationId))?.timedOut ?? false },
  }, verification)
}

export async function authorizeJobContainerEntry(input: {
  argv: string[]
  execution: JobExecutionRecord
  measurementExpiresAt: string
  readStatus(): ReturnType<RemoteJobExecutionHostPorts['journal']['jobStatus']>
  authorize(): Promise<void>
  inspect(): Promise<void>
  memoryHeadroom(): Promise<{ running: number; availableBytes: number }>
}): Promise<void> {
  const subcommand = input.argv.find(argument => !argument.startsWith('-'))
  if (!['create', 'start', 'exec'].includes(subcommand ?? '')) return
  const assertEntry = async () => {
    if (Date.parse(input.measurementExpiresAt) <= Date.now()) {
      throw new Error('Original Job qualification expired before native entry')
    }
    const status = await input.readStatus()
    if (status.status !== 'known' || status.receipt.stopFence || status.receipt.terminal) {
      throw new Error('Job entry fenced')
    }
  }
  await assertEntry()
  await input.authorize()
  await input.inspect()
  if (input.execution.schemaVersion === 2 && input.execution.acceptedSpec.target.hostRef.kind === 'device') {
    const { running, availableBytes } = await input.memoryHeadroom()
    const minimum = JOB_VERIFICATION_OWNER_CONFIGURATION.laptopMinimumAvailableBytes
      + JOB_VERIFICATION_OWNER_CONFIGURATION.laptopPerRunningJobBytes * running
    if (!Number.isSafeInteger(availableBytes) || availableBytes < minimum) {
      throw new Error('Laptop memory headroom changed before verification entry.')
    }
  }
  await assertEntry()
}

function jobCommandRunner(
  spawn: (argv: string[], purpose: 'attachment' | 'control' | 'wait') => Promise<{
    child: ReturnType<typeof spawnNativeProcess>; id: string
  }>,
  closeLaunch: (id: string) => Promise<void>,
): PodmanCommandRunner {
  let controlTail = Promise.resolve()
  return {
    async attach(argv) {
      const { child, id } = await spawn(argv, 'attachment')
      // Physical closure is also joined by ownership.launchHelpers below.
      child.once('close', () => { void closeLaunch(id).catch(ignoreError('jobs', 'close job helper launch', { launchId: id })) })
      return child
    },
    async run(argv, timeoutMs = 30000) {
      const purpose = argv[0] === 'wait' ? 'wait' : 'control'
      let releaseControl: (() => void) | undefined
      if (purpose === 'control') {
        const previous = controlTail
        controlTail = new Promise<void>(resolve => { releaseControl = resolve })
        await previous
      }
      try {
        const { child, id } = await spawn(argv, purpose)
        return await new Promise<{ exitCode: number; stdout: string }>((resolve, reject) => {
        let text = '', bytes = 0, interrupted = false
        const interrupt = (error: Error) => {
          if (interrupted) return
          interrupted = true
          void closeLaunch(id).then(() => reject(error), reject)
        }
        const deadline = setTimeout(() => interrupt(new Error('Job runtime control deadline exceeded')), timeoutMs)
        child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 65536) interrupt(new Error('Job control reply exceeded budget')); else text += chunk.toString('utf8') })
        child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 65536) interrupt(new Error('Job control reply exceeded budget')) })
        child.once('error', error => { clearTimeout(deadline); interrupt(error) })
        child.once('close', () => {
          clearTimeout(deadline)
          if (interrupted) return
          const exit = nativeProcessExit(child, { exitCode: null, exitSignal: null })
          void closeLaunch(id).then(() => {
            if (exit.exitCode === null) reject(new Error('Original Job runtime exit unconfirmed'))
            else resolve({ exitCode: exit.exitCode, stdout: text })
          }, reject)
        })
        })
      } finally { releaseControl?.() }
    },
  }
}
