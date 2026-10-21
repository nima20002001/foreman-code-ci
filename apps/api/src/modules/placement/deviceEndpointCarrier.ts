import { REMOTE_EXECUTION_EXTENSION, REMOTE_PREPARATION_EXTENSION } from '@foreman-code/contracts/remote-execution-rpc'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import type { CapturedDeviceApplicationRequest } from '../devices/deviceApplicationChannel.js'
import { waitForDeviceReconnect } from '../devices/deviceReconnect.js'
import { DeviceConnectionError } from '../devices/deviceWire.js'
import { DomainError } from '../errors.js'
import type { MainWorkerCarrier } from './workerCarrier.js'

/** The authenticated Main device endpoint, as the carrier sees it. */
export interface DeviceCarrierEndpoint {
  captureRequest(deviceId: string, namespace: string): CapturedDeviceApplicationRequest | undefined
  isRevoked(deviceId: string, authorizationRevision: number): boolean
}
/** Each capture returns the identity and request closure of the SAME live channel; reconnect waits for the same boot. */
export function deviceEndpointCarrier(endpoint: () => DeviceCarrierEndpoint): MainWorkerCarrier {
  return {
    capture(deviceId) {
      const current = endpoint(), captured = current.captureRequest(deviceId, REMOTE_EXECUTION_EXTENSION)
      if (!captured) throw new DomainError('REMOTE_DISPATCH_UNAVAILABLE', 'The actual authenticated execution carrier is unavailable.', 503)
      const preparation = current.captureRequest(deviceId, REMOTE_PREPARATION_EXTENSION.namespace)
      const compatiblePreparation = preparation && sameWorkflowValue(preparation.binding, captured.binding)
        ? preparation : undefined
      const { mainId, workerInstallationId, bootId, keyRevision, authorizationRevision, connectionGeneration } = captured.binding
      return { identity: { mainId, deviceId, workerInstallationId, bootId, keyRevision, authorizationRevision, connectionGeneration },
        ...(captured.stopReadAdmission ? { stopReadAdmission: true as const } : {}),
        supports: namespace => namespace === REMOTE_EXECUTION_EXTENSION
          || namespace === REMOTE_PREPARATION_EXTENSION.namespace && compatiblePreparation !== undefined,
        request(namespace, payload, options) {
          if (namespace === REMOTE_PREPARATION_EXTENSION.namespace && compatiblePreparation) {
            return compatiblePreparation.request(payload, options)
          }
          if (namespace !== REMOTE_EXECUTION_EXTENSION) throw new DomainError('REMOTE_BINDING_CONFLICT', 'The captured native carrier cannot change namespace.', 409)
          return captured.request(payload, options)
        } }
    },
    async reconnect(deviceId, original, failure, signal) {
      await waitForDeviceReconnect({ original, failure, signal, live: () => {
        const current = endpoint()
        if (current.isRevoked(deviceId, original.authorizationRevision)) throw new DeviceConnectionError('revoked')
        return current.captureRequest(deviceId, REMOTE_EXECUTION_EXTENSION)?.binding
      } })
    },
  }
}
