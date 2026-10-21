import type { AgentChatSessionState } from '@foreman-code/contracts/agent-chat'

const phaseLabels: Record<AgentChatSessionState, string> = {
  none: 'Start a conversation',
  creating: 'Creating the native session',
  idle: 'Ready for a follow-up',
  active: 'Agent is working',
  interrupting: 'Stop requested—execution not yet confirmed stopped.',
  waiting_approval: 'Waiting for approval',
  uncertain: 'Delivery uncertain—may still be running.',
  unavailable: 'Native session unavailable',
  error: 'The last turn failed',
}

/** Execution, delivery, connection and available actions remain independent facts. */
export function chatStatus(input: {
  phase: AgentChatSessionState
  executionLabel?: string
  delivery?: string
  connection: 'connected' | 'connecting' | 'reconnecting' | 'offline' | 'unavailable'
  online?: boolean
  hasConversation: boolean
  snapshotFresh?: boolean
  actionUnavailable?: string
  error?: string
}) {
  let connection: string | undefined
  if (input.online === false || input.connection === 'offline') {
    connection = 'Offline · draft kept. No messages will be sent automatically when you reconnect.'
  }
  else if (input.hasConversation && !input.snapshotFresh && input.connection !== 'connected') {
    connection = input.connection === 'unavailable'
      ? 'Waiting for activity updates.'
      : 'Connecting to activity updates.'
  }
  return {
    execution: input.executionLabel ?? phaseLabels[input.phase],
    delivery: input.delivery,
    connection,
    actionUnavailable: input.actionUnavailable,
    error: input.error,
  }
}
