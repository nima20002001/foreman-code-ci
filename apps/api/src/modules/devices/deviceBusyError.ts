import type { DeviceBusyDetails } from '@foreman-code/contracts/device-application'
import { DomainError } from '../errors.js'
import { DeviceApplicationAdmissionError, DeviceApplicationError } from './deviceApplicationError.js'
import { DeviceConnectionError } from './deviceWire.js'

/** Public availability error; callers retain their operation's idempotency rules. */
export function deviceBusyFailure(error: unknown): unknown {
  if (error instanceof DomainError) return error
  if (!(error instanceof DeviceApplicationError || error instanceof DeviceConnectionError)
    || !['backpressure', 'DEVICE_BUSY'].includes(error.code)) return error
  const details: DeviceBusyDetails = {
    retryable: true,
    reason: error instanceof DeviceApplicationAdmissionError ? error.reason : 'backpressure',
  }
  const failure = new DomainError('DEVICE_BUSY', 'The device is busy. Retry the request shortly.', 503, { ...details })
  failure.cause = error
  return failure
}

export function deviceBackpressured(error: unknown): boolean {
  if (error instanceof AggregateError) return error.errors.some(deviceBackpressured)
  const failure = deviceBusyFailure(error)
  return failure instanceof DomainError && failure.code === 'DEVICE_BUSY'
}
