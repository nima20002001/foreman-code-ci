import { DeviceApplicationError } from '../devices/deviceApplicationError.js'
import { DeviceConnectionError } from '../devices/deviceWire.js'
import { DomainError } from '../errors.js'

export function temporaryCiConnectionError(error: unknown): boolean {
  if (error instanceof DeviceApplicationError) return error.retryable
  if (error instanceof DeviceConnectionError) return ['transport', 'timeout', 'backpressure'].includes(error.code)
  return error instanceof DomainError && error.code === 'COMPUTER_OFFLINE'
}
