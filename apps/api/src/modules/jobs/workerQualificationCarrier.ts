import { isDeepStrictEqual } from 'node:util'
import { JOB_RUNTIME_QUALIFICATION_EXTENSION } from '@foreman-code/contracts/job-runtime'
import { JobRuntimeQualificationRpcRequestRecordSchema, JobRuntimeQualificationRpcResponseRecordSchema, JobVerificationQualificationCandidateSchema,
  type JobRuntimeNativeAdmissionRecord, type JobQualificationCandidateRecord }
  from '@foreman-code/contracts/job-verification-runtime'
import type { DeviceExtensionRegistration } from '../devices/deviceApplicationChannel.js'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { WorkerPairingConfiguration } from '@foreman-code/contracts/device-identity'
import { inspectInstalledJobRuntime, type InstalledRuntimeConfigurationLocation } from './installedRuntimeHost.js'
import { runInstalledJobRuntimeQualification, reconcileInstalledJobRuntimeQualification } from './installedRuntimeQualification.js'
import type { NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
import type { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { componentLogger } from '../diagnostics/logger.js'
import { DomainError } from '../errors.js'

/** All diagnostic processes and OCI objects stay on this original installed
 * worker. Only Main's exact persisted diagnostic admission authorizes entry. */
export function createWorkerQualificationExtension(input: {
  configuration: InstalledRuntimeConfigurationLocation
  pairing: WorkerPairingConfiguration; bootId: string
  currentBinding(): Readonly<DeviceSessionBinding>
  now(): number
  request(namespace: string, payload: unknown, options?: { signal?: AbortSignal; bytes?: Uint8Array; timeoutMs?: number }): Promise<{ payload: unknown; bytes?: Uint8Array }>
  journal(): Promise<RemoteOperationJournal>; registry: NativeProcessRegistry
  signal: AbortSignal
}): DeviceExtensionRegistration & { drain(): Promise<void> } {
  const active = new Map<string, Promise<void>>()
  const observed = () => {
    input.signal.throwIfAborted()
    const connection = input.currentBinding()
    if (connection.mainId !== input.pairing.mainId || connection.deviceId !== input.pairing.deviceId
      || connection.workerInstallationId !== input.pairing.workerInstallationId || connection.keyRevision !== input.pairing.keyRevision
      || connection.authorizationRevision !== input.pairing.authorizationRevision || connection.bootId !== input.bootId)
      throw new DomainError('JOB_RUNTIME_CONNECTION_CHANGED', 'The actual original installed diagnostic host changed.', 409)
    return { hostRef: { kind: 'device' as const, mainId: connection.mainId, deviceId: connection.deviceId },
      registration: { workerInstallationId: connection.workerInstallationId, keyRevision: connection.keyRevision, authorizationRevision: connection.authorizationRevision },
      mainInstallationId: connection.mainId, bootId: connection.bootId, connection }
  }
  const extension: DeviceExtensionRegistration = { ...JOB_RUNTIME_QUALIFICATION_EXTENSION, role: 'duplex', async handle(raw, context) {
    const request = JobRuntimeQualificationRpcRequestRecordSchema.parse(raw), host = observed()
    if (context.bytes !== undefined || !isDeepStrictEqual(host.connection, context.binding)) throw new DomainError('JOB_RUNTIME_CONNECTION_CHANGED', 'The diagnostic request is not on the original actual Main channel.', 403)
    let signal = AbortSignal.any([input.signal, context.signal])
    if (request.operation === 'inspect') {
      const inspected = await inspectInstalledJobRuntime({ configuration: input.configuration, profile: request.profile, host })
      if (!isDeepStrictEqual(observed(), host)) throw new DomainError('JOB_RUNTIME_CONNECTION_CHANGED', 'The installed diagnostic host changed during capture.', 409)
      return { payload: JobRuntimeQualificationRpcResponseRecordSchema.parse({ version: request.version, operation: 'inspect', ...inspected }) }
    }
    if (request.operation === 'publish-report' || request.operation === 'authorize') throw new DomainError('JOB_RUNTIME_NATIVE_ADMISSION_CONFLICT', 'The genuine persisted diagnostic admission is required.', 403)
    const journal = await input.journal()
    const prior = await journal.qualificationStatus(request.admission.operationId)
    if (prior && (!isDeepStrictEqual(prior.admission, request.admission)
      || !isDeepStrictEqual(prior.candidate.fingerprint, request.candidate.fingerprint)
      || request.operation !== 'status' && !isDeepStrictEqual(prior.candidate, request.candidate))) {
      throw new DomainError('JOB_RUNTIME_NATIVE_ADMISSION_CONFLICT', 'Original qualification receipt changed.', 409)
    }
    if (!isDeepStrictEqual(request.admission.hostRef, host.hostRef)
      || !isDeepStrictEqual(request.admission.registration, host.registration)
      || request.admission.bootId !== host.bootId || request.admission.mainInstallationId !== host.mainInstallationId) {
      throw new DomainError('JOB_RUNTIME_NATIVE_ADMISSION_CONFLICT', 'Original qualification host changed.', 403)
    }
    const candidate = prior?.candidate ?? request.candidate
    const retainedCandidate = candidate
    const assertAdmission = async (admission: JobRuntimeNativeAdmissionRecord, submittedCandidate: JobQualificationCandidateRecord = retainedCandidate) => {
      signal.throwIfAborted()
      if (!isDeepStrictEqual(observed(), host) || !isDeepStrictEqual(admission, request.admission) || !isDeepStrictEqual(submittedCandidate, retainedCandidate))
        throw new DomainError('JOB_RUNTIME_NATIVE_ADMISSION_CONFLICT', 'The original diagnostic admission changed.', 403)
      const reply = await input.request(JOB_RUNTIME_QUALIFICATION_EXTENSION.namespace, { version: request.version, operation: 'authorize', admission, candidate: submittedCandidate }, { signal })
      const approved = JobRuntimeQualificationRpcResponseRecordSchema.parse(reply.payload)
      if (reply.bytes !== undefined || approved.operation !== 'authorize' || !isDeepStrictEqual(approved.admission, admission)
        || !isDeepStrictEqual(approved.candidate, submittedCandidate) || approved.approval.fingerprint !== admission.fingerprintDigest
        || approved.approval.expiresAt !== admission.expiresAt || !isDeepStrictEqual(observed(), host))
        throw new DomainError('JOB_RUNTIME_NATIVE_ADMISSION_CONFLICT', 'The original Main did not authorize this actual diagnostic.', 403)
      return approved.approval
    }
    const fresh = !prior || prior.phase === 'received'
    if (fresh && request.operation !== 'status') await assertAdmission(request.admission)
    const publishReport: import('./qualificationReports.js').QualificationReportPublisher = async (submitted, report, bytes) => {
      const receipt = await journal.qualificationStatus(submitted.operationId)
      const certificates = [receipt?.container?.certificate, ...(receipt?.closedContainers ?? [])]
      if (!isDeepStrictEqual(submitted, candidate)
        || !certificates.some(certificate => isDeepStrictEqual(certificate, report.closure))) {
        throw new Error('Original diagnostic closure is missing.')
      }
      for (let offset = 0; offset < bytes.byteLength;) {
        const chunk = bytes.subarray(offset, Math.min(offset + 1048576, bytes.byteLength))
        const reply = await input.request(JOB_RUNTIME_QUALIFICATION_EXTENSION.namespace, {
          version: 3, operation: 'publish-report', admission: request.admission, candidate, report, offset,
        }, { bytes: chunk, signal, timeoutMs: candidate.fingerprint.schemaVersion === 3
          ? JobVerificationQualificationCandidateSchema.parse(candidate).profile.spec.policy.publicationTimeoutMs : 30000 })
        const response = JobRuntimeQualificationRpcResponseRecordSchema.parse(reply.payload)
        if (response.operation !== 'publish-report' || reply.bytes !== undefined
          || response.receivedBytes !== offset + chunk.byteLength || !isDeepStrictEqual(observed(), host)) {
          throw new Error('Canonical diagnostic publication response changed.')
        }
        offset = response.receivedBytes
        if (offset === bytes.byteLength && response.artifact) return response.artifact
        if (response.artifact) throw new Error('Diagnostic artifact completed before all bytes were transferred.')
      }
      throw new Error('Canonical diagnostic publication did not return its retained artifact.')
    }
    const recovering = (request.operation === 'start' || request.operation === 'status')
      && request.intent === 'reconcile'
    const timeoutMs = recovering ? 240_000 : Math.max(1, Date.parse(request.admission.expiresAt) - input.now())
    const reservation = { publishReport, now: input.now, configuration: input.configuration, admission: request.admission,
      candidate, host: { ...host, connection: request.admission.connection }, journal, registry: input.registry,
      signal: AbortSignal.any([input.signal, context.connectionSignal ?? input.signal, AbortSignal.timeout(timeoutMs)]),
      assertAdmission: (admission: JobRuntimeNativeAdmissionRecord) => assertAdmission(admission).then(() => undefined),
      authority: {
        readApproval: async (id: string) => id === request.admission.approvalId ? assertAdmission(request.admission) : null,
        assertCurrent: (candidate: JobQualificationCandidateRecord) => assertAdmission(request.admission, candidate).then(() => undefined),
        async reserve() { throw new DomainError('JOB_RUNTIME_NATIVE_ADMISSION_CONFLICT', 'Native reservation must use the actual installed qualification owner.', 409) },
      },
    }
    if (request.operation === 'start' || request.operation === 'status') {
      if (request.intent === 'reconcile' && !prior) return { payload: JobRuntimeQualificationRpcResponseRecordSchema.parse({
        version: request.version, operation: request.operation, admission: request.admission, candidate,
        phase: 'not_started', result: null }) }
      const operationId = request.admission.operationId
      if (!active.has(operationId) && (request.operation === 'start'
        || prior && (prior.phase !== 'received' || request.intent === 'reconcile'))) {
        signal = reservation.signal
        const task = (async () => {
          try {
            if (!prior) await journal.qualificationAccept(request.admission, candidate)
            if (fresh && request.intent !== 'reconcile') await runInstalledJobRuntimeQualification(reservation)
            else await reconcileInstalledJobRuntimeQualification(reservation)
          } catch (error) {
            componentLogger('jobs').error({ err: error, operationId }, 'Qualification requires original-owner reconciliation')
          } finally { active.delete(operationId) }
        })()
        active.set(operationId, task)
      }
      const receipt = await journal.qualificationStatus(operationId)
      if (!receipt) return { payload: JobRuntimeQualificationRpcResponseRecordSchema.parse({ version: request.version,
        operation: request.operation, admission: request.admission, candidate, phase: 'not_started', result: null }) }
      const result = receipt.phase === 'closed' ? receipt.result : null
      let phase = 'received'
      if (active.has(operationId)) phase = 'running'
      if (result) phase = 'complete'
      return { payload: JobRuntimeQualificationRpcResponseRecordSchema.parse({ version: request.version,
        operation: request.operation, admission: request.admission, candidate,
        phase, result }) }
    }
    const result = await runInstalledJobRuntimeQualification(reservation)
    if (!isDeepStrictEqual(observed(), host)) throw new DomainError('JOB_RUNTIME_CONNECTION_CHANGED', 'The original measured diagnostic host changed.', 409)
    return { payload: JobRuntimeQualificationRpcResponseRecordSchema.parse({ version: request.version, operation: 'run', admission: request.admission, candidate, result }) }
  } }
  return { ...extension, async drain() { await Promise.allSettled([...active.values()]) } }
}
