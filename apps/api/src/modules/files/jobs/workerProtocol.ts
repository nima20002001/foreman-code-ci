import { TransferContextSchema, type TransferContext } from '@foreman-code/contracts/byte-transfer'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'

export const JOB_OUTPUT_NAMESPACE = 'byte-transfer-v1'
/** Preserve the genuine opaque W07 epoch; generation is a separate connection fact. */
export function outputTransferContext(binding: Readonly<DeviceSessionBinding>): TransferContext {
  return TransferContextSchema.parse({ mainId: binding.mainId, deviceId: binding.deviceId,
    workerInstallationId: binding.workerInstallationId, keyRevision: binding.keyRevision,
    authorizationRevision: binding.authorizationRevision, bootId: binding.bootId, connectionEpoch: binding.connectionEpoch })
}
