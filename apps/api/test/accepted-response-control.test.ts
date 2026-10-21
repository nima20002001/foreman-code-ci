import { describe, expect, it } from 'vitest'
import { activitySnapshotFixtures, type OperatorConversationState, type PendingNativeInteraction } from '@foreman-code/contracts'
import type { AgentChatState } from '@foreman-code/contracts/agent-chat'
import { acceptedOperatorResponseControl, acceptedResponseControl } from '../src/modules/conversations/acceptedResponseControl.js'

const pending: PendingNativeInteraction = {
  session: { harness: 'claude', providerVersion: 'version', nativeSessionId: 'session' },
  turn: { nativeMessageId: 'message-A', nativeRequestId: 'approval' }, nativeRequestType: 'can_use_tool',
  request: { generation: 'generation-A' }, responseOptions: [{ optionId: 'allow', label: 'Allow', semantic: 'approve_once', persistence: 'request',
    affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false }],
}
const submission = { kind: 'message' as const, nativeSessionId: 'session', nativeMessageId: 'message-A', clientCorrelationId: 'correlation-A' }
const expected = { harness: 'claude', providerVersion: 'version', sessionId: 'session', messageId: 'message-A', generation: 'generation-A',
  requestId: 'approval', requestType: 'can_use_tool' }
const activitySnapshot = { ...activitySnapshotFixtures.activeBeforeNewerQueued,
  scope: { kind: 'operator_chat' as const, conversationId: 'conversation' } }

describe('accepted response control identities', () => {
  it('captures the Agent message receipt and callback generation without a fabricated turn', () => {
    const state = { conversation: { id: 'conversation', nativeSession: { nativeSessionId: 'session' } },
      activeTurn: { requestId: 'A' }, turns: [{ requestId: 'A', nativeSubmission: submission }], pendingInteraction: pending,
      activitySnapshot: { ...activitySnapshot, scope: { kind: 'agent_chat', conversationId: 'conversation', workspaceId: 'workspace', workflowId: 'workflow', nodeId: 'node', agentId: 'agent' } },
    } as AgentChatState
    expect(acceptedResponseControl(state, 'approval', 'allow')?.native).toEqual(expected)
    state.turns[0]!.nativeSubmission = { ...submission, nativeMessageId: 'message-B' }
    expect(acceptedResponseControl(state, 'approval', 'allow')).toBeUndefined()
    state.turns[0]!.nativeSubmission = { ...submission, nativeSessionId: 'foreign' }
    expect(acceptedResponseControl(state, 'approval', 'allow')).toBeUndefined()
  })
  it('captures the Operator exact message and rejects a foreign receipt, request or option', () => {
    const state = { conversation: { id: 'conversation' }, activeRequestId: 'A', nativeSubmission: submission,
      pendingInteraction: pending, activitySnapshot } as OperatorConversationState
    expect(acceptedOperatorResponseControl(state, 'A', 'approval', 'allow')?.native).toEqual(expected)
    expect(acceptedOperatorResponseControl(state, 'B', 'approval', 'allow')).toBeUndefined()
    expect(acceptedOperatorResponseControl(state, 'A', 'old-request', 'allow')).toBeUndefined()
    expect(acceptedOperatorResponseControl(state, 'A', 'approval', 'unoffered')).toBeUndefined()
    state.nativeSubmission = { ...submission, nativeMessageId: 'message-B' }
    expect(acceptedOperatorResponseControl(state, 'A', 'approval', 'allow')).toBeUndefined()
  })
  it('retains a provider turn control and refuses Claude metadata with no recorded generation', () => {
    const state = { conversation: { id: 'conversation' }, activeRequestId: 'A', nativeSubmission: submission,
      pendingInteraction: { ...pending, session: { ...pending.session, harness: 'codex' }, turn: { nativeTurnId: 'turn-A', nativeRequestId: 'approval' } },
      activitySnapshot } as OperatorConversationState
    expect(acceptedOperatorResponseControl(state, 'A', 'approval', 'allow')?.native).toEqual({ harness: 'codex', providerVersion: 'version',
      sessionId: 'session', turnId: 'turn-A', requestId: 'approval', requestType: 'can_use_tool' })
    state.pendingInteraction = { ...pending, request: {} }
    expect(() => acceptedOperatorResponseControl(state, 'A', 'approval', 'allow')).toThrow('callback generation')
  })
})
