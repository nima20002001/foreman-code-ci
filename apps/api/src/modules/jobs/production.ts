import { readPublicProjectionLocked } from '../run-graph/compactSnapshot.js'
import { bootIdentity } from '../harnesses/recovery/linuxIdentity.js'
import { withTransaction } from '../../infrastructure/transaction.js'
import { componentLogger } from '../diagnostics/logger.js'
import { createMainJobExecutionHost } from './mainExecution.js'
import { createQualificationReportPublisher } from './qualificationReports.js'
import { createVerificationSystemInput } from './verificationSystemInput.js'
import { openMainJobJournal } from './mainJobJournal.js'
import { createMainCiRuntime } from './mainCiRuntime.js'
import { jobCleanupOptions } from './lifecycle.js'
import { JobExecutionRecordSchema } from '@foreman-code/contracts/job-verification'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import type { NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { reserveInstalledJobQualification, recoverInstalledJobRuntimeQualifications,
  reconcileInstalledJobRuntimeQualification } from './installedRuntimeQualification.js'
import { createJobQualificationCarrier } from './qualificationCarrier.js'
import { SourceRootRecordSchema, SourceMaterializationRecordSchema } from '@foreman-code/contracts/source-admission'
import type pg from 'pg'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { WorkspaceLocationService } from '../workspaces/location.js'
import { assertDeviceHostInstallation } from '../devices/hostAuthorization.js'
import { DomainError } from '../errors.js'
import { createProductionSources } from '../sources/production.js'
import { createInstalledJobRuntimeHost, type InstalledRuntimeHostDependencies } from './installedRuntimeHost.js'
import { createJobRuntimeProfileService } from './runtimeProfileFactory.js'
import { PostgresJobDispatch } from './dispatch.js'
import { RemoteJobCarrierDispatch } from '../runs/remote/jobCarrierDispatch.js'
import type { RemoteJobExecutionHost } from '../runs/remote/jobExecutionHost.js'
import { CanonicalJobPreparationSources, CanonicalJobPreparationService, CanonicalJobPrivateRepositories } from './sourcePreparation.js'
import type { JobPreparationPort, JobQueueConfiguration } from './ports.js'
import { JobPublicationAuthority } from './authority.js'
import { createCanonicalJobInputPorts } from '../files/jobInputs/factory.js'
import { createMainJobInputRsyncExtension, type MainJobInputRsyncPorts } from '../files/jobInputs/rsyncProduction.js'
import { createAdmittedJobOutputs } from '../files/jobs/admittedFactory.js'
import type { ResumableByteTransferService } from '../byte-transfer/service.js'
import type { MainJobOutputRsyncPorts } from '../files/jobs/rsyncProduction.js'
import type { TrustedJobOutputReader } from '../files/jobs/port.js'
import { JobService, jobDigest } from './service.js'
import { WorkerExecutionPolicy } from '../settings/workerExecution.js'
import { JobWorkerService } from './worker.js'
import { projectJobReceiptLocked } from './receiptProjection.js'
import { publishWorkflowJobReceiptLocked } from './workflowReceiptPublication.js'
import { openRunGraphPublication } from '../run-graph/publication.js'
import { assertGraphTransaction } from '../run-graph/connection.js'
import { readAcceptedRepeatRunLocked } from '../runs/repeatStartRead.js'
import { createWorkflowJobComposition } from './workflowComposition.js'
import { JobApplicationBridge } from '../runs/remote/jobApplicationBridge.js'
import { dirname, join } from 'node:path'
import { PostgresJobCancellationRecovery } from './cancellationRecovery.js'
import { assertBuildComputerTarget, BuildComputerSettings, buildComputerTarget } from '../settings/buildComputers.js'
import { buildComputerReadiness } from '../settings/buildComputerReadiness.js'
import { JobComputerSelection, releaseClosedJobComputers, type VerificationMemoryReader } from './computerSelection.js'
import { JobBuildQueueConfigurationSchema, type JobBuildQueueConfiguration } from '@foreman-code/contracts/job-admission'
import { isAutoJobSpec } from '@foreman-code/contracts/jobs'
import { JobRuntimeProfileSchema } from '@foreman-code/contracts/job-runtime'
import { JobResourceRequestSchema, type JobResourceRequest } from '@foreman-code/contracts/job-verification-policy'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { JobRuntimeMetadataRecovery } from './runtimeMetadataRecovery.js'

export interface ProductionJobInfrastructure {
  installedConfiguration: InstalledRuntimeHostDependencies['configuration']
  reserveQualification?: InstalledRuntimeHostDependencies['reserve']
  localExecution?: RemoteJobExecutionHost
  sourceRemote?: Parameters<typeof createProductionSources>[0]['remote']
  privateRepositoryRemote?: ConstructorParameters<typeof CanonicalJobPrivateRepositories>[3]
  outputReader?: TrustedJobOutputReader
  queueConfiguration?: JobBuildQueueConfiguration
}

/** Passive owner-file read. Missing review/configuration never creates envelopes or enables the queue. */
export async function readBuildQueueConfiguration(path: string): Promise<JobBuildQueueConfiguration | null> {
  let file: Awaited<ReturnType<typeof open>>
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const parent = await lstat(dirname(path))
    const before = await file.stat()
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.()
      || parent.mode & 0o022 || await realpath(dirname(path)) !== dirname(path)
      || !before.isFile() || before.uid !== process.getuid?.() || before.mode & 0o077
      || before.nlink !== 1 || before.size > 65536) {
      throw new DomainError('JOB_QUEUE_CONFIGURATION_UNPROTECTED', 'Build queue configuration requires a private owner file.', 409)
    }
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) throw new DomainError('JOB_QUEUE_CONFIGURATION_CHANGED', 'Build queue configuration changed while reading.', 409)
      offset += read.bytesRead
    }
    const after = await file.stat()
    const named = await lstat(path)
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || named.isSymbolicLink() || named.dev !== after.dev || named.ino !== after.ino) {
      throw new DomainError('JOB_QUEUE_CONFIGURATION_CHANGED', 'Build queue configuration changed while reading.', 409)
    }
    return JobBuildQueueConfigurationSchema.parse(JSON.parse(bytes.toString('utf8')))
  } finally { await file.close() }
}

export function createReviewedBuildQueueConfiguration(
  input: JobBuildQueueConfiguration, mainId: string,
): JobQueueConfiguration {
  const configuration = JobBuildQueueConfigurationSchema.parse(input)
  const { review, ...policy } = configuration
  if (configuration.mainId !== mainId || review.decisionDigest !== jobDigest(policy)) {
    throw new DomainError('JOB_QUEUE_REVIEW_CONFLICT', 'Queue review differs from this Main or its saved configuration.', 409)
  }
  return {
    revision: configuration.revision,
    review: configuration.review,
    limits: configuration.limits,
    async resources(sql, definition) {
      if ('verification' in definition.spec) {
        const resources = definition.spec.verification.resources
        if (!configuration.envelopes.some(envelope => canonicalJson(envelope) === canonicalJson(resources))) {
          throw new DomainError('JOB_QUEUE_ENVELOPE_REVIEW_REQUIRED', 'No reviewed resource envelope covers this verification.', 409)
        }
        return JobResourceRequestSchema.parse(resources)
      }
      let limits: JobResourceRequest['limits']
      if (isAutoJobSpec(definition.spec)) limits = definition.spec.limits
      else {
        const { isolationPolicyId, isolationPolicyRevision } = definition.spec.policy
        const row = (await sql.query<{ record: unknown }>(`select record from job_runtime_profile_versions
          where profile_id=$1 and revision=$2`, [isolationPolicyId, isolationPolicyRevision])).rows[0]
        if (!row) throw new DomainError('JOB_RUNTIME_PROFILE_VERSION_NOT_FOUND', 'The saved build profile version is unavailable.', 409)
        const profile = JobRuntimeProfileSchema.parse(row.record)
        if (profile.id !== isolationPolicyId || profile.revision !== isolationPolicyRevision
          || profile.workspaceId !== definition.workspaceId || canonicalJson(profile.policy) !== canonicalJson(definition.spec.policy)) {
          throw new DomainError('JOB_QUEUE_PROFILE_CONFLICT', 'The saved build profile differs from the definition policy or workspace.', 409)
        }
        limits = profile.limits
      }
      const envelope = configuration.envelopes.find(candidate => canonicalJson(candidate.limits) === canonicalJson(limits))
      if (!envelope) throw new DomainError('JOB_QUEUE_ENVELOPE_REVIEW_REQUIRED', 'No reviewed resource envelope covers this build.', 409)
      return JobResourceRequestSchema.parse(envelope)
    },
  }
}
interface ProductionJobsInput { pool: pg.Pool; commands: PostgresCommandCoordinator;
  locations: WorkspaceLocationService; mainId: string; runtimeRoot: string; storageRoot: string;
  endpoint(): DeviceEndpoint; infrastructure?: ProductionJobInfrastructure;
  workerExecution?: WorkerExecutionPolicy;
  availableMemory?: VerificationMemoryReader;
  activeNativeSession?: NonNullable<Parameters<typeof createProductionSources>[0]['activeNativeSession']>;
  captureNativeSession?: NonNullable<Parameters<typeof createProductionSources>[0]['captureNativeSession']>; nativeRegistry?: NativeProcessRegistry;
  transferAcknowledged?: NonNullable<Parameters<typeof createProductionSources>[0]['transferAcknowledged']>;
  transferPreparationClosed?: NonNullable<Parameters<typeof createProductionSources>[0]['transferPreparationClosed']>;
  transferMaterializationClosed?: NonNullable<Parameters<typeof createProductionSources>[0]['transferMaterializationClosed']>;
  outputRsync?:MainJobOutputRsyncPorts; inputRsync?:MainJobInputRsyncPorts; transferReceiver?:ResumableByteTransferService
}

function createProductionQualificationHost(
  input: Pick<ProductionJobsInput, 'pool' | 'nativeRegistry' | 'mainId' | 'endpoint' | 'infrastructure'>,
  installedConfiguration: InstalledRuntimeHostDependencies['configuration'],
  getMainJournal: () => Promise<RemoteOperationJournal>,
  publishQualificationReport: ReturnType<typeof createQualificationReportPublisher>,
) {
  return createInstalledJobRuntimeHost({ identity: input.pool,
    reconcileQualification: async original => {
      if (!input.nativeRegistry || original.nativeAdmission.hostRef.kind !== 'main') {
        throw new DomainError('JOB_RUNTIME_OWNER_UNAVAILABLE','The original local qualification owner is unavailable.',409)
      }
      await original.assertAdmission()
      const journal = await getMainJournal()
      const receipt = await journal.qualificationStatus(original.nativeAdmission.operationId)
      if (!receipt || !sameWorkflowValue(receipt.admission,original.nativeAdmission)) {
        throw new DomainError('JOB_RUNTIME_RECOVERY_REQUIRED','The original qualification receipt is missing.',409)
      }
      const unavailable = async () => { throw new Error('Reconciliation cannot authorize a new qualification.') }
      return reconcileInstalledJobRuntimeQualification({ candidate: receipt.candidate,admission: receipt.admission,
        journal,registry: input.nativeRegistry,signal: original.signal,
        host: { hostRef: { kind:'main',mainId:input.mainId },registration:null,
          mainInstallationId:input.mainId,bootId:bootIdentity(),connection:null },
        assertAdmission: () => original.assertAdmission(),
        authority: { readApproval: unavailable,assertCurrent: unavailable,reserve: unavailable } })
    },
    publishReport: async (candidate, report, bytes) => {
      const journal = await getMainJournal()
      const assertClosed = async () => {
        const receipt = await journal.qualificationStatus(candidate.operationId)
        const certificates = [receipt?.container?.certificate, ...(receipt?.closedContainers ?? [])]
        if (!receipt || !sameWorkflowValue(receipt.candidate, candidate)
          || !certificates.some(certificate => sameWorkflowValue(certificate, report.closure))) {
          throw new DomainError('JOB_OUTPUT_NOT_QUIESCENT', 'Original diagnostic closure is missing.', 409)
        }
      }
      return publishQualificationReport(candidate, report, bytes, assertClosed)
    },
    configuration: installedConfiguration,
    currentConnection: async (_sql, profile) => profile.root.selection.hostRef.kind === 'device'
      ? input.endpoint().currentBinding(profile.root.selection.hostRef.deviceId) ?? null : null,
    reserve: async original => {
      if (input.infrastructure?.reserveQualification) return input.infrastructure.reserveQualification(original)
      if (!input.nativeRegistry || original.nativeAdmission.hostRef.kind !== 'main') throw new DomainError('JOB_RUNTIME_OWNER_UNAVAILABLE', 'The actual original local diagnostic native owner is unavailable.', 409)
      const journal = await getMainJournal()
      const admission = original.nativeAdmission
      const retained = original.intent === 'reconcile' ? await journal.qualificationStatus(admission.operationId) : null
      if (original.intent === 'reconcile' && !retained) throw new DomainError('JOB_RUNTIME_RECOVERY_REQUIRED',
        'The original qualification receipt is missing; fresh work cannot be launched.', 409)
      return reserveInstalledJobQualification({ candidate: retained?.candidate ?? original.candidate, admission, journal,
        ...(original.intent === 'reconcile' ? { entry: 'reconcile' as const } : {}),
        registry: input.nativeRegistry, signal: original.signal,
        host: { hostRef: admission.hostRef, registration: admission.registration, mainInstallationId: input.mainId, bootId: original.candidate.fingerprint.bootId, connection: null },
        assertAdmission: async supplied => { if (!sameWorkflowValue(supplied, admission)) throw new DomainError('JOB_RUNTIME_NATIVE_ADMISSION_CONFLICT', 'The original local diagnostic admission changed.', 409); await original.assertAdmission() },
        authority: {
          readApproval: async id => { if (id !== admission.approvalId) return null; await original.assertAdmission(); return { status: 'approved', fingerprint: admission.fingerprintDigest, expiresAt: admission.expiresAt } },
          assertCurrent: async candidate => { if (!sameWorkflowValue(candidate, original.candidate)) throw new DomainError('JOB_RUNTIME_NATIVE_ADMISSION_CONFLICT', 'The original local diagnostic candidate changed.', 409); await original.assertAdmission() },
          async reserve() { throw new DomainError('JOB_RUNTIME_OWNER_UNAVAILABLE', 'The original installed diagnostic owner controls reservation.', 409) },
        },
      })
    } })
}

/** Concrete domain services are initialized after the original main identity.
 * Missing installer/host bytes remain unavailable, never a qualified default. */
export async function createProductionJobs(input: ProductionJobsInput) {
  const reviewedQueue = input.infrastructure?.queueConfiguration
    ?? await readBuildQueueConfiguration(join(input.runtimeRoot, 'job-queue.json'))
  const queue = reviewedQueue ? createReviewedBuildQueueConfiguration(reviewedQueue, input.mainId) : undefined
  const requestQueueWake = (): void => { if (queue) jobs.requestQueueWake() }
  const configurationPath = join(input.runtimeRoot, 'job-runtime.json')
  const configured = await lstat(configurationPath).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  const installedConfiguration = input.infrastructure?.installedConfiguration
    ?? (configured ? { path: configurationPath, ownerUid: process.getuid!() } : null)
  const source = await createProductionSources({ ...input, dispatch: () => dispatch,
    ...(installedConfiguration ? { installedJobConfiguration: installedConfiguration } : {}),
    ...(input.infrastructure?.sourceRemote ? { remote: input.infrastructure.sourceRemote } : {}) })
  let qualificationJournal: Promise<RemoteOperationJournal> | undefined
  const journalPath = join(input.runtimeRoot, 'job-runtime-operations.json')
  if (installedConfiguration && input.nativeRegistry) {
    qualificationJournal = openMainJobJournal({ sql: input.pool, path: journalPath, mainId: input.mainId,
      initialization: 'bootstrap' })
    try {
      const journal = await qualificationJournal
      if (input.nativeRegistry) await recoverInstalledJobRuntimeQualifications({ journal, registry: input.nativeRegistry,
        host: { hostRef: { kind: 'main', mainId: input.mainId }, registration: null,
          mainInstallationId: input.mainId, bootId: bootIdentity() } })
    }
    catch (error) {
      componentLogger('jobs').warn({ err: error }, 'Main Job journal requires recovery')
    }
  }
  const getMainJournal = () => {
    qualificationJournal ??= openMainJobJournal({ sql: input.pool, path: journalPath, mainId: input.mainId,
      initialization: 'existing-only' })
    return qualificationJournal
  }
  const localExecution = input.infrastructure?.localExecution
    ?? (installedConfiguration && input.nativeRegistry ? createMainJobExecutionHost({
      pool: input.pool, mainId: input.mainId, runtimeRoot: input.runtimeRoot, storageRoot: input.storageRoot,
      configuration: installedConfiguration, registry: input.nativeRegistry, journal: getMainJournal,
      application: () => application, inputs: () => canonicalInputs.local, publication: () => publication,
    }) : undefined)
  const mainCiLifetime = new AbortController()
  // Main prepares its own CI runtime once it has an installed one, like a paired build computer.
  const mainCiRuntime = installedConfiguration && !input.infrastructure?.installedConfiguration
    ? createMainCiRuntime({ runtimeRoot: input.runtimeRoot, journal: getMainJournal, signal: mainCiLifetime.signal,
      sql: input.pool })
    : undefined
  const publishQualificationReport = createQualificationReportPublisher({ pool: input.pool, storageRoot: input.storageRoot })
  const localHost = createProductionQualificationHost(
    input, installedConfiguration, getMainJournal, publishQualificationReport,
  )
  const qualification = createJobQualificationCarrier({
    pool: input.pool,
    sources: source.sources,
    endpoint: input.endpoint,
    local: localHost,
    publishReport: publishQualificationReport,
    ...(input.workerExecution ? { workerExecution: input.workerExecution } : {}),
  })
  const host = qualification.host
  const metadataRecovery = new JobRuntimeMetadataRecovery(input.pool, host, requestQueueWake)
  const profiles = createJobRuntimeProfileService({ pool: input.pool, commands: input.commands,
    sources: source.sources, host, changed: requestQueueWake })
  const workerExecution = input.workerExecution ?? new WorkerExecutionPolicy()
  const buildComputers = new BuildComputerSettings(input.pool, input.commands, buildComputerReadiness({
    endpoint: input.endpoint, profiles, workerExecution, localExecutor: Boolean(localExecution),
    availableMemory: input.availableMemory,
  }), requestQueueWake)
  const preparationPort: JobPreparationPort = {
    choices: (...args) => preparation.choices(...args), validate: (...args) => preparation.validate(...args),
    accept: (...args) => preparation.accept(...args), revalidateAccepted: (...args) => preparation.revalidateAccepted(...args),
    adoptFinalBinding: (...args) => preparation.adoptFinalBinding(...args),
  }
  const carrier = new RemoteJobCarrierDispatch(input.pool, { request: (deviceId, namespace, payload) => input.endpoint().request(deviceId, namespace, payload) }, localExecution)
  const dispatch: PostgresJobDispatch = new PostgresJobDispatch(input.pool, carrier, {
    prepareWaiting: (): Promise<void> => jobs.wakeQueue(),
    capacityChanged: requestQueueWake,
    refreshRuntime: executionId => metadataRecovery.refreshExecution(executionId),
    revalidate: async (sql, execution, principal, options) => {
      await assertBuildComputerTarget(sql, buildComputerTarget(execution.acceptedSpec.target))
      await preparationPort.revalidateAccepted(sql, principal, execution, options)
    },
    authorizeLaunch: async (sql, execution) => {
      await buildComputers.requireEnabled(sql, buildComputerTarget(execution.acceptedSpec.target))
    },
    authorizeControl: async (sql, execution) => {
      const target = execution.acceptedSpec.target
      const registration = await assertDeviceHostInstallation(sql, target.hostRef,
        target.hostRef.kind === 'main' ? target.hostRef.mainId : target.registration!.workerInstallationId)
      if (registration && (registration.keyRevision !== target.registration?.keyRevision
        || registration.authorizationRevision !== target.registration.authorizationRevision)) {
        throw new DomainError('JOB_CONTROL_HOST_CONFLICT', 'Control requires the original accepted computer authority.', 403)
      }
    },
    async settleSource(executionId) {
      const row = (await input.pool.query<{ record: unknown; state: string }>(
        `select record,state from source_execution_materializations where execution_id=$1`,
        [executionId])).rows[0]
      if (!row) throw new DomainError('SOURCE_ATTEMPT_CONFLICT', 'The original Job source materialization is missing.', 409)
      if (row.state === 'closed' && !input.transferMaterializationClosed) {
        await releaseClosedJobComputers(input.pool)
        return
      }
      const job = (await input.pool.query<{ record: unknown }>(
        'select record from job_executions where id=$1', [executionId])).rows[0]
      const execution = JobExecutionRecordSchema.parse(job?.record)
      const options = execution.schemaVersion === 2 ? jobCleanupOptions(execution) : undefined
      await source.sources.confirmClosed(SourceMaterializationRecordSchema.parse(row.record), options)
      await releaseClosedJobComputers(input.pool)
    },
    async observe(sql, execution, receipt) {
      if (execution.workflow) {
        assertGraphTransaction(sql)
        const snapshot = await readAcceptedRepeatRunLocked(sql, execution.workflow.runId)
        const scope = { runId: snapshot.run.id, workspaceId: snapshot.run.workspaceId, workflowId: snapshot.run.workflowId,
          workflowVersionId: snapshot.version.id, executionSemanticsVersion: 3 as const }
        await publishWorkflowJobReceiptLocked(await openRunGraphPublication(sql, scope, readPublicProjectionLocked), execution, receipt, artifacts)
      } else await projectJobReceiptLocked(sql, execution, receipt, artifacts)
    },
  }, input.workerExecution)
  const canonicalInputs = createCanonicalJobInputPorts({ pool: input.pool, storageRoot: input.storageRoot, runtime: dispatch,
    systemInput: createVerificationSystemInput({ configuration: installedConfiguration, journal: getMainJournal }),
    endpoint: { currentBinding: deviceId => input.endpoint().currentBinding(deviceId) }, receiptRoot: join(input.runtimeRoot, 'job-input-receipts') })
  const inputs = { ...canonicalInputs, extension: createMainJobInputRsyncExtension(canonicalInputs.main, canonicalInputs.extension, input.inputRsync) }
  const privateRepositories = new CanonicalJobPrivateRepositories(input.pool, source.sources, source.executions,
    input.infrastructure?.privateRepositoryRemote ?? { async preparePrivateRepository(principal, record) {
      const manifest = await withTransaction(input.pool, async (sql) => {
        const row = (await sql.query<{ record: unknown }>('select record from source_root_bindings where root_id=$1 and binding_revision=$2 for share',
          [record.receipt.binding.rootId, record.receipt.binding.bindingRevision])).rows[0]
        const root = SourceRootRecordSchema.parse(row?.record)
        return (await source.sources.resolveApprovedSource(sql, principal, record.receipt.binding.workspaceId, root.source)).manifest
      })
      await source.sources.verifyPreparation({ principal, record })
      await source.executions.privateRepository(record, manifest)
    } })
  const preparationSources = new CanonicalJobPreparationSources(source.sources, profiles, privateRepositories,
    { validateDeclaredJobInputs: inputs.validateDeclaredJobInputs }, source.policies)
  const preparation = new CanonicalJobPreparationService(preparationSources)
  const placement = new JobComputerSelection(buildComputers, {
    candidates: async (...args) => {
      const discovery = await preparationSources.candidates(...args)
      const candidates = discovery.candidates.map(candidate => {
        const target = candidate.spec.target.hostRef
        const available = target.kind === 'main' ? Boolean(localExecution)
          : Boolean(input.endpoint().captureRequest(target.deviceId, 'execution-v1'))
        return available ? candidate : { ...candidate, ready: false, reasons: [...candidate.reasons, 'executor_unavailable'] }
      })
      return { ...discovery, candidates }
    },
  }, workerExecution, input.availableMemory, async host => {
    if (host.kind === 'device') await input.endpoint().assertWorkerBundleReady(host.deviceId)
  })
  const publication = new JobPublicationAuthority(dispatch, preparation)
  const outputs = createAdmittedJobOutputs({pool:input.pool,storageRoot:input.storageRoot,stagingRoot:join(input.runtimeRoot,'job-output-transfer-staging'),
    endpoint:{currentBinding:(...args)=>input.endpoint().currentBinding(...args)},authority:publication,
    ...(input.infrastructure?.outputReader?{reader:input.infrastructure.outputReader}:{}),
    ...(input.transferReceiver?{receiver:input.transferReceiver}:{}),...(input.outputRsync?{rsync:input.outputRsync}:{})})
  const artifacts = outputs.artifacts
  const jobs: JobService = new JobService(input.pool, input.commands, {
    placement,
    preparation,
    dispatch,
    artifacts,
    cancellationRecovery: new PostgresJobCancellationRecovery(input.pool, input.commands, dispatch),
    refreshRuntimeMetadata: () => metadataRecovery.request(),
    closePreparation: ticket => source.sources.closeQueuedPreparation(ticket),
    ...(queue ? { queue } : {}),
    ...(input.workerExecution ? { workerExecution: input.workerExecution } : {}),
  })
  const workers = new JobWorkerService(input.pool, { require: dispatch.require.bind(dispatch),
    verifyPublication: (sql, execution) => artifacts.verifyRequiredOutputs(sql, execution) })
  const application = new JobApplicationBridge(input.pool, dispatch, workers, publication)
  const workflow = createWorkflowJobComposition({ jobs, dispatch, outputs: artifacts })
  if (localExecution) {
    try { await localExecution.recover() }
    catch (error) {
      componentLogger('jobs').warn({ err: error }, 'Main Job execution requires reconciliation')
    }
  }
  if (queue) jobs.startQueueRecovery()
  return { ...source, jobs,
    buildComputers, profiles, dispatch, artifacts, outputs, inputs, application, workflow, host, qualificationExtension: qualification.extension,
    queueConfiguration: reviewedQueue,
    requestQueueWake, mainCiRuntime,
    async close() {
      mainCiLifetime.abort()
      const failures: unknown[] = []
      const resources = [async () => { await mainCiRuntime?.close() }, () => jobs.closeQueue(), () => metadataRecovery.close(),
        async () => { await localExecution?.shutdown() }, () => dispatch.close(), () => outputs.close(), () => localHost.shutdown(),
        async () => { if (qualificationJournal) await (await qualificationJournal).close() }]
      for (const close of resources) {
        try {
          await close()
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Job resources could not all close.')
    } }
}
