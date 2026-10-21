import type { ReactNode } from 'react'
import type { GraphqlAgentTool, GraphqlToolOverride, NodeBrowserSettings, WorkflowAgentProductRole } from '@foreman-code/contracts'

/** Feature-owned fields edit the existing draft values; they do not introduce another save authority. */
export interface CollaborationFieldSlots {
  memoryAccess?(props: {
    role: WorkflowAgentProductRole; defaults: readonly GraphqlAgentTool[] | undefined
    override: GraphqlToolOverride | undefined; executionReadOnly: boolean
    onChange(defaults: GraphqlAgentTool[] | undefined, override: GraphqlToolOverride | undefined): void
  }): ReactNode
  nodeBrowser?(props: {
    workspaceId: string; workflowId: string; nodeId: string; value: NodeBrowserSettings | undefined
    onChange(value: NodeBrowserSettings | undefined): void
  }): ReactNode
}
