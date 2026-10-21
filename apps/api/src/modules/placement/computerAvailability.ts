import { DeviceApplicationError, deviceApplicationFailure } from '../devices/deviceApplicationError.js'
import { DeviceConnectionError } from '../devices/deviceWire.js'
import { DomainError } from '../errors.js'

export interface ComputerAvailability {
  reason: string | null
  pending: boolean
}

const connectionReasons: Readonly<Record<string, string>> = {
  backpressure: 'This computer is busy. Retry shortly.',
  DEVICE_BUSY: 'This computer is busy. Retry shortly.',
  unavailable: 'This computer is unavailable. Reconnect it and retry.',
  transport: 'The connection to this computer was interrupted. Reconnect it and retry.',
  timeout: 'This computer did not respond. Retry shortly.',
}
const unavailableCodes = new Set([
  'CI_ENROLLMENT_ROOT_REQUIRED', 'SOURCE_REMOTE_UNAVAILABLE', 'WORKER_EXECUTION_DISABLED',
  'WORKER_VERSION_SKEW', 'WORKER_BUNDLE_UNPUBLISHED', 'WORKER_UPDATING', 'WORKER_STATUS_UNAVAILABLE',
  'SOURCE_CAPACITY', 'SOURCE_CAPACITY_UNAVAILABLE', 'SOURCE_DISK_CAPACITY',
  'ROOT_CONFIGURATION_MISSING', 'ROOT_CONFIGURATION_UNAVAILABLE', 'ROOT_DIRECTORY_MISSING',
  'ROOT_BASE_CHANGED', 'ROOT_RUNTIME_CHANGED', 'SOURCE_ROOT_NOT_PRIVATE', 'SOURCE_ROOT_CHANGED',
  'ROOT_FILESYSTEM_UNSUPPORTED', 'SOURCE_FILESYSTEM_UNSUPPORTED', 'EACCES', 'EPERM', 'ENOENT', 'ENOTDIR',
])

/** Only expected computer availability failures become choices; authority and programming errors still fail the read. */
export function computerAvailabilityFailure(error: unknown): ComputerAvailability | undefined {
  if (error instanceof DomainError) {
    if (Object.hasOwn(connectionReasons, error.code)) return { reason: error.message, pending: true }
    if (unavailableCodes.has(error.code)) {
      return { reason: error.message, pending: ['SOURCE_REMOTE_UNAVAILABLE', 'WORKER_STATUS_UNAVAILABLE'].includes(error.code) }
    }
  }
  if (error instanceof DeviceApplicationError || error instanceof DeviceConnectionError) {
    const failure = deviceApplicationFailure(error)
    const reason = connectionReasons[failure.code]
    if (reason) return { reason, pending: true }
    if (failure.code === 'SOURCE_DISK_CAPACITY') {
      return { reason: 'Workspace storage is full on this computer. Free space and retry.', pending: false }
    }
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    return { reason: connectionReasons.timeout!, pending: true }
  }
  return undefined
}
