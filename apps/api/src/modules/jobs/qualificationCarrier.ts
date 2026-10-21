import { setTimeout as delay } from 'node:timers/promises'
import { withTransaction } from '../../infrastructure/transaction.js'
import type pg from 'pg'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { JOB_RUNTIME_QUALIFICATION_EXTENSION } from '@foreman-code/contracts/job-runtime'
import { JobRuntimeQualificationRpcRequestRecordSchema, JobRuntimeQualificationRpcResponseRecordSchema,
  type JobRuntimeProfileRecord, type JobRuntimeNativeAdmissionRecord, type JobQualificationCandidateRecord }
  from '@foreman-code/contracts/job-verification-runtime'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import type { DeviceExtensionRegistration, DeviceExtensionContext } from '../devices/deviceApplicationChannel.js'
import { assertDeviceHostInstallation } from '../devices/hostAuthorization.js'
import { assertInstalledJobQualification } from './runtimeQualificationAdmission.js'
import type { PostgresSourceService } from '../sources/service.js'
import type { InstalledJobRuntimeHost } from './runtimeProfileFactory.js'
import { DomainError } from '../errors.js'
import { createQualificationReportReceiver } from './qualificationReportReceiver.js'
import { WorkerExecutionPolicy } from '../settings/workerExecution.js'

/** Main retains only a response from the exact authenticated installed worker.
 * Passive/native IO stays outside admission SQL; SQL readback uses this capture. */
export function createJobQualificationCarrier(input: { pool: pg.Pool; sources: PostgresSourceService;
  endpoint(): DeviceEndpoint; local: InstalledJobRuntimeHost;
  publishReport?: ReturnType<typeof import('./qualificationReports.js').createQualificationReportPublisher>; workerExecution?: WorkerExecutionPolicy }) {
  const reportReceiver = input.publishReport ? createQualificationReportReceiver(input.publishReport) : null
  const workerExecution = input.workerExecution ?? new WorkerExecutionPolicy()
  const snapshots = new Map<string, {
    response: Extract<ReturnType<typeof JobRuntimeQualificationRpcResponseRecordSchema.parse>, { operation: 'inspect' }>
    binding: NonNullable<ReturnType<DeviceEndpoint['currentBinding']>>
  }>()
  const inspections = new Map<string, symbol>()
  const key = (profile: JobRuntimeProfileRecord) => `${profile.id}:${profile.revision}`
  const exchange = async (profile: JobRuntimeProfileRecord, payload: unknown, signal?: AbortSignal) => {
    const target = profile.root.selection.hostRef
    const request = JobRuntimeQualificationRpcRequestRecordSchema.parse(payload)
    if (request.operation === 'run' || request.operation === 'start') workerExecution.requireEnabled(target)
    if (target.kind !== 'device' || !profile.root.registration) throw new DomainError('JOB_RUNTIME_HOST_MISMATCH', 'The real installed worker is required.', 409)
    const endpoint = input.endpoint(), captured = endpoint.captureRequest(target.deviceId, JOB_RUNTIME_QUALIFICATION_EXTENSION.namespace)
    const check = () => {
      signal?.throwIfAborted()
      const current = endpoint.currentBinding(target.deviceId)
      if (!captured || !current || !sameWorkflowValue(current, captured.binding)
        || current.mainId !== target.mainId || current.workerInstallationId !== profile.root.registration?.workerInstallationId
        || current.keyRevision !== profile.root.registration?.keyRevision || current.authorizationRevision !== profile.root.registration?.authorizationRevision)
        throw new DomainError('JOB_RUNTIME_CONNECTION_CHANGED', 'The original installed qualification connection is unavailable or changed.', 409)
    }
    check()
    const reply = await captured!.request(JobRuntimeQualificationRpcRequestRecordSchema.parse(payload), signal ? { signal, timeoutMs: 30000 } : { timeoutMs: 30000 })
    check()
    if (reply.bytes !== undefined) throw new DomainError('JOB_RUNTIME_RESPONSE_INVALID', 'Physical qualification metadata cannot contain arbitrary binary data.', 409)
    return { response: JobRuntimeQualificationRpcResponseRecordSchema.parse(reply.payload), binding: captured!.binding }
  }
  const inspect = async (profile: JobRuntimeProfileRecord) => {
    // A fresh inspection supersedes the cached snapshot, including when it fails.
    const profileKey = key(profile)
    const inspection = Symbol()
    inspections.set(profileKey, inspection)
    snapshots.delete(profileKey)
    const { response, binding } = await exchange(profile, { version: profile.schemaVersion === 2 ? 3 : 1, operation: 'inspect', profile })
    if (response.operation !== 'inspect' || response.fingerprint.profileId !== profile.id || response.fingerprint.profileRevision !== profile.revision
      || response.fingerprint.specDigest !== profile.specDigest || response.fingerprint.bootId !== binding.bootId
      || !sameWorkflowValue(response.fingerprint.root, profile.root) || !sameWorkflowValue(response.fingerprint.hostRef, profile.root.selection.hostRef)
      || !sameWorkflowValue(response.fingerprint.registration, profile.root.registration)
      || !sameWorkflowValue(response.descriptor.target.hostRef, response.fingerprint.hostRef)
      || !sameWorkflowValue(response.descriptor.target.registration, response.fingerprint.registration)
      || response.descriptor.target.mainInstallationId !== binding.mainId) throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED', 'The actual installed worker returned another qualification context.', 409)
    if (inspections.get(profileKey) !== inspection) {
      throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED', 'A newer runtime inspection superseded this response.', 409)
    }
    snapshots.set(profileKey, { response, binding })
    return response
  }
  const host: InstalledJobRuntimeHost = {
    clockReason: profile => profile.root.selection.hostRef.kind === 'device'
      ? input.endpoint().clockReason(profile.root.selection.hostRef.deviceId) : null,
    ...(input.local.reconcileQualification
      ? { reconcileQualification: input.local.reconcileQualification.bind(input.local) } : {}),
    capture: async profile => {
      if (profile.root.selection.hostRef.kind !== 'main') return (await inspect(profile)).fingerprint
      if (input.local.capture) return input.local.capture(profile)
      await input.local.descriptor(profile)
      const fingerprint = await input.local.currentMetadata(input.pool, profile)
      if (!fingerprint) throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED', 'The actual protected Main runtime capture is unavailable.', 409)
      return fingerprint
    },
    descriptor: async profile => profile.root.selection.hostRef.kind === 'main' ? input.local.descriptor(profile) : (await inspect(profile)).descriptor,
    currentConnection: async (sql, profile) => {
      const target = profile.root.selection.hostRef
      if (target.kind === 'main') return null
      const binding = input.endpoint().currentBinding(target.deviceId)
      if (input.endpoint().clockReason(target.deviceId)) return null
      const registration = await assertDeviceHostInstallation(sql, target, profile.root.registration?.workerInstallationId ?? '')
      if (!binding || !registration || !sameWorkflowValue({ workerInstallationId: registration.workerInstallationId, keyRevision: registration.keyRevision, authorizationRevision: registration.authorizationRevision }, profile.root.registration)
        || binding.mainId !== target.mainId || binding.workerInstallationId !== registration.workerInstallationId
        || binding.keyRevision !== registration.keyRevision || binding.authorizationRevision !== registration.authorizationRevision) return null
      return binding
    },
    currentMetadata: async (sql, profile) => {
      if (profile.root.selection.hostRef.kind === 'main') return input.local.currentMetadata(sql, profile)
      const snapshot = snapshots.get(key(profile)), binding = await host.currentConnection(sql, profile)
      return snapshot && binding && sameWorkflowValue(snapshot.binding, binding)
        && snapshot.response.fingerprint.specDigest === profile.specDigest
        && sameWorkflowValue(snapshot.response.fingerprint.root, profile.root)
        ? snapshot.response.fingerprint : null
    },
    reserveQualification: request => input.local.reserveQualification(request),
    runAdmitted: async request => {
      if (request.profile.root.selection.hostRef.kind === 'main') {
        if (!input.local.runAdmitted) {
          throw new DomainError('JOB_RUNTIME_UNAVAILABLE', 'Installed Main qualification is unavailable.', 503)
        }
        return input.local.runAdmitted(request)
      }
      await request.assertAdmission()
      const version = request.nativeAdmission.schemaVersion
      let operation: 'start' | 'status' = 'status'
      let candidate = request.candidate
      let capturedCandidate = false
      while (request.intent === 'reconcile' || Date.now() < Date.parse(request.nativeAdmission.expiresAt)) {
        request.signal.throwIfAborted()
        const { response } = await exchange(request.profile, { version, operation,
          admission: request.nativeAdmission, candidate, intent: request.intent ?? 'execute' }, request.signal)
        if ((response.operation !== 'start' && response.operation !== 'status')
          || !sameWorkflowValue(response.admission, request.nativeAdmission)
          || !sameWorkflowValue(response.candidate.fingerprint, request.candidate.fingerprint)
          || capturedCandidate && !sameWorkflowValue(response.candidate, candidate)) {
          throw new DomainError('JOB_RUNTIME_NATIVE_ADMISSION_CONFLICT', 'Worker qualification changed its persisted admission.', 409)
        }
        candidate = response.candidate
        capturedCandidate = response.phase !== 'not_started'
        if (response.phase === 'not_started' && request.intent === 'reconcile') {
          return { outcome: 'denied', closure: 'unconfirmed', reasons: ['Original worker qualification receipt is missing.'] }
        }
        if (response.phase === 'complete' && response.result) {
          await request.assertAdmission()
          return response.result
        }
        operation = 'status'
        if (request.intent !== 'reconcile' && ['not_started', 'received'].includes(response.phase)) {
          operation = 'start'
        }
        await delay(1000, undefined, { signal: request.signal })
      }
      throw new DomainError('JOB_RUNTIME_APPROVAL_EXPIRED', 'The original qualification deadline expired.', 409)

    },
  }
  const authorize = async (admission: JobRuntimeNativeAdmissionRecord, candidate: JobQualificationCandidateRecord, context: DeviceExtensionContext) => {
    context.signal.throwIfAborted()
    if (!admission.connection || !sameWorkflowValue(admission.connection, context.binding)
      || !sameWorkflowValue(input.endpoint().currentBinding(context.binding.deviceId), context.binding))
      throw new DomainError('JOB_RUNTIME_NATIVE_ADMISSION_CONFLICT', 'Diagnostic admission is not on its original authenticated worker channel.', 403)
    await withTransaction(input.pool, async (sql) => {
      await assertInstalledJobQualification(sql, { candidate, runCommandId: admission.runCommandId, runPrincipalId: admission.runPrincipalId,
        resolveRoot: (sql, profile, principal) => input.sources.resolveRootBinding(sql, principal, { workspaceId: profile.workspaceId,
          rootId: profile.root.binding.rootId, bindingRevision: profile.root.binding.bindingRevision, source: profile.root.source }),
        readCurrent: async (sql, profile) => {
          const fingerprint = await host.currentMetadata(sql, profile)
          if (!fingerprint) throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED', 'The original captured installed runtime is unavailable.', 409)
          return { fingerprint, connection: await host.currentConnection(sql, profile) }
        },
      }, admission)
      context.signal.throwIfAborted()
      if (!sameWorkflowValue(input.endpoint().currentBinding(context.binding.deviceId), context.binding)) throw new DomainError('JOB_RUNTIME_CONNECTION_CHANGED', 'The actual original qualification connection changed before commit.', 409)
    })
  }
  const extension: DeviceExtensionRegistration = { ...JOB_RUNTIME_QUALIFICATION_EXTENSION, role: 'duplex', async handle(raw, context) {
    const request = JobRuntimeQualificationRpcRequestRecordSchema.parse(raw)
    if (request.operation === 'publish-report') {
      if (!reportReceiver || context.bytes === undefined) throw new Error('Canonical diagnostic publication is unavailable.')
      await authorize(request.admission, request.candidate, context)
      if (!sameWorkflowValue(request.report.closure.scope.admission, request.admission)) {
        throw new DomainError('JOB_RUNTIME_NATIVE_ADMISSION_CONFLICT', 'Report closure belongs to another admission.', 403)
      }
      const published = await reportReceiver(request.candidate, request.report, request.offset, context.bytes,
        () => authorize(request.admission, request.candidate, context))
      return { payload: JobRuntimeQualificationRpcResponseRecordSchema.parse({ version: 3, operation: 'publish-report', ...published }) }
    }
    if (context.bytes !== undefined || request.operation !== 'authorize') throw new DomainError('JOB_RUNTIME_REQUEST_INVALID', 'Main serves actual diagnostic authority only.', 403)
    await authorize(request.admission, request.candidate, context)
    return { payload: JobRuntimeQualificationRpcResponseRecordSchema.parse({ version: request.version, operation: 'authorize', admission: request.admission, candidate: request.candidate,
      approval: { status: 'approved', fingerprint: request.admission.fingerprintDigest, expiresAt: request.admission.expiresAt } }) }
  } }
  return { host, extension }
}
