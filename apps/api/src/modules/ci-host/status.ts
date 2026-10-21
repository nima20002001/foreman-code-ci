import { CI_HOST_NAMESPACE, CiHostStatusSchema, type CiHostStatus } from '@foreman-code/contracts'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import { DomainError } from '../errors.js'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { DeviceApplicationAdmissionError } from '../devices/deviceApplicationError.js'

const lastStatus = new Map<string, CiHostStatus>()

/** Every status read records the Worker's answer. A background read that yields to foreground Worker work reports
 * that last answer: the Worker is busy, not unavailable. Starts still verify readiness with a foreground status. */
export async function retainCiHostStatus(hostRef: object,
  read: () => Promise<CiHostStatus>): Promise<CiHostStatus> {
  const key = canonicalJson(hostRef)
  try {
    const status = await read()
    lastStatus.set(key, status)
    return status
  } catch (error) {
    const retained = lastStatus.get(key)
    if (retained && error instanceof DeviceApplicationAdmissionError && error.reason === 'background_yield') return retained
    throw error
  }
}

export async function readHostCiStatus(endpoint: DeviceEndpoint,
  target: DeviceProvisioningTarget, buildAllowancePercent?: number): Promise<CiHostStatus | null> {
  if (target.hostRef.kind !== 'device') return null
  const deviceId = target.hostRef.deviceId
  const channel = endpoint.captureRequest(deviceId, CI_HOST_NAMESPACE)
  if (!channel) return null
  const matches = () => channel.binding.workerInstallationId === target.applicationInstallationId
    && channel.binding.keyRevision === target.keyRevision
    && channel.binding.authorizationRevision === target.authorizationRevision
    && canonicalJson(channel.binding) === canonicalJson(endpoint.currentBinding(deviceId))
  if (!matches()) throw new DomainError('CI_ENROLLMENT_OFFLINE', 'The computer connection changed.', 409)
  return retainCiHostStatus({ ...target.hostRef, buildAllowancePercent }, async () => {
    const result = await channel.request({ operation: 'status',
      ...(buildAllowancePercent === undefined ? {} : { buildAllowancePercent }) }, { timeoutMs: 30_000 })
    if (!matches()) throw new DomainError('CI_ENROLLMENT_OFFLINE', 'The computer connection changed.', 409)
    return CiHostStatusSchema.parse(result.payload)
  })
}
