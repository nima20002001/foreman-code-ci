import { WorkerConversationManager, type WorkerChatInput, type WorkerConversationManagerOptions } from './workerManager.js'
import type { PreparedChatInput } from './nativeChatInput.js'

/** Pure exact-frame builder for the production factory's already-qualified accepted facts. No process, RPC or credential issuance. */
export function prepareWorkerChatInput(options: WorkerConversationManagerOptions, input: WorkerChatInput): PreparedChatInput {
  return new WorkerConversationManager(options).prepareInput(input)
}
