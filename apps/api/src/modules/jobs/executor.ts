import { JobPreparationRetryError, retryJobPreparation } from './preparationRetry.js'
import { JOB_GIT_ENVIRONMENT, JOB_PRIVATE_GIT_LAYOUT, requireJobGitMounts } from './privateGitMounts.js'
import { requireJobInputReceipt,JOB_INPUT_MANIFEST_CONTAINER_PATH,type VerifiedJobSource } from './inputs.js'
import type { JobInputDeliveryReceipt } from '@foreman-code/contracts/job-inputs'
import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { AcceptedJobSpecSchema, JobExecutionSchema, type AcceptedJobSpec, type PreparedJobSpec, type JobExecution } from '@foreman-code/contracts'
import { jobSpecDigests } from '@foreman-code/contracts/jobs-node'
import { componentLogger } from '../diagnostics/logger.js'
import { fallbackOnError } from '../diagnostics/ignoredError.js'
import { isDeepStrictEqual } from 'node:util'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { AcceptedVerificationJobSpecSchema, VerificationJobExecutionSchema, JobExecutionRecordSchema,
  type AcceptedVerificationJobSpec } from '@foreman-code/contracts/job-verification'
import type { z } from 'zod'
import { JobVerificationRuntimeMeasurementSchema, type JobVerificationRuntimeMeasurement }
  from '@foreman-code/contracts/job-verification-runtime'
import { JOB_VERIFICATION_OWNER_CONFIGURATION, JobVerificationDispatchValiditySchema, type JobNetworkPolicy } from '@foreman-code/contracts/job-verification-policy'
export { jobSpecDigests } from '@foreman-code/contracts/jobs-node'

/** These ports are supplied by W08/W09/W07, never by the untrusted build. */
export type RuntimeJobExecution = z.infer<typeof JobExecutionRecordSchema>
export type VerificationExecution = z.infer<typeof VerificationJobExecutionSchema>
export interface JobLaunchAuthority<Execution extends RuntimeJobExecution = JobExecution> {
  recheck(execution: Execution): Promise<void>
  claim(execution: Execution, supervisorIdentity: string): Promise<'launch' | 'cancelled' | 'reconcile'>
  launched(execution: Execution, supervisorIdentity: string, containerId?: string): Promise<void>
}
export interface JobSourcePort<Spec extends RuntimeJobExecution['acceptedSpec'] = AcceptedJobSpec> {
  verify(spec: Spec, signal: AbortSignal): Promise<VerifiedJobSource>
}
export interface QualifiedJobProfile {
  workspaceLayout?:string|undefined
  policyId: string
  policyRevision: number
  imageDigest: string
  toolchainDigest: string
  runtimeVersion: string
  ociRuntimeVersion: string
  kernelVersion: string
  qualificationId: string
  rootless: true
  cgroupV2: true
  filesystemBounded: true
  descendantContainment: true
  network: 'none' | JobNetworkPolicy
  cpuLimit: number
  memoryBytes: number
  pidsLimit: number
  diskBytes: number
}

/** Verification evidence is separate from the seven-check build qualification. */
export function requireVerificationRuntime(
  input: AcceptedVerificationJobSpec,
  raw: JobVerificationRuntimeMeasurement,
  runtime: QualifiedJobProfile | null,
  now = Date.now(),
  dispatchAt = input.lifecycle.dispatchAt,
): JobVerificationRuntimeMeasurement {
  const spec = AcceptedVerificationJobSpecSchema.parse(input)
  const measured = JobVerificationRuntimeMeasurementSchema.parse(raw)
  if (!runtime) throw new Error('The accepted verification has no matching measured offline runtime.')
  if (dispatchAt !== spec.lifecycle.dispatchAt || Date.parse(dispatchAt) > now || Date.parse(measured.identity.approvalExpiresAt) <= now
    || Date.parse(measured.expiresAt) <= now) throw new Error('Original verification qualification expired or dispatch changed.')
  const fingerprint = measured.fingerprint
  const digest = createHash('sha256').update(canonicalGraphJson(fingerprint)).digest('hex')
  const suite = measured.suites.find(value => value.suite === spec.verification.suite)
  const durations = [spec.policy.preparationTimeoutMs, spec.policy.serviceStartupTimeoutMs,
    spec.policy.executionTimeoutMs, spec.policy.cancellationGraceMs, spec.policy.publicationTimeoutMs,
    spec.policy.cleanupTimeoutMs]
  if (!spec.argv[0] || spec.argv.some(argument => argument.includes('\0'))
    || durations.some(value => value > 2147423647)
    || spec.policy.maxLogChunkBytes < 4 || spec.policy.maxWorkerSpoolBytes < 8) {
    throw new Error('Verification argv, deadlines or stream budgets exceed runtime support.')
  }
  const remainingMs = Math.min(Date.parse(measured.expiresAt), Date.parse(measured.identity.approvalExpiresAt)) - now
  const entryBudgetMs = spec.policy.serviceStartupTimeoutMs + spec.policy.executionTimeoutMs
    + spec.policy.cancellationGraceMs + spec.policy.publicationTimeoutMs + spec.policy.cleanupTimeoutMs
  if (remainingMs < entryBudgetMs) throw new Error('Verification approval cannot cover execution and closure.')
  if (!suite || !isDeepStrictEqual(spec.profile, measured.identity) || digest !== measured.identity.fingerprintDigest
    // Another commit runs only on Main's proof that its dependency files equal the qualification commit's.
    || fingerprint.sourceCommit !== spec.source.commit && spec.dependencyBasis?.qualificationCommit !== fingerprint.sourceCommit
    || !isDeepStrictEqual(spec.target.hostRef, fingerprint.hostRef)
    || !isDeepStrictEqual(spec.target.registration, fingerprint.registration)
    || spec.target.mainInstallationId !== fingerprint.mainInstallationId
    || spec.profile.rootId !== fingerprint.root.binding.rootId
    || spec.profile.bindingRevision !== fingerprint.root.binding.bindingRevision
    || !spec.target.destination.canonicalProjectRoot.startsWith(`${fingerprint.root.binding.canonicalPath}/`)
    || spec.verification.credentialRefs.length || fingerprint.network.mode !== 'none'
    || runtime.policyId !== fingerprint.profileId || runtime.policyRevision !== fingerprint.profileRevision
    || runtime.imageDigest !== fingerprint.imageDigest || runtime.toolchainDigest !== fingerprint.toolchainDigest
    || runtime.qualificationId !== measured.identity.qualificationId
    || runtime.workspaceLayout !== JOB_PRIVATE_GIT_LAYOUT
    || (typeof runtime.network === 'string' ? runtime.network : runtime.network.mode) !== 'none'
    || !runtime.rootless || !runtime.cgroupV2 || !runtime.filesystemBounded || !runtime.descendantContainment
    || !runtime.runtimeVersion || !runtime.ociRuntimeVersion || !runtime.kernelVersion
    || spec.verification.parameters.unitWorkers > Math.min(suite.maxUnitWorkers, JOB_VERIFICATION_OWNER_CONFIGURATION.unitWorkers)
    || spec.verification.parameters.integrationShards > suite.maxIntegrationShards
    || !isDeepStrictEqual(spec.verification.resources, suite.resources)) {
    throw new Error('The accepted verification has no matching measured offline runtime.')
  }
  const resources = spec.verification.resources
  for (const key of ['cpuLimit', 'memoryBytes', 'pidsLimit', 'diskBytes'] as const) {
    if (runtime[key] !== resources.limits[key]) throw new Error('Verification runtime differs from its reservation.')
  }
  // Volume capacity is not a Job quota. Both mutable byte and inode limits need effective readback.
  if (fingerprint.quota.workloadHardLimitBytes > resources.limits.diskBytes
    || fingerprint.quota.workloadHardInodes > resources.mutableInodes
    || suite.coldCachePeakBytes > fingerprint.quota.workloadHardLimitBytes
    || suite.coldCachePeakInodes > fingerprint.quota.workloadHardInodes
    || fingerprint.quota.workloadUsageBytes > resources.limits.diskBytes - resources.reportBytes
    || resources.controlTempBytes + resources.shmBytes > resources.limits.memoryBytes) {
    throw new Error('Verification byte, inode, report reserve or private memory budget is unenforced.')
  }
  JobVerificationDispatchValiditySchema.parse({ identity: measured.identity,
    approvalConfig: fingerprint.approvalConfig, approvedAt: measured.approvedAt,
    dispatchAt, policy: spec.policy })
  return measured
}
export interface JobLaunchPlan<Execution extends RuntimeJobExecution = JobExecution> {
  identity: string
  execution: Execution
  privateRepositoryRoot: string
  verifiedSource: VerifiedJobSource
  inputs: JobInputDeliveryReceipt
  cwd: string
  argv: readonly string[]
  environment: Readonly<Record<string, string>>
  stdin: 'closed'
  pty: false
  profile: QualifiedJobProfile
}
export interface JobExitEvidence { exitCode: number | null; signal: string | null; execError?: string; timedOut?: boolean }
export interface JobSupervisedProcess {
  containerId?: string
  stdout: AsyncIterable<Uint8Array>
  stderr: AsyncIterable<Uint8Array>
  exited: Promise<JobExitEvidence>
  /** Includes all descendants, using runtime identity rather than an unverified PID. */
  stop(graceMs: number): Promise<boolean>
  proveStopped(): Promise<boolean>
}
export interface JobSupervisor<Execution extends RuntimeJobExecution = JobExecution> {
  qualifiedProfile: QualifiedJobProfile | null
  launch(plan: JobLaunchPlan<Execution>): Promise<JobSupervisedProcess>
}
export interface JobExecutorPorts<Execution extends RuntimeJobExecution = JobExecution> {
  authority: JobLaunchAuthority<Execution>
  source: JobSourcePort<Execution['acceptedSpec']>
  inputs: {
    prepare(execution: Execution, source: VerifiedJobSource, signal: AbortSignal): Promise<JobInputDeliveryReceipt>
  }
  supervisor: JobSupervisor<Execution>
  /** Resolves only after the bounded W08 worker spool has durably accepted the chunk. */
  appendLog(chunk: { executionId: string; attemptId: string; sequence: number; stream: 'stdout' | 'stderr'; text: string; byteSize: number; createdAt: string }): Promise<void>
  collectOutputs(execution: Execution): Promise<void>
  /** Allocate interruption-report capacity before claim, inside the retained private source reservation. */
  prepareOutputs?(execution: Execution, signal: AbortSignal): Promise<void>
}
export interface VerificationJobExecutorPorts extends JobExecutorPorts<VerificationExecution> {
  measurement: JobVerificationRuntimeMeasurement
  dispatchAt: string
  /** Shared versioned digest and W09 physical receipt validation; no build projection is permitted. */
  verifyAcceptedSpec(spec: AcceptedVerificationJobSpec): Promise<void>
  inputs: JobExecutorPorts<VerificationExecution>['inputs'] & {
    verify(execution: VerificationExecution, source: VerifiedJobSource,
      receipt: JobInputDeliveryReceipt, signal: AbortSignal): Promise<void>
  }
  prepareOutputs(execution: VerificationExecution, signal: AbortSignal): Promise<void>
}
export interface JobExecutorResult {
  outcome: 'succeeded' | 'build_failed' | 'spawn_failed' | 'preparation_failed' | 'cancelled' | 'timed_out' | null
  exitCode: number | null
  signal: string | null
  processStopped: boolean
  supervisorIdentity: string
  containerId: string | null
  recoveryRequired: boolean
  logError: boolean
  logsTruncated: boolean
  outputCollectionError: boolean
}

export function jobSupervisorIdentity(execution: Pick<JobExecution, 'id' | 'attemptId' | 'operationId' | 'owner'> & {
  acceptedSpec: Pick<AcceptedJobSpec, 'specDigest'>
}): string {
  return `graphql-job-${createHash('sha256').update(JSON.stringify([execution.id, execution.attemptId, execution.operationId, execution.owner, execution.acceptedSpec.specDigest])).digest('hex')}`
}

function requireProfile(spec: AcceptedJobSpec, profile: QualifiedJobProfile | null): QualifiedJobProfile {
  if (!profile || !profile.qualificationId || !profile.runtimeVersion || !profile.ociRuntimeVersion || !profile.kernelVersion ||
    profile.policyId !== spec.policy.isolationPolicyId || profile.policyRevision !== spec.policy.isolationPolicyRevision ||
    profile.imageDigest !== spec.policy.imageDigest || profile.toolchainDigest !== spec.policy.toolchainDigest ||
    profile.rootless !== true || profile.cgroupV2 !== true || profile.filesystemBounded !== true || profile.descendantContainment !== true ||
    profile.workspaceLayout !== JOB_PRIVATE_GIT_LAYOUT || profile.network !== 'none' || spec.policy.network !== 'none' || spec.policy.environmentScopeRefs.length > 0 || spec.policy.maxLogChunkBytes < 4 || spec.policy.maxWorkerSpoolBytes < 8 ||
    [spec.policy.preparationTimeoutMs, spec.policy.executionTimeoutMs, spec.policy.cancellationGraceMs].some(value => value > 2147423647) ||
    ![profile.cpuLimit, profile.memoryBytes, profile.pidsLimit, profile.diskBytes].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('Qualified offline rootless isolation unavailable for the accepted policy.')
  }
  return profile
}

async function prepareWithinBudget<T>(budgetMs: number, cancellation: AbortSignal, prepare: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController()
  const onCancel = () => abort.abort()
  cancellation.addEventListener('abort', onCancel, { once: true })
  const deadline = setTimeout(() => abort.abort(), budgetMs)
  const preparation = Promise.resolve().then(() => prepare(abort.signal))
  try {
    return await Promise.race([preparation, new Promise<never>((_resolve, reject) => {
      abort.signal.addEventListener('abort', () => reject(new Error('Preparation interrupted.')), { once: true })
      if (cancellation.aborted) abort.abort()
    })])
  } catch (error) {
    // Aborted preparation can still own input writers until its original promise settles.
    const [settled] = await Promise.allSettled([preparation])
    if (settled.status === 'rejected' && settled.reason instanceof JobPreparationRetryError) throw settled.reason
    throw error
  } finally { clearTimeout(deadline); cancellation.removeEventListener('abort', onCancel) }
}

/** Worker-local deadline and durable ownership; this is an executor, not a scheduler. */
export async function executeJob(input: JobExecution, ports: JobExecutorPorts, cancellation: AbortSignal): Promise<JobExecutorResult> {
  const execution = JobExecutionSchema.parse(input)
  const spec = AcceptedJobSpecSchema.parse(execution.acceptedSpec)
  const identity = jobSupervisorIdentity(execution)
  const result: JobExecutorResult = { outcome: null, exitCode: null, signal: null, processStopped: false,
    supervisorIdentity: identity, containerId: null, recoveryRequired: false, logError: false, logsTruncated: false, outputCollectionError: false }
  if (execution.process.phase === 'terminal') throw new Error('Terminal execution requires readback, not dispatch.')
  if (cancellation.aborted || execution.cancelRequestedAt) return { ...result, outcome: 'cancelled', processStopped: true }
  let plan: JobLaunchPlan
  try {
    plan = await prepareWithinBudget(spec.policy.preparationTimeoutMs, cancellation, async signal => {
      if (!spec.argv[0] || spec.argv.some(argument => argument.includes('\0'))) throw new Error('Executable/argv rejected.')
      if ((execution.workflow === null) !== (spec.workflowInput === null)) throw new Error('Accepted workflow input binding mismatch.')
      const preparedSpec: PreparedJobSpec = { source: spec.source, target: spec.target, argv: spec.argv, inputs: spec.inputs,
        policy: spec.policy, outputs: spec.outputs, ...(spec.computerSelection ? { computerSelection: spec.computerSelection } : {}),
        ...(spec.relativeCwd ? { relativeCwd: spec.relativeCwd } : {}) }
      for (const [key, digest] of Object.entries(jobSpecDigests(preparedSpec, spec.workflowInput))) {
        if (spec[key as keyof ReturnType<typeof jobSpecDigests>] !== digest) throw new Error('Accepted specification digest mismatch.')
      }
      await retryJobPreparation(signal, () => ports.authority.recheck(execution))
      const profile = requireProfile(spec, ports.supervisor.qualifiedProfile)
      const source = await retryJobPreparation(signal, () => ports.source.verify(spec, signal))
      if (signal.aborted) throw new Error('Preparation interrupted.')
      if (!source.privateGit || !Number.isFinite(source.diskQuotaBytes) || source.diskQuotaBytes <= 0 || source.diskQuotaBytes > profile.diskBytes ||
        source.directoryIdentityHash !== spec.target.destination.directoryIdentityHash ||
        !source.privateRepositoryRoot.startsWith('/') || source.privateRepositoryRoot !== spec.target.destination.canonicalProjectRoot) {
        throw new Error('Accepted private source/root identity changed.')
      }
      requireJobGitMounts(execution,source)
      const deliveredInputs = await retryJobPreparation(signal, () => ports.inputs.prepare(execution, source, signal))
      signal.throwIfAborted()
      const inputs = requireJobInputReceipt(execution, source, deliveredInputs)
      await retryJobPreparation(signal, () => ports.prepareOutputs?.(execution, signal))
      if(signal.aborted)throw new Error('Input delivery interrupted.')
      const cwd = spec.relativeCwd ? `${source.privateRepositoryRoot}/${spec.relativeCwd}` : source.privateRepositoryRoot
      if (cwd !== spec.target.destination.canonicalCwd) throw new Error('Accepted working directory changed.')
      const prepared: JobLaunchPlan = { identity, execution, privateRepositoryRoot: source.privateRepositoryRoot, verifiedSource:{...source}, inputs, cwd, argv: spec.argv,
        environment: { HOME: '/tmp/job-home', PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', CI: '1',...JOB_GIT_ENVIRONMENT,FOREMAN_CODE_JOB_INPUT_MANIFEST:JOB_INPUT_MANIFEST_CONTAINER_PATH,GRAPHQL_JOB_INPUT_MANIFEST:JOB_INPUT_MANIFEST_CONTAINER_PATH }, stdin: 'closed', pty: false, profile }
      await retryJobPreparation(signal, () => ports.authority.recheck(execution))
      return prepared
    })
  } catch (error) {
    if (!cancellation.aborted && error instanceof JobPreparationRetryError) throw error.cause
    componentLogger('jobs').warn({ err: error, executionId: execution.id }, 'Job preparation failed before native entry')
    return { ...result, outcome: cancellation.aborted ? 'cancelled' : 'preparation_failed', processStopped: true }
  }
  if (cancellation.aborted) return { ...result, outcome: 'cancelled', processStopped: true }
  return superviseJob(plan, ports, cancellation, result)
}

/** Verification retains its accepted record and shares build supervision, deadlines, logs and descendant closure. */
export async function executeVerificationJob(
  raw: VerificationExecution,
  ports: VerificationJobExecutorPorts,
  cancellation: AbortSignal,
): Promise<JobExecutorResult> {
  const execution = VerificationJobExecutionSchema.parse(raw)
  const spec = execution.acceptedSpec
  const identity = jobSupervisorIdentity(execution)
  const result: JobExecutorResult = { outcome: null, exitCode: null, signal: null, processStopped: false,
    supervisorIdentity: identity, containerId: null, recoveryRequired: false, logError: false,
    logsTruncated: false, outputCollectionError: false }
  if (execution.process.phase === 'terminal') throw new Error('Terminal execution requires readback, not dispatch.')
  if (cancellation.aborted || execution.cancelRequestedAt) return { ...result, outcome: 'cancelled', processStopped: true }
  let plan: JobLaunchPlan<VerificationExecution>
  try {
    plan = await prepareWithinBudget(spec.policy.preparationTimeoutMs, cancellation, async signal => {
      await retryJobPreparation(signal, () => ports.authority.recheck(execution))
      await retryJobPreparation(signal, () => ports.verifyAcceptedSpec(spec))
      const profile = ports.supervisor.qualifiedProfile
      requireVerificationRuntime(spec, ports.measurement, profile, Date.now(), ports.dispatchAt)
      if (!profile) throw new Error('Qualified verification runtime unavailable.')
      const source = await retryJobPreparation(signal, () => ports.source.verify(spec, signal))
      signal.throwIfAborted()
      if (!source.privateGit || source.privateRepositoryRoot !== spec.target.destination.canonicalProjectRoot
        || source.directoryIdentityHash !== spec.target.destination.directoryIdentityHash
        || source.diskQuotaBytes !== spec.verification.resources.limits.diskBytes) {
        throw new Error('Accepted verification source or quota changed.')
      }
      requireJobGitMounts(execution, source)
      const inputs = await retryJobPreparation(signal, () => ports.inputs.prepare(execution, source, signal))
      signal.throwIfAborted()
      await retryJobPreparation(signal, () => ports.inputs.verify(execution, source, inputs, signal))
      signal.throwIfAborted()
      await retryJobPreparation(signal, () => ports.prepareOutputs(execution, signal))
      signal.throwIfAborted()
      const cwd = spec.relativeCwd ? `${source.privateRepositoryRoot}/${spec.relativeCwd}` : source.privateRepositoryRoot
      if (cwd !== spec.target.destination.canonicalCwd) throw new Error('Accepted verification working directory changed.')
      await retryJobPreparation(signal, () => ports.authority.recheck(execution))
      return { identity, execution, privateRepositoryRoot: source.privateRepositoryRoot, verifiedSource: source, inputs,
        cwd, argv: spec.argv, environment: { HOME: '/job-scratch/home', TMPDIR: '/job-scratch/tmp',
          PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', CI: '1', ...JOB_GIT_ENVIRONMENT,
          FOREMAN_CODE_JOB_INPUT_MANIFEST: JOB_INPUT_MANIFEST_CONTAINER_PATH,
          GRAPHQL_JOB_INPUT_MANIFEST: JOB_INPUT_MANIFEST_CONTAINER_PATH }, stdin: 'closed', pty: false, profile }
    })
  } catch (error) {
    if (!cancellation.aborted && error instanceof JobPreparationRetryError) throw error.cause
    componentLogger('jobs').warn({ err: error, executionId: execution.id }, 'Verification preparation failed before native entry')
    return { ...result, outcome: cancellation.aborted ? 'cancelled' : 'preparation_failed', processStopped: true }
  }
  if (cancellation.aborted) return { ...result, outcome: 'cancelled', processStopped: true }
  return superviseJob(plan, ports, cancellation, result)
}

async function superviseJob<Execution extends RuntimeJobExecution>(
  plan: JobLaunchPlan<Execution>,
  ports: JobExecutorPorts<Execution>,
  cancellation: AbortSignal,
  result: JobExecutorResult,
): Promise<JobExecutorResult> {
  const execution = plan.execution
  const spec = execution.acceptedSpec
  const identity = plan.identity
  const claim = await ports.authority.claim(execution, identity)
  if (claim === 'cancelled') return { ...result, outcome: 'cancelled', processStopped: true }
  if (claim === 'reconcile') return { ...result, recoveryRequired: true }
  // From claim onward, lost acknowledgments and spawn failures require identity reconciliation.
  let process: JobSupervisedProcess
  try { process = await ports.supervisor.launch(plan) } catch {
    return { ...result, recoveryRequired: true }
  }
  result.containerId = process.containerId ?? null
  let reason: 'cancelled' | 'timed_out' | 'log_limit' | null = null
  let exitObserved = false
  const exited = process.exited.then(exit => { exitObserved = true; return exit })
  void exited.catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ }) // Result handling below retains transport uncertainty.
  let stopPromise: Promise<boolean> | undefined
  let resolveStopped!: (exit: JobExitEvidence) => void
  let rejectStopped!: (error: Error) => void
  const stoppedWithoutExit = new Promise<JobExitEvidence>((resolve, reject) => { resolveStopped = resolve; rejectStopped = reject })
  void stoppedWithoutExit.catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })
  const stop = (why: NonNullable<typeof reason>) => {
    if (exitObserved && why !== 'log_limit') return
    reason ??= why
    if (!stopPromise) {
      stopPromise = process.stop(spec.policy.cancellationGraceMs).catch(fallbackOnError(
        false, 'jobs', 'stop job process', { executionId: execution.id, operationId: execution.operationId },
      ))
      void stopPromise.then(confirmed => {
        if (confirmed) resolveStopped({ exitCode: null, signal: null })
        else rejectStopped(new Error('Original Job physical stop unconfirmed.'))
      })
    }
  }
  const onCancel = () => stop('cancelled')
  cancellation.addEventListener('abort', onCancel, { once: true })
  const deadline = setTimeout(() => stop('timed_out'), spec.policy.executionTimeoutMs)
  if (cancellation.aborted) onCancel()
  let sequence = 0
  let bytes = 0
  // Serialize the two streams to make persisted sequence assignment authoritative.
  let sink: Promise<void> = Promise.resolve()
  const drain = async (stream: 'stdout' | 'stderr', chunks: AsyncIterable<Uint8Array>) => {
    const decoder = new StringDecoder('utf8')
    const emit = async (text: string) => {
      let part = ''
      let size = 0
      const persist = async () => {
        if (!part) return
        bytes += size
        if (bytes > Math.min(spec.policy.maxLogBytes, Math.floor(spec.policy.maxWorkerSpoolBytes / 2))) {
          result.logsTruncated = true
          if (spec.policy.logOverflow === 'stop') stop('log_limit')
        } else {
          const chunk = { executionId: execution.id, attemptId: execution.attemptId, sequence: ++sequence,
            stream, text: part, byteSize: size, createdAt: new Date().toISOString() }
          sink = sink.then(() => ports.appendLog(chunk))
          await sink
        }
        part = ''; size = 0
      }
      for (const character of text) {
        const length = Buffer.byteLength(character)
        if (size + length > spec.policy.maxLogChunkBytes) await persist()
        part += character; size += length
      }
      await persist()
    }
    try {
      for await (const chunk of chunks) {
        await emit(decoder.write(Buffer.from(chunk)))
      }
      await emit(decoder.end())
    } catch { result.logError = true; stop('log_limit') }
  }
  const drains = Promise.all([drain('stdout', process.stdout), drain('stderr', process.stderr)])
  try {
    try { await ports.authority.launched(execution, identity, process.containerId) } catch { result.recoveryRequired = true }
    const exit = await Promise.race([exited, stoppedWithoutExit])
    result.exitCode = exit.exitCode
    result.signal = exit.signal
    result.processStopped = stopPromise ? await stopPromise : await process.proveStopped().catch(fallbackOnError(
      false, 'jobs', 'verify job process stopped', { executionId: execution.id, operationId: execution.operationId },
    ))
    if (!result.processStopped) {
      result.processStopped = await process.stop(spec.policy.cancellationGraceMs).catch(fallbackOnError(
        false, 'jobs', 'stop job process after exit', { executionId: execution.id, operationId: execution.operationId },
      ))
    }
    let drainDeadline: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([drains, new Promise<never>((_resolve, reject) => {
      drainDeadline = setTimeout(() => reject(new Error('Closed Job output pipes failed to drain.')), spec.policy.cancellationGraceMs + 30000)
    })]) } finally { if (drainDeadline) clearTimeout(drainDeadline) }
    if (!result.processStopped) return { ...result, recoveryRequired: true }
    if (!exitObserved && reason === 'log_limit') return { ...result, recoveryRequired: true }
    result.outcome = reason === 'cancelled' ? 'cancelled' : reason === 'timed_out' || exit.timedOut ? 'timed_out' :
      exit.execError ? 'spawn_failed' : exit.exitCode === 0 ? 'succeeded' : 'build_failed'
    try { await ports.collectOutputs(execution) } catch { result.outputCollectionError = true }
    return result
  } catch { return { ...result, recoveryRequired: true } } finally {
    clearTimeout(deadline)
    cancellation.removeEventListener('abort', onCancel)
  }
}
