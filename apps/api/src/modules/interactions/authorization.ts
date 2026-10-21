import type { DurableInteraction } from '@foreman-code/contracts'

import { DomainError } from '../errors.js'

export interface WorkerInteractionContext {
  agentId: string
  workspaceId: string
  workflowId: string
}

/** Core responder invariant. Authentication/grant lookup remains HAP-04 ownership. */
export function assertOrchestratorInteractionAuthority(
  interaction: DurableInteraction,
  authority: WorkerInteractionContext,
): void {
  const allowed = interaction.approval.handler === 'orchestrator'
    && interaction.approval.designatedOrchestratorAgentId === authority.agentId
    && interaction.workspaceId === authority.workspaceId
    && interaction.workflowId === authority.workflowId
    && interaction.requestingAgentId !== authority.agentId
  if (!allowed) {
    throw new DomainError('INTERACTION_ACCESS_DENIED', 'The caller is not authorized for this interaction.', 403)
  }
}
