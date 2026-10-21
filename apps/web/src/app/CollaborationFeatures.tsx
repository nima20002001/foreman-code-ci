import { BrowserProfileManager, ComputerBrowserProfiles, NodeBrowserFields, BrowserSetupHost } from './BrowserProfileFeatures'
import { WorkflowBrowser } from './WorkflowBrowser'
import { returnBrowserControl } from './browserRecovery'
import { BrowserRecovery } from './BrowserRecovery'
import type { ReactNode } from 'react'
import { CollaborationUIProvider, type CollaborationUISlots } from '../shared/ui/collaborationSlots'
import { WorkflowExecutionConversation } from '../features/conversations/delivery/WorkflowExecutionConversation'
import { LiveAgentConversation } from '../features/conversations/agentChat/LiveAgentConversation'
import { useManagedWorkflowQuery } from '../shared/api/query'
import type { WorkflowOutsideRunChatViewProps } from '../features/workflow-hierarchy/execution-chat/types'

function OutsideRunChat({ resolved }: WorkflowOutsideRunChatViewProps) {
  // The resolution carries ids only; the saved node supplies the name that tells the person whose chat this is.
  const workflow = useManagedWorkflowQuery(resolved.agent.workspaceId, resolved.agent.workflowId)
  const node = workflow.data?.workflow.nodes.find(item => item.id === resolved.agent.workflowNodeId)
  return <LiveAgentConversation context={resolved.agent} name={node?.name ?? node?.label ?? 'Agent chat'} />
}

const collaborationSlots: CollaborationUISlots = { executionChatViews: { ExecutionChat: WorkflowExecutionConversation, OutsideRunChat },
  browserProfiles: scope => <BrowserProfileManager computer={'computer' in scope ? scope.computer : undefined} />,
  computerBrowserProfiles: target => <ComputerBrowserProfiles target={target} />,
  nodeBrowser: props => <NodeBrowserFields {...props} />,
  workflow: () => ({ browser: props => <WorkflowBrowser {...props} />, beforeBrowserHide: returnBrowserControl }),
}

export function CollaborationFeatures({ children }: { children: ReactNode }) {
  return <CollaborationUIProvider value={collaborationSlots}>{children}<BrowserSetupHost /><BrowserRecovery /></CollaborationUIProvider>
}
