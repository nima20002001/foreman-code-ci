import type { AgentChatContext } from '@foreman-code/contracts/agent-chat'
import { EmptyState } from '../../shared/ui/nocturne'
import { useHarnessSessionEpoch } from '../../shared/api/harnessSettings'
import { sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { AgentConversation } from '../conversations/agentChat/AgentConversation'
import { AgentChatHeader } from '../conversations/agentChat/AgentChatHeader'
import { agentChatContextKey } from '../conversations/agentChat/model'
import { useAgentChatWindowClose } from '../conversations/agentChat/agentChatWindows'
import '../conversations/agentChat/agentChat.css'

export function AgentChatPanel({ name, role, activity, running, runLabel, context, onClose: popoverClose, onNewConversation }: {
  name: string; role?: string; activity?: string; running?: boolean; runLabel?: string
  context?: AgentChatContext; onClose?: () => void; onNewConversation?: () => void
}) {
  // Inside a floating chat window, the X closes that window.
  const onClose = useAgentChatWindowClose() ?? popoverClose
  const generation = useHarnessSessionEpoch()
  if (sessionIsSwitching()) return null
  return <div className="agent-chat-panel">
    {context ? <AgentConversation key={`${generation}:${agentChatContextKey(context)}`} context={context} name={name}
      role={role} activity={activity} runLabel={runLabel} onClose={onClose} onNewConversation={onNewConversation} />
      : <><AgentChatHeader name={name} state={running ? 'Working' : 'Idle'} detail={activity} onClose={onClose} />
        <EmptyState icon="info" title="Select a saved Agent to chat" /></>}
  </div>
}
