import { CI_HOST_NAMESPACE } from '@foreman-code/contracts'
import { JobRuntimeProfileRecordSchema } from '@foreman-code/contracts/job-verification-runtime'
import type { BuildComputerStatus } from '@foreman-code/contracts/build-computers'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { sameDeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { JobSql } from '../jobs/repository.js'
import type { JobRuntimeProfiles } from '../jobs/runtimeProfiles.js'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import { buildComputerTarget } from './buildComputers.js'
import { jobComputerCapacityDecision, type VerificationMemoryReader } from '../jobs/computerSelection.js'
import type { WorkerExecutionPolicy } from './workerExecution.js'
import { DomainError } from '../errors.js'
import { hostCiCapacity } from '../ci-host/capacity.js'
import { readHostCiStatus } from '../ci-host/status.js'
import { workerBundleErrorMessage } from '../computers/workerBundleReadiness.js'

export function buildComputerReadiness(input: { endpoint(): DeviceEndpoint; profiles: JobRuntimeProfiles;
  workerExecution: WorkerExecutionPolicy; localExecutor: boolean; availableMemory?: VerificationMemoryReader | undefined }) {
  return async (sql: JobSql, target: DeviceProvisioningTarget, allowancePercent: number): Promise<
    Pick<BuildComputerStatus, 'state' | 'reasons' | 'remoteExecutionEnabled'>> => {
    let remoteExecutionEnabled = true
    try { input.workerExecution.requireEnabled({ kind: 'device' }) } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'WORKER_EXECUTION_DISABLED') throw error
      remoteExecutionEnabled = false
    }
    const result = (state: BuildComputerStatus['state'], reasons: string[]) => ({ state, reasons, remoteExecutionEnabled })
    if (target.hostRef.kind === 'device') {
      const binding = input.endpoint().currentBinding(target.hostRef.deviceId)
      if (!binding || binding.workerInstallationId !== target.applicationInstallationId
        || binding.keyRevision !== target.keyRevision || binding.authorizationRevision !== target.authorizationRevision) {
        return result('offline', ['Computer is offline.'])
      }
      if (!remoteExecutionEnabled) return result('setup-required', ['Remote execution disabled on Main.'])
      const clockReason = input.endpoint().clockReason(target.hostRef.deviceId)
      if (clockReason) return result('setup-required', [clockReason])
      const bundle = await input.endpoint().workerBundleReadiness(target.hostRef.deviceId)
      if (!bundle.ready) return result('setup-required', [workerBundleErrorMessage(bundle)])
      const hostCi = input.endpoint().capabilities(target.hostRef.deviceId)
        .some(value => value.namespace === CI_HOST_NAMESPACE && value.mainCanRequest)
      if (hostCi) {
        const status = await readHostCiStatus(input.endpoint(), target, allowancePercent)
        if (!status) return result('offline', ['Host CI is unavailable on this connection.'])
        if (!status.ready) return result('setup-required', status.reasons)
        if (status.slotsTotal === 0) {
          const idleCapacity = hostCiCapacity({ ...status, availableMemoryBytes: status.memoryBytes })
          if (idleCapacity.slotsTotal === 0) {
            return result('setup-required', ['The build allowance is too small for Host CI. Increase the allowance.'])
          }
          return result('busy', ['More available memory is required before another build can start.'])
        }
        if (status.slotsTotal !== undefined && (status.slotsUsed ?? 0) >= status.slotsTotal) {
          return result('busy', ['Build capacity is reserved.'])
        }
        return result('ready', [])
      }
      if (!input.endpoint().captureRequest(target.hostRef.deviceId, 'execution-v1')) {
        return result('setup-required', ['Job execution is unavailable on this connection.'])
      }
    } else if (!input.localExecutor) return result('setup-required', ['Job execution is not installed on Main.'])
    const profiles = (await sql.query<{ record: unknown }>(
      'select record from job_runtime_profiles order by id',
    )).rows.map(row => JobRuntimeProfileRecordSchema.parse(row.record)).filter(profile => sameDeviceProvisioningTarget(
      buildComputerTarget({ hostRef: profile.root.selection.hostRef, registration: profile.root.registration,
        mainInstallationId: profile.root.binding.mainId }), target,
    ))
    const readyProfiles = []
    for (const profile of profiles) if ((await input.profiles.readiness(sql, profile)).ready) readyProfiles.push(profile)
    if (!readyProfiles.length) return result('setup-required', ['Approve a writable workspace root and qualify a CI runtime.'])
    const failures: string[] = []
    let waitingForCapacity = false
    for (const profile of readyProfiles) {
      const decision = await jobComputerCapacityDecision(sql,
        { mainId: target.hostRef.mainId, hostRef: target.hostRef }, profile, input.availableMemory, allowancePercent)
      if (decision.fits) {
        return result('ready', [])
      }
      if (decision.reason === 'busy') {
        waitingForCapacity = true
        failures.push('Build capacity is reserved.')
      } else if (decision.reason === 'memory_headroom_required') {
        waitingForCapacity = true
        failures.push('More available memory is required before another build can start.')
      } else if (decision.reason === 'memory_unavailable') {
        failures.push('Available memory could not be read.')
      } else {
        failures.push('The build allowance is too small for this runtime. Increase the allowance.')
      }
    }
    return result(waitingForCapacity ? 'busy' : 'setup-required', [...new Set(failures)])
  }
}
