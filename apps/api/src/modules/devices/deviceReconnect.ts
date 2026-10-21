import type { DeviceConnectionIdentity } from '@foreman-code/contracts/device-identity'
import { DomainError } from '../errors.js'
import { deviceRequestTimeoutMs, waitForDeviceRetry } from './deviceRequestRetry.js'
import { DeviceConnectionError } from './deviceWire.js'

/** Allow Worker and Main reconciliation plus connection setup and backoff for the same Worker boot. */
export const deviceReconnectTimeoutMs = 2 * deviceRequestTimeoutMs + 30_000

type DeviceInstallation = Pick<DeviceConnectionIdentity,
  'mainId' | 'deviceId' | 'workerInstallationId' | 'keyRevision' | 'authorizationRevision' | 'bootId'>

/** The same paired Worker process: only the transport session (epoch and generation) may differ. */
export function sameDeviceInstallation(a: DeviceInstallation, b: DeviceInstallation): boolean {
  return a.mainId === b.mainId && a.deviceId === b.deviceId && a.workerInstallationId === b.workerInstallationId
    && a.keyRevision === b.keyRevision && a.authorizationRevision === b.authorizationRevision && a.bootId === b.bootId
}

/** A lost or unusable link, as opposed to a refusal by the peer or a domain failure. */
export function isDeviceLinkDrop(error: unknown): boolean {
  if (error instanceof DeviceConnectionError) return ['transport', 'timeout', 'backpressure', 'malformed-frame'].includes(error.code)
  return error instanceof DomainError && error.code === 'REMOTE_DISPATCH_UNAVAILABLE'
}

export function deviceLinkDropped(): DomainError {
  return new DomainError('DEVICE_LINK_DROPPED', `The connection to the computer dropped and it did not reconnect within ${
    deviceReconnectTimeoutMs / 1000} seconds. Retry once the computer is back online.`, 503)
}

/**
 * Waits until `live()` reports a session of the same installation and boot as `original`, then returns it.
 * A session of another boot, key or authorization revision is a real change: `failure` is thrown at once.
 * `live()` may throw to end the wait (for example when the device was revoked).
 */
export async function waitForDeviceReconnect<T extends DeviceInstallation>(options: {
  original: DeviceInstallation
  live(): T | undefined
  failure: unknown
  signal?: AbortSignal | undefined
}): Promise<T> {
  const deadline = Date.now() + deviceReconnectTimeoutMs
  for (;;) {
    options.signal?.throwIfAborted()
    const live = options.live()
    if (live) {
      if (sameDeviceInstallation(live, options.original)) return live
      throw options.failure
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw deviceLinkDropped()
    await waitForDeviceRetry(Math.min(250, remaining), options.signal)
  }
}
