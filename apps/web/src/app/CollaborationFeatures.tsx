import { BrowserProfileManager, ComputerBrowserProfiles, NodeBrowserFields, BrowserSetupHost } from './BrowserProfileFeatures'
import { WorkflowBrowser } from './WorkflowBrowser'
import { returnBrowserControl } from './browserRecovery'
import { BrowserRecovery } from './BrowserRecovery'
import { useMemo, type ReactNode } from 'react'
import { CollaborationUIProvider, useCollaborationUISlots, type CollaborationUISlots } from '../shared/ui/collaborationSlots'
import { WorkflowExecutionConversation } from '../features/conversations/delivery/WorkflowExecutionConversation'
import { LiveAgentConversation } from '../features/conversations/agentChat/LiveAgentConversation'
import type { WorkflowOutsideRunChatViewProps } from '../features/workflow-hierarchy/execution-chat/types'

function OutsideRunChat({ resolved }: WorkflowOutsideRunChatViewProps) {
  return <LiveAgentConversation context={resolved.agent} name="Agent chat" />
}

const collaborationSlots: CollaborationUISlots = { executionChatViews: { ExecutionChat: WorkflowExecutionConversation, OutsideRunChat },
  browserProfiles: scope => <BrowserProfileManager computer={'computer' in scope ? scope.computer : undefined} />,
  computerBrowserProfiles: target => <ComputerBrowserProfiles target={target} />,
  nodeBrowser: props => <NodeBrowserFields {...props} />,
  workflow: () => ({ browser: props => <WorkflowBrowser {...props} />, beforeBrowserHide: returnBrowserControl }),
}

/** Production defaults; an enclosing provider (a host or test) supplies its own slots and wins. */
export function CollaborationFeatures({ children }: { children: ReactNode }) {
  const supplied = useCollaborationUISlots()
  const slots = useMemo(() => ({ ...collaborationSlots, ...supplied }), [supplied])
  return <CollaborationUIProvider value={slots}>{children}<BrowserSetupHost /><BrowserRecovery /></CollaborationUIProvider>
}
