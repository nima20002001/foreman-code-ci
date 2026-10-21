import type { WorkerConversationBinding, WorkerConversationConfiguration } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeSessionStart } from '../harnesses/port.js'
import { DomainError } from '../errors.js'
import type { WorkerConversationAllocation } from './workerHost.js'
import type { prepareWorkerConversationMcp } from './workerMcpAccess.js'

/** The relay already authenticated the scoped subject; native startup keeps that exact owner identity. */
export function workerConversationSessionStart(binding: WorkerConversationBinding, configuration: WorkerConversationConfiguration,
  environment: Awaited<ReturnType<typeof prepareWorkerConversationMcp>>['environment'] | undefined,
  options: Parameters<WorkerConversationAllocation['start']>[0]): NativeSessionStart {
  const owner = binding.owner, ownerId = owner.kind === 'operator' ? owner.operatorId : owner.agentId
  if (environment && (environment.agentId !== ownerId || binding.appMcpAccess !== 'scoped')) {
    throw new DomainError('HARNESS_ROLE_AUTHORITY_INVALID', 'The native environment belongs to another scoped conversation.', 403)
  }
  if (owner.kind === 'operator' && 'operatorId' in configuration && configuration.operatorId === owner.operatorId) {
    return { kind: 'operator', configuration, correlationId: options.correlationId,
      workingDirectory: binding.workingDirectory, ...(environment ? { environment } : {}) }
  }
  if (owner.kind !== 'agent' || !('agentId' in configuration) || configuration.agentId !== owner.agentId
    || configuration.workspaceId !== owner.workspaceId) {
    throw new DomainError('HARNESS_ROLE_AUTHORITY_INVALID', 'The native configuration belongs to another conversation owner.', 403)
  }
  return { kind: 'agent-chat', configuration, conversationId: owner.conversationId, workflowId: owner.workflowId,
    workflowNodeId: owner.workflowNodeId, correlationId: options.correlationId,
    ...(binding.systemPrompt ? { systemPrompt: binding.systemPrompt } : {}), ...(environment ? { environment } : {}),
    workingDirectory: binding.workingDirectory, instructionsDelivered: options.instructionsDelivered }
}
