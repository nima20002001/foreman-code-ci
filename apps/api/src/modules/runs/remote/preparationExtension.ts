import { REMOTE_PREPARATION_EXTENSION, RemoteExecutionRpcRequestSchema } from '@foreman-code/contracts/remote-execution-rpc'
import type { DeviceExtensionRegistration } from '../../devices/deviceApplicationChannel.js'
import { DomainError } from '../../errors.js'

export function workflowPreparationExtension(execution: DeviceExtensionRegistration): DeviceExtensionRegistration {
  return { ...REMOTE_PREPARATION_EXTENSION, role: 'server', async handle(payload, context) {
    const request = RemoteExecutionRpcRequestSchema.parse(payload)
    if (request.method !== 'prepare' || !execution.handle) {
      throw new DomainError('REMOTE_EXECUTION_INCOMPATIBLE', 'This channel supports workflow preparation only.', 409)
    }
    return execution.handle(request, context)
  } }
}
