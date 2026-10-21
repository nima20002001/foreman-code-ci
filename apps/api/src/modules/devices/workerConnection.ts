import { deviceTlsOptions } from '@foreman-code/contracts/device-tls-node'
import type { WorkerPairingConfiguration } from '@foreman-code/contracts/device-identity'
import type { DeviceExtensionRegistration } from './deviceApplicationChannel.js'
import WebSocket from 'ws'
import { DeviceConnectionSupervisor } from './connectionSupervisor.js'
import { deviceConnector } from './deviceCarrier.js'
import { DeviceConnectionError } from './deviceWire.js'
type WorkerPairing = Omit<WorkerPairingConfiguration, 'formatVersion' | 'expiresAt'>
/** Only the selected-main device credential enters this closure. */
export function createWorkerConnection(options: {
  pairing: WorkerPairing
  readPairing?(): Promise<WorkerPairing>
  bootId: string
  appVersion: string
  extensions?: DeviceExtensionRegistration[]
  /** Synchronous admission revocation; caller tracks/join its physical drain. */
  onBindingLost?(binding: Readonly<import('@foreman-code/contracts/device-connection').DeviceSessionBinding>): void
  onReady?(): void
}) {
  let pairing = options.pairing
  const identity = () => ({ mainId: pairing.mainId, deviceId: pairing.deviceId,
    workerInstallationId: pairing.workerInstallationId, keyRevision: pairing.keyRevision,
    authorizationRevision: pairing.authorizationRevision, bootId: options.bootId })
  let original: Readonly<import('@foreman-code/contracts/device-connection').DeviceSessionBinding> | undefined
  const connection = new DeviceConnectionSupervisor({
    identity: identity(),
    appVersion: options.appVersion,
    ...(options.extensions ? { extensions: options.extensions } : {}),
    mainPublicKeyFingerprint: options.pairing.mainPublicKeyFingerprint,
    refresh: async signal => {
      const refreshed = options.readPairing ? await options.readPairing() : pairing
      if (signal.aborted) throw new DeviceConnectionError('transport')
      const sameAuthority = refreshed.mainId === options.pairing.mainId
        && refreshed.deviceId === options.pairing.deviceId
        && refreshed.workerInstallationId === options.pairing.workerInstallationId
        && refreshed.mainPublicKeyFingerprint === options.pairing.mainPublicKeyFingerprint
      if (!sameAuthority) throw new DeviceConnectionError('wrong-main')
      pairing = refreshed
      return { identity: identity(), mainPublicKeyFingerprint: pairing.mainPublicKeyFingerprint }
    },
    connect: async (signal) => {
      return deviceConnector({ url: pairing.endpoint, credential: pairing.credential, create: (url, configuration) => new WebSocket(url, {...configuration,...deviceTlsOptions(pairing.tlsTrust)}) })(signal)
    },
    // Dispatch/transfer are disabled: there are no commands to replay at W07.
    reconcile: async () => {},
    onState: view => {
      if (view.phase === 'ready') {
        original = connection.currentBinding()
        options.onReady?.()
      }
      else if (original) {
        const lost = original; original = undefined
        options.onBindingLost?.(lost)
      }
    },
  })
  return connection
}
