import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentChatFixtures, type SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import { useConversationDraftStore } from '../conversationDraftStore'
import { approvalFixture, chatHarnesses, completedFixture, providerFixture, startedFixture } from './f7.testSupport'
import { mountChat } from './testSupport'

const sent = (mounted: ReturnType<typeof mountChat>) => mounted.mock.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/messages'))
const write = (text: string) => fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: text } })
const clients: ReturnType<typeof mountChat>['client'][] = []
afterEach(() => { clients.splice(0).forEach((client) => client.clear()); useConversationDraftStore.getState().clearAllDrafts(); vi.unstubAllGlobals() })

describe('F7 B-R05 provider wire parity (MSW, no native execution)', () => {
  it.each(chatHarnesses)('%s: first admission, queue, completion, same-session follow-up, approval and Stop', async (harness) => {
    const mounted = mountChat(providerFixture(harness)); clients.push(mounted.client)
    await mounted.ready(); write('First message')
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findAllByLabelText('Queued').then(items => items.at(-1)!)
    const first = sent(mounted)[0]!.body as SendAgentChatMessageRequest
    const context = mounted.mock.getState(agentChatFixtures.empty.context).context
    let state = mounted.mock.getState(context)
    expect(first.expectedConversationId).toBeNull()
    expect(state.conversation?.harness).toBe(harness)
    expect(state.conversation?.nativeSession).toBeNull()
    expect(state.activeTurn).toBeNull()
    expect(state.turns[0]?.delivery).toBe('queued')
    state = startedFixture(state, first.requestId); mounted.mock.setState(state)
    await act(() => mounted.refresh())
    await screen.findAllByLabelText('Delivered').then(items => items.at(-1)!)
    const nativeSession = state.conversation!.nativeSession, conversationId = state.conversation!.id
    write('Queue a second turn')
    if (harness === 'claude') expect(screen.getByRole('button', { name: 'Steer' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Queue message' }))
    await waitFor(() => expect(sent(mounted)).toHaveLength(2))
    const second = sent(mounted)[1]!.body as SendAgentChatMessageRequest
    await screen.findAllByLabelText('Queued').then(items => items.at(-1)!)
    expect(mounted.mock.getState(context).activeTurn?.requestId).toBe(first.requestId)
    state = completedFixture(mounted.mock.getState(context), 'First completed reply'); mounted.mock.setState(state)
    await act(() => mounted.refresh()); await screen.findByText('First completed reply', { selector: '.conversation-message-content, .conversation-message-content p' })
    state = startedFixture(state, second.requestId); mounted.mock.setState(state)
    await act(() => mounted.refresh()); await screen.findAllByLabelText('Delivered').then(items => items.at(-1)!)
    state = completedFixture(state, 'Second completed reply'); mounted.mock.setState(state)
    await act(() => mounted.refresh()); await screen.findAllByLabelText('Completed').then(items => items.at(-1)!)
    write('Follow up after completion')
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(sent(mounted)).toHaveLength(3))
    await screen.findAllByLabelText('Queued').then(items => items.at(-1)!)
    const third = sent(mounted)[2]!.body as SendAgentChatMessageRequest
    expect(second.expectedConversationId).toBe(conversationId)
    expect(third.expectedConversationId).toBe(conversationId)
    expect(new Set([first.requestId, second.requestId, third.requestId]).size).toBe(3)
    state = approvalFixture(startedFixture(mounted.mock.getState(context), third.requestId)); mounted.mock.setState(state)
    await act(() => mounted.refresh())
    const approval = await screen.findByRole('region', { name: 'Agent approval request' })
    await userEvent.click(within(approval).getByRole('button', { name: 'Approve once' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Agent approval request' })).not.toBeInTheDocument())
    expect(mounted.mock.calls.find((call) => call.path.endsWith('/responses'))?.body).toMatchObject({
      nativeRequestId: `${harness}-approval`, optionId: `${harness}-approve-once`,
    })
    expect(sent(mounted)).toHaveLength(3)
    write('Queued before Stop'); await userEvent.click(screen.getByRole('button', { name: 'Queue message' }))
    await waitFor(() => expect(sent(mounted)).toHaveLength(4))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop chat' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: 'Stop chat' }))
    await waitFor(() => expect(mounted.mock.getState(context).activeTurn).toBeNull())
    expect(mounted.mock.getState(context).turns.map((turn) => turn.delivery)).toEqual(['completed', 'completed', 'canceled', 'canceled'])
    expect(mounted.mock.getState(context).conversation?.nativeSession).toEqual(nativeSession)
    expect(mounted.mock.calls.some((call) => call.path.includes('/runs/'))).toBe(false)
  })


  it.each(chatHarnesses)('%s: a queue head that starts returns AGENT_CHAT_TURN_STARTED, not a steer error', async (harness) => {
    const state = providerFixture(harness, agentChatFixtures.activeWithQueue), mounted = mountChat(state); clients.push(mounted.client)
    await mounted.ready(); write('Keep this draft')
    const cancel = screen.getByRole('button', { name: 'Cancel queued message' })
    mounted.mock.setState(startedFixture(completedFixture(state, 'Done'), 'request-3'))
    await userEvent.click(cancel)
    await screen.findByText('That message was already sent to the Agent.')
    expect(mounted.client.getMutationCache().getAll().at(-1)?.state.error).toMatchObject({ code: 'AGENT_CHAT_TURN_STARTED', status: 409 })
    expect(screen.queryByRole('button', { name: 'Send as next turn' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep this draft')
    expect(sent(mounted)).toHaveLength(0)
  })

  it.each(chatHarnesses)('%s: a stale approval returns AGENT_CHAT_INTERACTION_NOT_PENDING without a chat fallback', async (harness) => {
    const state = approvalFixture(providerFixture(harness, agentChatFixtures.active)), mounted = mountChat(state); clients.push(mounted.client)
    await mounted.ready(); write('Unrelated draft')
    mounted.mock.setState(completedFixture(state, 'Already completed'))
    await userEvent.click(screen.getByRole('button', { name: 'Approve once' }))
    await screen.findByText('This approval is no longer pending.')
    expect(mounted.client.getMutationCache().getAll().at(-1)?.state.error).toMatchObject({ code: 'AGENT_CHAT_INTERACTION_NOT_PENDING', status: 409 })
    expect(screen.queryByRole('button', { name: 'Send as next turn' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Unrelated draft')
    expect(sent(mounted)).toHaveLength(0)
  })
})
