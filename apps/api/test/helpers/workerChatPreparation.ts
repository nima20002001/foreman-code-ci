import { agentChatCorrelation } from '../../src/modules/conversations/agentChatRepository.js'
import type { AgentChatManagerFactory } from '../../src/modules/conversations/agentChat.js'
import type { WorkerConversationManager } from '../../src/modules/conversations/workerManager.js'

/**
 * A Worker-hosted admission requires the exact prepared Worker input. The Worker manager
 * prepares the same frame it later verifies before offering it.
 */
export function prepareWorkerInput(manager: Pick<WorkerConversationManager, 'prepareInput'>): NonNullable<AgentChatManagerFactory['prepareInput']> {
  return async ({ row, request, prompt, settings, configuration, workingDirectory }) => {
    if (!row) throw new Error('Worker preparation requires the reserved conversation.')
    const correlationId = agentChatCorrelation(row.id, request.requestId)
    const input = { prompt, clientCorrelationId: correlationId, sessionMode: settings.sessionMode,
      sessionPreferences: settings.sessionPreferences }
    return manager.prepareInput(row.native_session_id && row.provider_version
      ? { kind: 'turn', session: { harness: row.harness, nativeSessionId: row.native_session_id,
        providerVersion: row.provider_version }, input }
      // Preparation only builds the frame; the provider identity callback belongs to the later offer.
      : { kind: 'initial', input: { ...input, onSessionObserved: async () => {} }, start: { kind: 'agent-chat',
        conversationId: row.id, workflowId: row.workflow_id, workflowNodeId: row.workflow_node_id, configuration,
        workingDirectory, correlationId, instructionsDelivered: false,
        ...(row.record.systemPrompt ? { systemPrompt: row.record.systemPrompt } : {}) } })
  }
}
