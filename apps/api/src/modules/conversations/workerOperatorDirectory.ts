import { posix } from 'node:path'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { WorkerConversationBinding } from '@foreman-code/contracts/remote-execution-rpc'

export function workerOperatorDirectory(runtimeRoot: string,
  owner: Extract<WorkerConversationBinding['owner'], { kind: 'operator' }>) {
  const key = commandInputHash({ conversationId: owner.conversationId, operatorId: owner.operatorId }).slice('sha256:'.length)
  return posix.join(runtimeRoot, 'operator-chats', key)
}
