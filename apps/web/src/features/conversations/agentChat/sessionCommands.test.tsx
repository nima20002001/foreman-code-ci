import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionControlStateSchema, unavailableSessionControls } from '@foreman-code/contracts'
import { agentChatFixtures, type AgentChatState, type SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import * as sessionHooks from '../sessionControls/useSessionControls'
import { mountChat } from './testSupport'
import { useConversationDraftStore } from '../conversationDraftStore'
import { AgentChatTranscript } from './AgentChatTranscript'
import { agentChatStateKey, type useAgentChat } from './useAgentChat'
import { http, HttpResponse } from 'msw'
import { server } from '../../../mocks/server'

it.each(['idle', 'active'] as const)('starts a fresh Agent conversation with /new while %s', async status => {
  const initial = structuredClone(status === 'active' ? agentChatFixtures.active : agentChatFixtures.idleAfterCompletion)
  if (status === 'active') {
    initial.capabilities.queueNextTurn = false
    initial.capabilities.unavailable.queueNextTurn = 'Message queueing is unavailable.'
  }
  const mounted = mountChat(initial)
  await mounted.ready()
  const fresh = { ...structuredClone(agentChatFixtures.empty), context: initial.context,
    conversation: { ...initial.conversation!, id: 'fresh-conversation', nativeSession: null,
      previousConversationId: initial.conversation!.id },
  }
  const requests: unknown[] = []
  server.use(http.post('/api/workspaces/:workspaceId/agent-chat/messages', async ({ request }) => {
    const body = await request.json() as SendAgentChatMessageRequest
    requests.push(body)
    mounted.mock.setState(fresh)
    return HttpResponse.json({ state: fresh, replayed: false,
      reset: { requestId: body.requestId, previousConversationId: initial.conversation!.id } })
  }))
  const input = screen.getByRole('textbox', { name: 'Message' })
  fireEvent.change(input, { target: { value: '/n' } })
  expect(screen.getByRole('option', { name: '/new' })).toBeInTheDocument()
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(requests).toHaveLength(1))
  const { workspaceId, ...context } = initial.context
  expect(workspaceId).toBeTruthy()
  expect(requests[0]).toEqual({ content: '/new', intent: 'next_turn', requestId: expect.any(String), attachments: [],
    expectedConversationId: initial.conversation!.id, context })
  await waitFor(() => expect(input).toHaveValue(''))
  await waitFor(() => expect(mounted.client.getQueryData<AgentChatState>(
    agentChatStateKey(initial.context),
  )?.conversation?.id).toBe('fresh-conversation'))
  expect(controls.command).not.toHaveBeenCalled()
  expect(mounted.newConversation).not.toHaveBeenCalled()
})

it('keeps the /new draft and previous conversation when the server rejects the command', async () => {
  const initial = structuredClone(agentChatFixtures.idleAfterCompletion)
  const mounted = mountChat(initial)
  await mounted.ready()
  server.use(http.post('/api/workspaces/:workspaceId/agent-chat/messages', () =>
    HttpResponse.json({ error: { code: 'AGENT_CHAT_CONTEXT_STALE', message: 'Refresh before starting a new conversation.' } },
      { status: 409 })))
  const input = screen.getByRole('textbox', { name: 'Message' })
  fireEvent.change(input, { target: { value: '/new' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(await screen.findByText('Refresh before starting a new conversation.')).toBeInTheDocument()
  expect(input).toHaveValue('/new')
  expect(mounted.mock.getState(initial.context).conversation?.id).toBe(initial.conversation!.id)
})

const settings = SessionControlStateSchema.parse({ conversationId: 'chat', revision: 1, profileKey: 'profile',
  desiredMode: 'regular', appliedMode: 'regular', defaults: {}, desired: {}, applied: {}, applicability: 'applied',
  context: null, nativeSessionId: 'native', nativeProviderVersion: 'test', compaction: null, compactions: [],
  busyReason: null, capabilities: unavailableSessionControls('profile') })
let controls: sessionHooks.ComposerSessionControls
const clients: QueryClient[] = []
beforeEach(() => {
  controls = { state: settings, query: { isError: false, refetch: vi.fn() },
    mutation: { isPending: false, isError: false }, change: vi.fn(), command: vi.fn(async () => true) } as unknown as sessionHooks.ComposerSessionControls
  vi.spyOn(sessionHooks, 'useSessionControls').mockImplementation(() => controls)
})
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); useConversationDraftStore.getState().clearAllDrafts() })

it('shows the model window before the first turn and offers no session options in the node chat', async () => {
  controls.state = { ...settings, capabilities: { ...settings.capabilities, modelCapacity: 200000 } }
  const mounted = mountChat(structuredClone(agentChatFixtures.idleAfterCompletion))
  await mounted.ready()
  expect(await screen.findByRole('button', { name: '0% context' })).toBeInTheDocument()
  expect(screen.queryByText(/context unknown/i)).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Session options')).not.toBeInTheDocument()
  expect(screen.queryByRole('combobox', { name: 'Conversation mode' })).not.toBeInTheDocument()
})

it('shows no context meter before the first turn when the model window is not known', async () => {
  const mounted = mountChat(structuredClone(agentChatFixtures.idleAfterCompletion))
  await mounted.ready()
  expect(screen.queryByRole('button', { name: /context/i })).not.toBeInTheDocument()
})

for (const action of ['Steer', 'Interrupt and send']) {
  it.each(['/plan', '/plan off', '/compact'])(`${action} routes %s only to native controls`, async content => {
    const mounted = mountChat(structuredClone(agentChatFixtures.active))
    await mounted.ready()
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: content } })
    fireEvent.click(screen.getByRole('button', { name: action }))
    await waitFor(() => expect(controls.command).toHaveBeenCalledOnce())
    expect(vi.mocked(controls.command).mock.calls[0]![0]).toBe(content)
    expect(mounted.mock.calls.filter(call => call.path.endsWith('/messages') && call.method === 'POST')).toHaveLength(0)
  })
}

it.each(['plan task', 'plan mode'])('disables steering a %s with an explicit reason instead of queuing', async kind => {
  if (kind === 'plan mode') controls.state = { ...settings, desiredMode: 'plan' }
  const mounted = mountChat(structuredClone(agentChatFixtures.active))
  await mounted.ready()
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
    target: { value: kind === 'plan task' ? '/plan Inspect the repository' : 'Inspect the repository' },
  })
  const steer = screen.getByRole('button', { name: 'Steer' })
  expect(steer).toBeDisabled()
  expect(steer).toHaveAttribute('title', 'Plan messages need a new turn. Use Queue message or Interrupt and send.')
  fireEvent.click(steer)
  expect(mounted.mock.calls.filter(call => call.path.endsWith('/messages') && call.method === 'POST')).toHaveLength(0)
})

it('sends a Plan task from Interrupt and send with its explicit intent and mode', async () => {
  const mounted = mountChat(structuredClone(agentChatFixtures.active))
  await mounted.ready()
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: '/plan Inspect files' } })
  fireEvent.click(screen.getByRole('button', { name: 'Interrupt and send' }))
  await waitFor(() => expect(mounted.mock.calls.find(call => call.path.endsWith('/messages') && call.method === 'POST')?.body)
    .toMatchObject({ content: '/plan Inspect files', intent: 'interrupt_and_send', sessionMode: 'plan' }))
})

it.each(['accepted', 'running', 'uncertain'] as const)('blocks normal sending while compaction is %s', async status => {
  controls.state = { ...settings, compaction: { requestId: 'compact-request', nativeSessionId: 'native',
    nativeOperationId: 'compact-turn', status, beforeTokens: 100, message: 'Compaction is still in progress.',
    observedAt: new Date().toISOString() } }
  const mounted = mountChat(structuredClone(agentChatFixtures.idleAfterCompletion))
  await mounted.ready()
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Continue' } })
  expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
  expect(screen.getAllByText('Compaction is still in progress.').length).toBeGreaterThan(0)
})

it.each(['regular', 'plan'] as const)('requires an explicit %s resend mode when the original mode is unknown', async mode => {
  const state: AgentChatState = structuredClone(agentChatFixtures.idleAfterCompletion)
  const turn = state.turns[0]!
  state.turns = [{ ...turn, delivery: 'unknown' }]
  state.messages[0]!.originalInput = { requestId: turn.requestId, content: 'Inspect the repository', attachments: [] }
  const mounted = mountChat(state)
  await mounted.ready()
  fireEvent.click(screen.getByRole('button', { name: 'Send again as new message' }))
  const dialog = within(screen.getByRole('alertdialog'))
  expect(dialog.getByRole('button', { name: 'Send as new message' })).toBeDisabled()
  fireEvent.change(dialog.getByRole('combobox', { name: 'Mode for new message' }), { target: { value: mode } })
  fireEvent.click(dialog.getByRole('button', { name: 'Send as new message' }))
  await waitFor(() => expect(mounted.mock.calls.find(call => call.path.endsWith('/messages') && call.method === 'POST')?.body)
    .toMatchObject({ content: 'Inspect the repository', intent: 'next_turn', sessionMode: mode }))
})

it('resends a slash Plan task with Plan mode even when current settings are Regular', async () => {
  const state: AgentChatState = structuredClone(agentChatFixtures.idleAfterCompletion)
  const turn = state.turns[0]!
  state.turns = [{ ...turn, delivery: 'unknown' }]
  state.messages[0]!.originalInput = { requestId: turn.requestId, content: '/plan Inspect files', attachments: [] }
  const mounted = mountChat(state)
  await mounted.ready()
  fireEvent.click(screen.getByRole('button', { name: 'Send again as new message' }))
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Send as new message' }))
  await waitFor(() => {
    const request = mounted.mock.calls.find(call => call.path.endsWith('/messages') && call.method === 'POST')?.body as SendAgentChatMessageRequest
    expect(request).toMatchObject({ content: '/plan Inspect files', sessionMode: 'plan' })
  })
})

it.each(['regular', 'plan'] as const)('preserves the original local %s mode in resend controls', mode => {
  const state: AgentChatState = structuredClone(agentChatFixtures.idleAfterCompletion)
  const turn = state.turns[0]!
  state.turns = [{ ...turn, delivery: 'unknown' }]
  state.messages[0]!.originalInput = { requestId: turn.requestId, content: 'Inspect files', attachments: [] }
  const onSendAgain = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><AgentChatTranscript state={state} name="Agent" commands={[{ status: 'success', submittedAt: 1,
    result: undefined, error: undefined, command: { kind: 'send', clearDraft: true,
      input: { requestId: turn.requestId, expectedConversationId: state.conversation!.id,
        context: state.context, content: 'Inspect files', sessionMode: mode, intent: 'next_turn' } } }]}
    history={{ data: undefined, hasNextPage: false } as ReturnType<typeof useAgentChat>['history']}
    onCancel={vi.fn()} onRespond={vi.fn()} onSendAgain={onSendAgain} /></QueryClientProvider>)
  fireEvent.click(screen.getByRole('button', { name: 'Send again as new message' }))
  expect(onSendAgain).toHaveBeenCalledExactlyOnceWith('Inspect files', [], mode)
})

it.each(['/plan', '/plan off', '/compact'])('routes an explicitly resent %s to controls instead of message admission', async content => {
  const state: AgentChatState = structuredClone(agentChatFixtures.idleAfterCompletion)
  const turn = state.turns[0]!
  state.turns = [{ ...turn, delivery: 'unknown' }]
  state.messages[0]!.originalInput = { requestId: turn.requestId, content, attachments: [] }
  const mounted = mountChat(state)
  await mounted.ready()
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Independent draft' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send again as new message' }))
  const dialog = within(screen.getByRole('alertdialog'))
  const choice = dialog.queryByRole('combobox', { name: 'Mode for new message' })
  if (choice) fireEvent.change(choice, { target: { value: 'regular' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Apply session command' }))
  await waitFor(() => expect(controls.command).toHaveBeenCalledOnce())
  expect(vi.mocked(controls.command).mock.calls[0]![0]).toBe(content)
  expect(mounted.mock.calls.filter(call => call.path.endsWith('/messages') && call.method === 'POST')).toHaveLength(0)
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Independent draft')
})

it('allows resending a mode command when new message turns are unavailable', async () => {
  const state: AgentChatState = structuredClone(agentChatFixtures.idleAfterCompletion)
  state.capabilities.resume = false
  state.capabilities.unavailable.resume = 'This conversation cannot continue.'
  const turn = state.turns[0]!
  state.turns = [{ ...turn, delivery: 'unknown' }]
  state.messages[0]!.originalInput = { requestId: turn.requestId, content: '/plan off', attachments: [] }
  const mounted = mountChat(state)
  await mounted.ready()
  const resend = screen.getByRole('button', { name: 'Send again as new message' })
  expect(resend).toBeEnabled()
  fireEvent.click(resend)
  const apply = within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Apply session command' })
  expect(apply).toBeEnabled()
  fireEvent.click(apply)
  await waitFor(() => expect(controls.command).toHaveBeenCalledExactlyOnceWith('/plan off', expect.any(String)))
  expect(mounted.mock.calls.filter(call => call.path.endsWith('/messages') && call.method === 'POST')).toHaveLength(0)
})

it('chooses a session command from the menu when ordinary message queueing is unavailable', async () => {
  const state = structuredClone(agentChatFixtures.active)
  state.capabilities.queueNextTurn = false
  state.capabilities.unavailable.queueNextTurn = 'Message queueing is unavailable.'
  const mounted = mountChat(state)
  await mounted.ready()
  const input = screen.getByRole('textbox', { name: 'Message' })
  fireEvent.change(input, { target: { value: '/c' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(controls.command).toHaveBeenCalledExactlyOnceWith('/compact', expect.any(String)))
  expect(mounted.mock.calls.filter(call => call.path.endsWith('/messages') && call.method === 'POST')).toHaveLength(0)
})

it.each(['ordinary text', '/compact', '/plan', '/unknown', 'first line\nsecond line'])('keeps Board Stop available and preserves draft %j during a pending native control', async content => {
  controls.mutation.isPending = true
  const mounted = mountChat(structuredClone(agentChatFixtures.active))
  try {
    await mounted.ready()
    const input = screen.getByRole('textbox', { name: 'Message' })
    fireEvent.change(input, { target: { value: content } })
    fireEvent.click(screen.getByRole('button', { name: 'Stop chat' }))
    await waitFor(() => expect(mounted.mock.calls.some(call => call.path.endsWith('/interrupt') && call.method === 'POST')).toBe(true))
    expect(input).toHaveValue(content)
    expect(mounted.mock.calls.find(call => call.path.endsWith('/interrupt'))?.body)
      .toMatchObject({ expectedNativeTurnId: agentChatFixtures.active.activeTurn!.nativeTurnId })
    expect(mounted.mock.calls.filter(call => call.path.endsWith('/messages') && call.method === 'POST')).toHaveLength(0)
    expect(controls.command).not.toHaveBeenCalled()
  } finally { mounted.unmount(); mounted.client.clear() }
})
