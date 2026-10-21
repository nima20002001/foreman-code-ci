import type { DurableInteraction } from '@foreman-code/contracts'

export function interactionMatchesScope(interaction: DurableInteraction, scope: { workspaceId?: string; workflowId?: string }): boolean {
  return (!scope.workspaceId || interaction.workspaceId === scope.workspaceId)
    && (!scope.workflowId || interaction.workflowId === scope.workflowId)
}
