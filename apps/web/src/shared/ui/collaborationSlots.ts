import { createContext, useContext, type ReactNode } from 'react'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { CollaborationFieldSlots } from '../../features/graph/collaborationFields'
import type { WorkflowCollaborationSlots } from '../../features/workflow-board/WorkflowSidePanel'
import type { WorkflowExecutionChatViews } from '../../features/workflow-hierarchy/execution-chat/types'

/** Explicit composition of feature-owned UI; the shell retains no feature data or background work. */
export interface CollaborationUISlots extends CollaborationFieldSlots {
  executionChatViews?: WorkflowExecutionChatViews
  workflow?(scope: { workspaceId: string; workflowId: string }): WorkflowCollaborationSlots
  workspaceMemoryBoard?(scope: { workspaceId: string }): ReactNode
  browserProfiles?(scope: { workspaceId: string } | { mainId: string; computer?: DeviceProvisioningTarget }): ReactNode
  computerBrowserProfiles?(target: DeviceProvisioningTarget): ReactNode
}

const CollaborationUIContext = createContext<CollaborationUISlots | undefined>(undefined)
export const CollaborationUIProvider = CollaborationUIContext.Provider
export function useCollaborationUISlots() { return useContext(CollaborationUIContext) }
