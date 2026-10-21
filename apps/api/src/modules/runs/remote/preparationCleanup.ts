import type { DispatchIntent } from '@foreman-code/contracts/node-placement'
import type { RemoteOwnerControl } from '@foreman-code/contracts/remote-execution'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'

export function preparationStop(intent: DispatchIntent): RemoteOwnerControl {
  return {
    schemaVersion: 1, protocolVersion: 1,
    commandId: commandInputHash({ intent, action: 'cleanup-stop' }),
    operationId: intent.operationId, attemptId: intent.attemptId, executionId: intent.executionId,
    bindingHash: intent.bindingHash, owner: intent.owner, action: { kind: 'stop' },
  }
}
