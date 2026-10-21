import { OperatorConversationStateSchema, type OperatorConversationState, CODEX_APPROVAL_OPTIONS_FIXTURE } from '@foreman-code/contracts'

export function operatorState(overrides: Partial<OperatorConversationState> = {}): OperatorConversationState {
  return OperatorConversationStateSchema.parse({
    conversation: { id: 'conversation-one', agentId: 'application-operator', scope: 'application',
      operatorConfigurationVersionId: 'operator-config', title: 'First conversation', status: 'open' },
    messages: [{ id: 'message-one', conversationId: 'conversation-one', role: 'assistant', content: 'First line\nSecond line' }],
    turnState: 'active', activeRequestId: 'request-one', revision: 1, ...overrides,
  })
}
export const operatorDecision = {
  session: { harness: 'codex' as const, providerVersion: 'test', nativeSessionId: 'native-session' },
  turn: { nativeTurnId: 'native-turn', nativeRequestId: 'native-request' },
  nativeRequestType: 'item/commandExecution/requestApproval', request: { command: ['read', 'file'] },
  responseOptions: CODEX_APPROVAL_OPTIONS_FIXTURE,
}
