import { ChatSendRequestSchema } from '@foreman-code/contracts'
import type { DispatchIntent } from '@foreman-code/contracts/node-placement'
import { RemoteOwnerControlSchema, type RemoteOwnerControl, type RemoteNativeIdentity } from '@foreman-code/contracts/remote-execution'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'
import { asWorkflowChatTarget, readControlCommand } from './workflowControlRecords.js'
import type { WorkflowChatNativeTarget } from './workflowControlTypes.js'

export function workflowRemoteControl(intent: DispatchIntent, native: RemoteNativeIdentity, input: {
  commandId: string; ownerRequestId: string; action: RemoteOwnerControl['action']
}): RemoteOwnerControl {
  return RemoteOwnerControlSchema.parse({ schemaVersion: 1, protocolVersion: 1,
    commandId: input.commandId, operationId: intent.operationId, attemptId: intent.attemptId,
    executionId: intent.executionId, bindingHash: intent.bindingHash, owner: intent.owner, native,
    workflowControl: { ownerRequestId: input.ownerRequestId }, action: input.action })
}

export async function assertWorkflowRemoteControl(sql: GraphSqlClient, intent: DispatchIntent,
  control: RemoteOwnerControl): Promise<void> {
  const command = await readControlCommand(sql, control.commandId)
  const target = command && asWorkflowChatTarget(command.target)
  const native = command?.native_target as WorkflowChatNativeTarget | null | undefined
  if (!control.workflowControl || !command || command.run_id !== intent.runId
    || target?.kind !== 'workflow_execution' || target.execution.runId !== intent.runId
    || target.execution.executionId !== intent.executionId || target.agent.workflowNodeId !== intent.nodeId
    || control.operationId !== intent.operationId || control.executionId !== intent.executionId
    || control.attemptId !== intent.attemptId || control.bindingHash !== intent.bindingHash
    || !sameWorkflowValue(control.owner, intent.owner)
    || !['submitting', 'accepted', 'unknown', 'settling'].includes(command.state)
    || !native || native.nativeSessionId !== control.native?.sessionId
    || (native.nativeTurnId ?? native.inputMessageId) !== control.native.turnId
    || native.ownerRequestId !== control.workflowControl.ownerRequestId
    || native.ownerRequestId !== `execution:${intent.executionId}`) throw new DomainError(
    'REMOTE_CONTROL_UNAVAILABLE', 'The durable workflow control no longer owns this exact native input.', 409)
  if (control.action.kind === 'steer') {
    const request = ChatSendRequestSchema.parse(command.request)
    if (command.operation !== 'steer' || command.native_prompt !== control.action.prompt
      || request.attachments.length || native.sessionMode !== (request.sessionMode ?? native.sessionMode)) throw new DomainError(
      'REMOTE_CONTROL_UNAVAILABLE', 'The steering command differs from its admitted input.', 409)
  } else if (control.action.kind !== 'stop' || !['stop', 'interrupt'].includes(command.operation)) {
    throw new DomainError('REMOTE_CONTROL_UNAVAILABLE', 'The admitted workflow control has a different operation.', 409)
  }
}
