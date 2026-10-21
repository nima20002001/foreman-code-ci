import { isDeepStrictEqual } from 'node:util'
import { COMPUTER_SYNC_NAMESPACE, SyncChannelRequestSchema } from '@foreman-code/contracts/computer-accounts'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceExtensionRegistration } from '../devices/deviceApplicationChannel.js'
import { DomainError } from '../errors.js'
import type { SyncthingComputer } from './syncthingComputer.js'

export function createComputerSyncExtension(computer: Pick<SyncthingComputer, 'handle'>,
  current: () => Readonly<DeviceSessionBinding>): DeviceExtensionRegistration {
  return { namespace: COMPUTER_SYNC_NAMESPACE, version: 1, role: 'server',
    maxJsonBytes: 1_048_576, maxBinaryBytes: 0,
    async handle(payload, context) {
      const { target, request } = SyncChannelRequestSchema.parse(payload)
      const assertCurrent = () => {
        context.signal.throwIfAborted()
        context.connectionSignal?.throwIfAborted()
        const binding = context.binding
        if (context.bytes !== undefined || !isDeepStrictEqual(current(), binding)
          || target.hostRef.kind !== 'device' || target.hostRef.mainId !== binding.mainId
          || target.hostRef.deviceId !== binding.deviceId || target.applicationInstallationId !== binding.workerInstallationId
          || target.keyRevision !== binding.keyRevision || target.authorizationRevision !== binding.authorizationRevision) {
          throw new DomainError('COMPUTER_SYNC_STALE', 'Shared file sync requires the current paired computer channel.', 409)
        }
      }
      assertCurrent()
      const signal = context.connectionSignal
        ? AbortSignal.any([context.signal, context.connectionSignal]) : context.signal
      return { payload: await computer.handle(request, { assertCurrent, signal }) }
    },
  }
}
