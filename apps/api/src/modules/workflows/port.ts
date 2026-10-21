import type { WorkflowVersionV3 } from '@foreman-code/contracts/wave25'

export interface ImmutableWorkflowVersionReader {
  getSavedVersion(workflowVersionId: string): Promise<WorkflowVersionV3 | undefined>
  getCurrentSavedVersion(workspaceId: string, workflowId: string): Promise<WorkflowVersionV3 | undefined>
}
