// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentChatFixtures, type AgentChatState } from '@foreman-code/contracts/agent-chat'
import { useConversationDraftStore } from '../conversationDraftStore'
import { agentChatContextKey } from './model'
import { providerFixture } from './f7.testSupport'
import { installChatSource, mountChat } from './testSupport'
import { compactAgentChatResult } from './commandRecords'

const clients: ReturnType<typeof mountChat>['client'][] = []
beforeEach(() => installChatSource())
afterEach(() => {
  cleanup(); clients.splice(0).forEach((client) => client.clear())
  useConversationDraftStore.getState().clearAllDrafts(); vi.unstubAllGlobals()
})
const mount = async (state: AgentChatState) => {
  const mounted = mountChat(state); clients.push(mounted.client); await mounted.ready(); return mounted
}

it('keeps locally retained text readable for a retired chat outside the current history page', async () => {
  const state = structuredClone(agentChatFixtures.unknownDelivery)
  state.conversation!.harness = 'opencode'
  state.capabilities.harness = 'opencode'
  state.messages = []
  const turn = state.turns[0]!
  const mounted = await mount(state)
  const mutation = mounted.client.getMutationCache().build<
    ReturnType<typeof compactAgentChatResult>, Error, unknown, unknown
  >(mounted.client, {
    mutationKey: ['agent-chat', 0, agentChatContextKey(state.context), 'command'],
    mutationFn: async () => compactAgentChatResult({ state, turn, replayed: false }),
  })
  await act(async () => {
    await mutation.execute({ kind: 'send', clearDraft: true,
      input: { requestId: turn.requestId, content: 'Retained historical message' } })
  })
  const history = screen.getByRole('region', { name: 'Messages outside the current history page' })
  expect(await within(history).findByText('Retained historical message')).toBeVisible()
  expect(within(history).queryByRole('button', { name: 'Send again as new message' })).not.toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled()
  expect(mounted.mock.calls.filter(call => call.method === 'POST')).toEqual([])
})

describe('G7 contextual notices and first-message availability (React + MSW, not native execution)', () => {

  it('T-07 does not offer a composer or pretend a conversation existed for a Run with no stored session', async () => {
    const state = providerFixture('codex')
    state.context = { ...state.context, runId: 'g7-run-without-session' }
    state.availability = { canSend: false, reason: 'native_session_missing',
      message: 'This Run has no stored native session for this Agent. Chat with the Agent outside the Run instead.' }
    const key = agentChatContextKey(state.context)
    useConversationDraftStore.getState().setDraft(key, 'Preserve this selection draft')
    const mounted = await mount(state)
    expect(screen.getByText('Original session unavailable')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Preserve this selection draft')
    expect(screen.queryByText('Start a conversation')).not.toBeInTheDocument()
    expect(screen.queryByText(/This conversation cannot be resumed/)).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled()
    expect(screen.getByRole('form', { name: 'Conversation composer' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Start separate chat without this Run' }))
    expect(mounted.newConversation).toHaveBeenCalledOnce()
    expect(mounted.mock.calls.filter((call) => call.method === 'POST')).toEqual([])
    expect(useConversationDraftStore.getState().drafts[key]).toBe('Preserve this selection draft')
  })

  it('T-07 preserves first-send behavior when the selected Agent can create a conversation', async () => {
    const mounted = await mount(providerFixture('codex'))
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveAttribute('placeholder', 'Message Coder…')
    const input = screen.getByRole('textbox', { name: 'Message' })
    fireEvent.change(input, { target: { value: 'A permitted first message' } })
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(mounted.mock.calls.filter((call) => call.method === 'POST')).toHaveLength(1))
    expect(mounted.mock.calls.find((call) => call.method === 'POST')!.body).toMatchObject({
      expectedConversationId: null, intent: 'next_turn', content: 'A permitted first message',
    })
  })

  it('T-07 guard retains a lost existing conversation and its editable draft without enabling Send', async () => {
    const state = structuredClone(agentChatFixtures.sessionMissing)
    const mounted = await mount(state)
    expect(screen.getByText('Original session unavailable')).toBeInTheDocument()
    const input = screen.getByRole('textbox', { name: 'Message' })
    fireEvent.change(input, { target: { value: 'Keep this existing conversation draft' } })
    expect(input).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mounted.mock.calls.filter((call) => call.method === 'POST')).toEqual([])
  })

  it('T-03/T-08 keeps long notices inside the single transcript and actions in a sibling footer', async () => {
    const state = providerFixture('claude', agentChatFixtures.active)
    state.messages = state.messages.filter((message) => message.role !== 'assistant')
    state.capabilities.unavailable.steer = 'A long provider-specific explanation. '.repeat(100)
    await mount(state)
    const transcript = screen.getByRole('region', { name: 'Agent conversation transcript' })
    expect(screen.getAllByRole('region', { name: 'Agent conversation transcript' })).toHaveLength(1)
    expect(within(transcript).getByRole('status', { name: 'Coder is working' })).toBeInTheDocument()
    await userEvent.hover(screen.getByRole('button', { name: 'Steer' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('A long provider-specific explanation.')
    await userEvent.hover(screen.getByRole('status', { name: 'Agent state' }))
    expect(await screen.findByText(/Business occurrence 1/, { selector: '[role=tooltip]' })).toBeInTheDocument()
    const actions = screen.getByRole('group', { name: 'Chat actions' })
    expect(transcript).not.toContainElement(actions)
    expect(actions.parentElement).toBe(transcript.closest('.conversation-viewport')!.parentElement)
    for (const name of ['Queue message', 'Steer', 'Interrupt and send', 'Stop chat']) {
      expect(within(actions).getByRole('button', { name })).toBeInTheDocument()
      expect(within(transcript).queryByRole('button', { name })).not.toBeInTheDocument()
    }
  })
})

it('shows saved OpenCode messages as read-only even when old capabilities advertise writes', async () => {
  const state = structuredClone(agentChatFixtures.idleAfterCompletion)
  state.conversation!.harness = 'opencode'
  state.capabilities.harness = 'opencode'
  state.availability.canSend = true
  await mount(state)
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveAttribute('placeholder', 'Retired harness: read-only')
  expect(screen.getByRole('region', { name: 'Agent conversation transcript' })).toBeVisible()
  expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled()
  expect(within(screen.getByRole('group', { name: 'Chat actions' })).getByRole('button', { name: 'Send message' })).toBeDisabled()
  expect(screen.queryByRole('button', { name: 'Send again as new message' })).not.toBeInTheDocument()
})
