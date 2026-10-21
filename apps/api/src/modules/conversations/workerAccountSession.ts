import { isDeepStrictEqual } from 'node:util'
import type { WorkerConversationBinding, WorkerConversationRpcRequest }
  from '@foreman-code/contracts/remote-execution-rpc'
import type { WorkerConversationJournal } from './workerJournal.js'

/** Account pins follow a native session, including its resumes, rather than the whole chat. */
export async function workerConversationAccountOwner(binding: WorkerConversationBinding,
  journal: WorkerConversationJournal, request: WorkerConversationRpcRequest) {
  const record = request.method === 'conversation.open' && request.mode === 'attach'
    && request.previousBinding && request.previousConfiguration && isDeepStrictEqual(request.binding, binding)
    ? await journal.inspectConfigurationTransition(request.previousBinding, binding,
      request.previousConfiguration, request.configuration)
    : await journal.inspectBinding(binding)
  const owner = `conversation:${binding.owner.conversationId}`
  const session = record?.replacement?.operationId ?? binding.generation
  return session ? `${owner}:session:${session}` : owner
}
