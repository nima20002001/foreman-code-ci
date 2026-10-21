import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InteractionSummary, OperatorConversationState } from '@foreman-code/contracts'
import { getOperatorConversation, respondOperatorInteraction, sendOperatorMessage } from '../../shared/api/client'
import { listOperatorConversationSummaries } from '../../shared/api/operatorChatSummaries'
import { OperatorChat } from './OperatorChat'
import { installCanonicalOperatorFixture } from './canonicalOperator.test-support'
import { OperatorChatVisibilityProvider } from './visibility'
import { useOperatorChatStore } from './operatorChatStore'
import { operatorState } from './pr17-test-fixtures'
import { summarizeOperatorConversation } from './operatorChatStatus'

vi.mock('../../shared/api/client', async (original) => ({ ...await original<typeof import('../../shared/api/client')>(),
  getOperatorConversation: vi.fn(), respondOperatorInteraction: vi.fn(), sendOperatorMessage: vi.fn(),
}))
vi.mock('../../shared/api/operatorChatSummaries', () => ({ listOperatorConversationSummaries: vi.fn() }))
vi.mock('../../shared/api/operatorChatStream', () => ({ subscribeOperatorChat: vi.fn((_id, listeners) => {
  listeners.connection?.('connected'); return () => {}
}) }))
beforeEach(installCanonicalOperatorFixture)
beforeEach(() => { vi.clearAllMocks(); useOperatorChatStore.setState({ open: true, historyOpen: false, selectedConversationId: 'conversation-one' }) })
afterEach(cleanup)
function mounted(delivery: InteractionSummary['delivery'], acknowledged = false) {
  const state = operatorState({ turnState: 'idle', activeRequestId: null })
  const saved: InteractionSummary = { id: 'exact-decision-receipt', revision: '7', owner: { kind: 'chat_request', conversationId: state.conversation.id, requestId: 'older-A' },
    native: { harness: 'codex', sessionId: 'exact-session', requestId: 'older-native-question' }, delivery,
    answerRecorded: true, providerAcknowledged: acknowledged, workerAcknowledged: false, responseAvailability: 'unknown' }
  state.activitySnapshot = { schemaVersion: 1, scope: { kind: 'operator_chat', conversationId: state.conversation.id }, revision: String(state.revision),
    active: [], queued: [], latest: null, pendingInteractions: [], activities: [{ kind: 'interaction', id: saved.id, revision: saved.revision, order: '0',
      owner: saved.owner, source: { schemaVersion: 1, system: 'management_command_receipt', observedAt: null }, evidence: 'confirmed', interaction: saved }],
    page: { before: null, nextCursor: null, hasMore: false } }
  vi.mocked(getOperatorConversation).mockResolvedValue(state)
  vi.mocked(listOperatorConversationSummaries).mockResolvedValue({ conversations: [summarizeOperatorConversation(state)] })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={client}><OperatorChatVisibilityProvider enabled><OperatorChat /></OperatorChatVisibilityProvider></QueryClientProvider>)
  return { state, client }
}
/** Decision details live in the receipt's own tooltip. */
async function decisionDetail(label: string) {
  const receipt = await screen.findByRole('status', { name: label })
  await userEvent.hover(receipt)
  return document.getElementById(receipt.getAttribute('aria-describedby')!)
}
describe('Operator canonical cold decision readback', () => {
  it.each(['answer_recorded', 'uncertain'] as const)('retains %s feedback after a lost callback without resending the answer', async (delivery) => {
    const { client } = mounted(delivery)
    const label = delivery === 'uncertain' ? 'Decision delivery unconfirmed' : 'Decision sending'
    expect(await decisionDetail(label)).toHaveTextContent('older-native-question')
    const reads = vi.mocked(getOperatorConversation).mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Refresh decision status' }))
    await waitFor(() => expect(getOperatorConversation).toHaveBeenCalledTimes(reads + 1))
    expect(respondOperatorInteraction).not.toHaveBeenCalled(); expect(sendOperatorMessage).not.toHaveBeenCalled()
    client.clear()
  })
  it('shows provider acknowledgment after the pending approval is gone without claiming worker completion', async () => {
    const { client } = mounted('delivered', true)
    expect(await decisionDetail('Decision delivered')).toHaveTextContent('This does not confirm work completion.')
    expect(respondOperatorInteraction).not.toHaveBeenCalled()
    client.clear()
  })
  it('does not label an idle parent with unresolved history-window overflow as Ready', async () => {
    const { state, client } = mounted('delivered', true)
    await screen.findByText('Decision delivered')
    const updated: OperatorConversationState = { ...state, revision: state.revision + 1, activitySnapshot: { ...state.activitySnapshot!,
      revision: String(state.revision + 1), hasMoreActiveWork: true, active: [{ ref: { kind: 'tool', itemId: 'older-tool' }, phase: 'active',
        outcome: null, delivery: null, evidence: 'unknown', startedAt: null }] } }
    vi.mocked(getOperatorConversation).mockResolvedValue(updated)
    await client.invalidateQueries({ queryKey: ['operator-chat', 'conversation', 'conversation-one'] })
    await screen.findByText(/Unfinished work unconfirmed/)
    expect(screen.getByRole('textbox', { name: 'Message' })).not.toBeDisabled()
    client.clear()
  })
})
