import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { agentChatFixtures, type AgentChatContext, type AgentChatState, type SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import { accountBinding, observedAccount } from '../../provider-accounts/providerAccounts.fixtures'
import { server } from '../../../mocks/server'
import { agentChatFixtureFor, createAgentChatMock } from '../../../shared/mocks/agentChatHandlers'
import { getConversationDraft, useConversationDraftStore } from '../conversationDraftStore'
import { agentChatContextKey } from './model'
import { agentChatStateKey } from './useAgentChat'
import { AgentChatTestSource, approvalState, installChatSource, mountChat } from './testSupport'

const messagePath = '/api/workspaces/:workspaceId/agent-chat/messages'
const errorResponse = (code: string, message = code, status = 409) => HttpResponse.json({ error: { code, message } }, { status })
const sent = (mock: ReturnType<typeof createAgentChatMock>) => mock.calls.filter((call) => call.path.endsWith('/messages') && call.method === 'POST')
const write = (value: string) => fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value } })

afterEach(() => {
  useConversationDraftStore.getState().clearAllDrafts()
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('AgentChatPanel frozen fixtures', () => {
  it.each(['starting', 'running', 'completed'] as const)('shows the %s execution transcript before a follow-up chat exists', async state => {
    const initial = structuredClone(agentChatFixtures.empty)
    initial.context.runId = 'selected-run'
    initial.sourceTranscript = { executionId: 'selected-execution', state, revision: '1',
      messages: [{ id: 'source-message', role: 'assistant', content: 'Live workflow output', nativeMessageComplete: state === 'completed' }],
      hasEarlierMessages: false }
    initial.availability = state === 'completed' ? { canSend: true }
      : { canSend: false, reason: 'run_active', message: 'Follow-up messaging opens after this execution finishes.' }
    let controlsExecution: string | null = null
    server.use(http.get('/api/workspaces/:workspaceId/agent-chat/session-controls', ({ request }) => {
      controlsExecution = new URL(request.url).searchParams.get('executionId')
      return HttpResponse.json({ error: { code: 'AGENT_CHAT_UNAVAILABLE', message: 'Controls unavailable in fixture' } }, { status: 409 })
    }))
    const mounted = mountChat(initial)
    await mounted.ready()
    expect(await screen.findByText('Live workflow output')).toBeVisible()
    expect(screen.queryByText('Selected Run — chat unavailable')).not.toBeInTheDocument()
    await waitFor(() => expect(controlsExecution).toBe('selected-execution'))
    expect(screen.getByRole('textbox', { name: 'Message' }).hasAttribute('disabled')).toBe(state !== 'completed')
    mounted.mock.setState({ ...initial, sourceTranscript: { ...initial.sourceTranscript,
      revision: '2', messages: [{ id: 'source-message', role: 'assistant', content: 'Updated workflow output', nativeMessageComplete: true }] } })
    await mounted.refresh()
    expect(await screen.findByText('Updated workflow output')).toBeVisible()
  })

  it('does not restore protected content from a GET begun before a command denial', async () => {
    const mounted = mountChat(agentChatFixtures.idleAfterCompletion)
    await mounted.ready()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let reads = 0
    let posts = 0
    let restored = false
    server.use(http.get('/api/workspaces/:workspaceId/agent-chat', async () => {
      reads++
      if (reads === 1) {
        await held
        return HttpResponse.json(agentChatFixtures.idleAfterCompletion)
      }
      return restored ? HttpResponse.json(agentChatFixtures.idleAfterCompletion)
        : errorResponse('ACCESS_DENIED', 'Chat access revoked', 403)
    }), http.post(messagePath, () => {
      posts++
      return errorResponse('ACCESS_DENIED', 'Chat access revoked', 403)
    }))
    const oldRead = mounted.refresh()
    await waitFor(() => expect(reads).toBe(1))
    write('Denied command')
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findByText('Agent chat access unavailable')
    await act(async () => { release(); await oldRead })
    expect(screen.queryByText('It is a workflow engine.')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
    restored = true
    await act(() => mounted.refresh())
    await screen.findByRole('textbox', { name: 'Message' })
    expect(posts).toBe(1)
    mounted.unmount()
    mounted.client.clear()
  })
  it.each(Object.entries(agentChatFixtures))('renders fixture: %s', async (_name, fixture) => {
    const mounted = mountChat(fixture)
    await mounted.ready()
    for (const message of fixture.messages) expect(within(screen.getByRole('list', { name: 'Conversation history' })).getByText(message.content)).toBeInTheDocument()
    if (fixture.availability.message) {
      await userEvent.hover(screen.getByRole('status', { name: 'Agent state' }))
      expect(await screen.findByRole('tooltip')).toHaveTextContent(fixture.availability.message)
    }
    await userEvent.hover(screen.getByRole('status', { name: 'Agent state' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Business occurrence 1 · technical attempt 1')
    expect(sent(mounted.mock)).toHaveLength(0)
    if (!fixture.conversation && !fixture.availability.canSend) {
      expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    } else {
      expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled()
    }
    if (!fixture.availability.canSend && fixture.conversation) {
      write('Keep this draft')
      expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    }
    if (fixture === agentChatFixtures.steerUnavailable) {
      expect(screen.getByRole('button', { name: 'Steer' })).toBeDisabled()
      await userEvent.hover(screen.getByRole('button', { name: 'Steer' }))
      expect(await screen.findByText(fixture.capabilities.unavailable.steer!, { exact: false, selector: '[role=tooltip]' })).toBeInTheDocument()
    }
  })

  it.each(['creating', 'interrupting'] as const)('keeps the draft editable while %s', async (sessionState) => {
    const state: AgentChatState = { ...structuredClone(agentChatFixtures.active), sessionState }
    const mounted = mountChat(state); await mounted.ready(); write('Later')
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Queue message' })).toBeDisabled()
    expect(sent(mounted.mock)).toHaveLength(0)
  })

  it('uses authorized native approval controls, not a chat message', async () => {
    const mounted = mountChat(approvalState()); await mounted.ready()
    const card = screen.getByRole('region', { name: 'Agent approval request' })
    await userEvent.click(within(card).getByRole('button', { name: 'Approve once' }))
    await waitFor(() => expect(mounted.mock.calls.some((call) => call.path.endsWith('/responses'))).toBe(true))
    const request = mounted.mock.calls.find((call) => call.path.endsWith('/responses'))!
    expect(request.body).toMatchObject({ nativeRequestId: 'native-approval-1', optionId: 'codex-approve-once' })
    expect(sent(mounted.mock)).toHaveLength(0)
  })

  it('denies approval and cancel affordances independently of chat write access', async () => {
    const mounted = mountChat(approvalState(), ['agent_chat:read', 'agent_chat:write'])
    await mounted.ready()
    expect(screen.getByRole('button', { name: 'Approve once' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Stop chat' })).toBeDisabled()
  })

  it('a stale native approval never offers an ordinary-chat fallback', async () => {
    const mounted = mountChat(approvalState()); await mounted.ready(); write('Unrelated chat draft')
    server.use(http.post('/api/workspaces/:workspaceId/agent-chat/conversations/:id/responses', () =>
      errorResponse('AGENT_CHAT_TURN_NOT_ACTIVE', 'This approval request ended.')))
    await userEvent.click(screen.getByRole('button', { name: 'Approve once' }))
    await screen.findByText('This approval request ended.')
    expect(screen.queryByRole('button', { name: 'Send as next turn' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Unrelated chat draft')
    expect(sent(mounted.mock)).toHaveLength(0)
  })

  it('does not reply to a pending approval belonging to a different native session', async () => {
    const state = approvalState(); state.pendingInteraction!.session.nativeSessionId = 'another-session'
    const mounted = mountChat(state); await mounted.ready()
    expect(screen.getByRole('button', { name: 'Approve once' })).toBeDisabled()
    expect(screen.getByText(/original native request is not available/)).toBeInTheDocument()
  })

  it('offers a separate new-conversation path for missing sessions, never Resume', async () => {
    const context = { ...agentChatFixtures.sessionMissing.context, runId: 'past-run' }
    const mounted = mountChat(agentChatFixtureFor(agentChatFixtures.sessionMissing, context)); await mounted.ready()
    await userEvent.click(screen.getByRole('button', { name: 'Start separate chat without this Run' }))
    expect(mounted.newConversation).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: /resume/i })).not.toBeInTheDocument()
    expect(sent(mounted.mock)).toHaveLength(0)
  })

  it('renders delivery receipts including sending and canceled honestly', async () => {
    const state: AgentChatState = structuredClone(agentChatFixtures.activeWithQueue)
    state.turns[0]!.delivery = 'submitting'; state.turns[1]!.delivery = 'canceled'
    const mounted = mountChat(state); await mounted.ready()
    expect(screen.getByLabelText('Sending')).toBeInTheDocument()
    expect(screen.getByLabelText('Canceled')).toBeInTheDocument()
    expect(screen.getByLabelText('Queued')).toBeInTheDocument()
  })
})

describe('AgentChatPanel commands and drafts', () => {
  it('first send creates a conversation with null expectation and one requestId on fast double Enter/click', async () => {
    const mounted = mountChat(); await mounted.ready(); write('First message')
    const input = screen.getByRole('textbox', { name: 'Message' }), button = screen.getByRole('button', { name: 'Send message' })
    act(() => { fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.click(button) })
    await waitFor(() => expect(sent(mounted.mock)).toHaveLength(1))
    await waitFor(() => expect(input).toHaveValue(''))
    const body = sent(mounted.mock)[0]!.body as SendAgentChatMessageRequest
    expect(body).toMatchObject({ content: 'First message', intent: 'next_turn', expectedConversationId: null, context: {
      workflowId: 'workflow-fixture', workflowNodeId: 'node-coder', agentId: 'agent-coder',
    } })
    expect(body.requestId).toMatch(/^agent-chat-/)
    expect(body).not.toHaveProperty('nativeSessionId')
    expect(input).toHaveFocus()
  })

  it('follow-up after completion targets the same conversation with a new requestId', async () => {
    const mounted = mountChat(agentChatFixtures.idleAfterCompletion); await mounted.ready(); write('What next?')
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(sent(mounted.mock)).toHaveLength(1))
    const body = sent(mounted.mock)[0]!.body as SendAgentChatMessageRequest
    expect(body.expectedConversationId).toBe(agentChatFixtures.idleAfterCompletion.conversation.id)
    expect(body.requestId).not.toBe('request-1')
    expect(mounted.mock.getState(agentChatFixtures.empty.context).conversation?.nativeSession).toEqual(agentChatFixtures.idleAfterCompletion.conversation.nativeSession)
  })

  it('steers the exact active native turn', async () => {
    const mounted = mountChat(agentChatFixtures.active); await mounted.ready(); write('Focus on tests')
    await userEvent.click(screen.getByRole('button', { name: 'Steer' }))
    await waitFor(() => expect(sent(mounted.mock)).toHaveLength(1))
    expect(sent(mounted.mock)[0]!.body).toMatchObject({ intent: 'steer', expectedNativeTurnId: 'turn-1' })
    expect(await screen.findAllByLabelText('Delivered').then(items => items.at(-1)!)).toBeInTheDocument()
  })

  it('queues the next turn and cancels it by turn request identity', async () => {
    const mounted = mountChat(agentChatFixtures.active); await mounted.ready(); write('Then list TODOs')
    await userEvent.click(screen.getByRole('button', { name: 'Queue message' }))
    const cancel = await screen.findByRole('button', { name: 'Cancel queued message' })
    await userEvent.click(cancel)
    await waitFor(() => expect(mounted.mock.calls.some((call) => call.path.endsWith('/cancel'))).toBe(true))
    const sentId = (sent(mounted.mock)[0]!.body as SendAgentChatMessageRequest).requestId
    expect(mounted.mock.calls.find((call) => call.path.endsWith('/cancel'))!.path).toContain(`/turns/${sentId}/cancel`)
    expect(await screen.findByLabelText('Canceled')).toBeInTheDocument()
  })

  it('interrupt-and-send is one backend command, not client-side stop then send', async () => {
    const mounted = mountChat(agentChatFixtures.active); await mounted.ready(); write('Start over with tests')
    await userEvent.click(screen.getByRole('button', { name: 'Interrupt and send' }))
    await waitFor(() => expect(sent(mounted.mock)).toHaveLength(1))
    expect(sent(mounted.mock)[0]!.body).toMatchObject({ intent: 'interrupt_and_send', expectedNativeTurnId: 'turn-1' })
    expect(mounted.mock.calls.filter((call) => call.path.endsWith('/interrupt'))).toHaveLength(0)
  })

  it('Stop cancels the chat and queue, never calls a workflow Run endpoint', async () => {
    const mounted = mountChat(agentChatFixtures.activeWithQueue); await mounted.ready()
    await userEvent.click(screen.getByRole('button', { name: 'Stop chat' }))
    await waitFor(() => expect(mounted.mock.calls.some((call) => call.path.endsWith('/interrupt'))).toBe(true))
    expect(mounted.mock.getState(agentChatFixtures.empty.context).turns.every((turn) => turn.delivery === 'canceled')).toBe(true)
    expect(mounted.mock.calls.some((call) => call.path.includes('/runs/'))).toBe(false)
  })

  it('keeps a failed-send draft and offers next turn only after explicit consent', async () => {
    const mounted = mountChat(agentChatFixtures.active); await mounted.ready(); write('Keep my input')
    let posts = 0
    server.use(http.post(messagePath, () => {
      posts++; mounted.mock.setState(agentChatFixtures.idleAfterCompletion)
      return errorResponse('AGENT_CHAT_TURN_NOT_ACTIVE', 'The native turn ended.')
    }))
    await userEvent.click(screen.getByRole('button', { name: 'Steer' }))
    const next = await screen.findByRole('button', { name: 'Send as next turn' })
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep my input')
    expect(posts).toBe(1)
    // No automatic fallback to next_turn, even though the state read is now idle.
    server.use(...mounted.mock.handlers)
    await waitFor(() => expect(next).toBeEnabled())
    await userEvent.click(next)
    await waitFor(() => expect(sent(mounted.mock)).toHaveLength(1))
    expect(sent(mounted.mock)[0]!.body).toMatchObject({ intent: 'next_turn', content: 'Keep my input' })
  })

  it('stale context refetches but keeps the draft and does not auto-submit', async () => {
    const mounted = mountChat(); await mounted.ready(); write('Keep after conflict')
    let posts = 0
    server.use(http.post(messagePath, () => {
      posts++; mounted.mock.setState(agentChatFixtures.idleAfterCompletion)
      return errorResponse('AGENT_CHAT_CONTEXT_STALE', 'Another tab started this conversation.')
    }))
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    expect(await screen.findByText('Another tab started this conversation.')).toBeInTheDocument()
    await waitFor(() => expect(mounted.client.getQueryData<AgentChatState>(agentChatStateKey(agentChatFixtures.empty.context))?.conversation?.id)
      .toBe(agentChatFixtures.idleAfterCompletion.conversation.id))
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep after conflict')
    expect(posts).toBe(1)
  })

  it('shows the accepted intent when the busy state changes during a steer submission', async () => {
    const mounted = mountChat(agentChatFixtures.active); await mounted.ready(); write('Tests next')
    server.use(http.post(messagePath, async ({ request }) => {
      const input = await request.json() as SendAgentChatMessageRequest
      const state: AgentChatState = structuredClone(agentChatFixtures.idleAfterCompletion)
      const turn = { ...state.turns[0]!, requestId: input.requestId, messageId: `message-${input.requestId}`, sequence: '2', intent: 'next_turn' as const, delivery: 'accepted' as const }
      state.turns.push(turn); state.revision++
      state.messages.push({ id: turn.messageId, conversationId: state.conversation!.id, requestId: turn.requestId, role: 'user', content: input.content })
      mounted.mock.setState(state)
      return HttpResponse.json({ state, turn, replayed: false })
    }))
    await userEvent.click(screen.getByRole('button', { name: 'Steer' }))
    expect(await screen.findAllByLabelText('Delivered').then(items => items.at(-1)!)).toBeInTheDocument()
    const delivered = within((await screen.findByText('Tests next')).closest('article')!).getByLabelText('Delivered')
    await userEvent.hover(delivered)
    expect(await screen.findByText(/Delivered · Next turn/, { selector: '[role=tooltip]' })).not.toHaveTextContent('Steer')
  })

  it('unknown delivery requires the explicit new-message warning and a fresh requestId', async () => {
    const state: AgentChatState = structuredClone(agentChatFixtures.unknownDelivery)
    state.messages[0]!.originalInput = { requestId: state.turns[0]!.requestId, content: 'Summarize the repository.', attachments: [] }
    state.messages[0]!.content = 'Displayed text is not the admitted send input.'
    const mounted = mountChat(state); await mounted.ready()
    await userEvent.click(screen.getByRole('button', { name: 'Send again as new message' }))
    const warning = screen.getByRole('alertdialog')
    expect(within(warning).getByText(/original message may already have been accepted/)).toBeInTheDocument()
    expect(sent(mounted.mock)).toHaveLength(0)
    const confirm = within(warning).getByRole('button', { name: 'Send as new message' })
    expect(confirm).toBeDisabled()
    await userEvent.click(confirm)
    expect(sent(mounted.mock)).toHaveLength(0)
    await userEvent.selectOptions(within(warning).getByRole('combobox', { name: 'Mode for new message' }), 'regular')
    expect(confirm).toBeEnabled()
    await userEvent.click(confirm)
    await waitFor(() => expect(sent(mounted.mock)).toHaveLength(1))
    expect(sent(mounted.mock)[0]!.body).toMatchObject({
      intent: 'next_turn', content: 'Summarize the repository.', sessionMode: 'regular',
    })
    expect((sent(mounted.mock)[0]!.body as SendAgentChatMessageRequest).requestId).not.toBe('request-1')
  })

  it('lost HTTP acknowledgement stays unknown, preserves the draft, and cannot blindly resend', async () => {
    const mounted = mountChat(); await mounted.ready(); write('Possibly delivered')
    let posts = 0
    server.use(http.post(messagePath, () => { posts++; return HttpResponse.error() }))
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    expect(await screen.findByLabelText('Unknown')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Possibly delivered')
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter' })
    await waitFor(() => expect(screen.getByText(/review the warning/)).toBeInTheDocument())
    expect(posts).toBe(1)
  })

  it('keeps edits made while a send is pending and retains composer focus', async () => {
    const mounted = mountChat(); await mounted.ready()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    server.use(http.post(messagePath, async ({ request }) => {
      const input = await request.json() as SendAgentChatMessageRequest
      await gate
      const state: AgentChatState = structuredClone(agentChatFixtures.active)
      state.turns[0]!.requestId = input.requestId; state.turns[0]!.messageId = 'message-new'
      state.messages = [{ id: 'message-new', conversationId: state.conversation!.id, requestId: input.requestId, role: 'user', content: input.content }]
      mounted.mock.setState(state)
      return HttpResponse.json({ state, turn: state.turns[0], replayed: false })
    }))
    write('Submitted'); await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    const input = screen.getByRole('textbox', { name: 'Message' }); expect(input).toHaveFocus()
    write('A different draft'); await act(async () => { release() })
    await waitFor(() => expect(screen.getAllByLabelText('Delivered').length).toBeGreaterThan(0))
    expect(input).toHaveValue('A different draft'); expect(input).toHaveFocus()
  })

  it('a late POST receipt updates only its original key after Agent switching', async () => {
    const initial = agentChatFixtures.idleAfterCompletion, mounted = mountChat(initial); await mounted.ready()
    let release!: () => void, posted = false
    const gate = new Promise<void>((resolve) => { release = resolve })
    server.use(http.post(messagePath, async ({ request }) => {
      const input = await request.json() as SendAgentChatMessageRequest; posted = true
      await gate
      const state: AgentChatState = structuredClone(initial)
      const turn = { ...state.turns[0]!, requestId: input.requestId, messageId: 'late-user', sequence: '2', delivery: 'accepted' as const }
      state.revision++; state.turns.push(turn)
      state.messages.push({ id: turn.messageId, conversationId: state.conversation!.id, role: 'user', requestId: turn.requestId, content: input.content })
      mounted.mock.setState(state)
      return HttpResponse.json({ state, turn, replayed: false })
    }))
    write('Original selection send'); await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(posted).toBe(true))
    const other = { ...initial.context, agentId: 'second-agent' }
    mounted.switchContext(other)
    await waitFor(() => expect(screen.getByRole('status', { name: 'Agent state' })).toHaveTextContent('Idle'))
    write('Second selection draft')
    await act(async () => { release() })
    await waitFor(() => expect(mounted.client.getQueryData<AgentChatState>(agentChatStateKey(initial.context))?.messages.some((message) => message.content === 'Original selection send')).toBe(true))
    expect(screen.queryByText('Original selection send')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Second selection draft')
    expect(mounted.client.getQueryData<AgentChatState>(agentChatStateKey(other))?.conversation).toBeNull()
    mounted.switchContext(initial.context)
    await screen.findByText('Original selection send')
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('')
  })

  it('a failed delivery receipt keeps the draft even when HTTP succeeded', async () => {
    const mounted = mountChat(); await mounted.ready(); write('Keep failed native input')
    server.use(http.post(messagePath, async ({ request }) => {
      const input = await request.json() as SendAgentChatMessageRequest
      const state: AgentChatState = structuredClone(agentChatFixtures.failed)
      state.turns[0]!.requestId = input.requestId
      state.messages[0]!.requestId = input.requestId; state.messages[0]!.content = input.content
      mounted.mock.setState(state)
      return HttpResponse.json({ state, turn: state.turns[0], replayed: false })
    }))
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findAllByLabelText('Failed').then(items => items.at(-1)!)
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep failed native input')
  })

  it.each(['workspaceId', 'workflowId', 'workflowNodeId', 'agentId', 'runId'] as const)('isolates %s switching and preserves drafts per key', async (dimension) => {
    const first = agentChatFixtures.idleAfterCompletion, mounted = mountChat(first); await mounted.ready(); write('Draft for first key')
    const secondContext: AgentChatContext = { ...first.context, [dimension]: `${dimension}-other` }
    const second = agentChatFixtureFor(first, secondContext, 'second-conversation')
    second.messages = [{ id: 'other-message', conversationId: 'second-conversation', role: 'assistant', content: 'Only the other key' }]
    second.turns = []; mounted.mock.setState(second)
    mounted.switchContext(secondContext)
    expect(screen.queryByText('It is a workflow engine.')).not.toBeInTheDocument()
    await screen.findByText('Only the other key')
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('')
    write('Second key message'); await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(sent(mounted.mock)).toHaveLength(1))
    const body = sent(mounted.mock)[0]!.body as SendAgentChatMessageRequest
    expect(body.expectedConversationId).toBe('second-conversation')
    expect(body.context).toMatchObject({ workflowId: secondContext.workflowId, workflowNodeId: secondContext.workflowNodeId, agentId: secondContext.agentId })
    expect(body.context.runId).toBe(secondContext.runId)
    expect(sent(mounted.mock)[0]!.path).toContain(`/workspaces/${secondContext.workspaceId}/`)
    mounted.switchContext(first.context); await screen.findByText('It is a workflow engine.')
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Draft for first key')
    expect(getConversationDraft(agentChatContextKey(first.context))).toBe('Draft for first key')
  })
})

describe('AgentChatPanel live reads and interaction', () => {
  it('duplicate and out-of-order SSE deltas refetch without appending or duplicating messages', async () => {
    installChatSource()
    const mounted = mountChat(agentChatFixtures.active); await mounted.ready()
    await waitFor(() => expect(AgentChatTestSource.instances).toHaveLength(1))
    const source = AgentChatTestSource.instances[0]!, id = agentChatFixtures.active.conversation.id
    act(() => source.snapshot(agentChatFixtures.active))
    const next: AgentChatState = structuredClone(agentChatFixtures.active); next.revision++
    next.messages[1]!.content = 'Reading the README and package files'
    mounted.mock.setState(next)
    act(() => {
      source.event({ id: 3, conversationId: id, type: 'delta', data: { text: 'must not be guessed' } })
      source.event({ id: 3, conversationId: id, type: 'delta', data: { text: 'must not be guessed' } })
      source.event({ id: 2, conversationId: id, type: 'delta', data: { text: 'out of order' } })
    })
    await screen.findByText(next.messages[1]!.content)
    expect(screen.queryByText('must not be guessed')).not.toBeInTheDocument()
    expect(screen.getAllByText(next.messages[1]!.content)).toHaveLength(1)
    // A replayed older snapshot cannot roll back the newer revision from GET.
    act(() => source.snapshot(agentChatFixtures.active, 4))
    expect(screen.getByText(next.messages[1]!.content)).toBeInTheDocument()
    mounted.mock.setState(agentChatFixtures.idleAfterCompletion)
    act(() => source.event({ id: 5, conversationId: id, type: 'message', data: {} }))
    await screen.findByText('It is a workflow engine.', { selector: '.conversation-message-content, .conversation-message-content p' })
    expect(screen.queryByText('Reply in progress')).not.toBeInTheDocument()
    expect(sent(mounted.mock)).toHaveLength(0)
  })

  it('reconnects with a state read and never resubmits messages', async () => {
    installChatSource()
    const mounted = mountChat(agentChatFixtures.active); await mounted.ready()
    await waitFor(() => expect(AgentChatTestSource.instances).toHaveLength(1))
    const first = AgentChatTestSource.instances[0]!
    act(() => { first.snapshot(agentChatFixtures.active); first.fail() })
    expect(screen.getByText('Reconnecting to live updates')).toBeInTheDocument()
    mounted.mock.setState(agentChatFixtures.idleAfterCompletion)
    await waitFor(() => expect(AgentChatTestSource.instances).toHaveLength(2), { timeout: 2000 })
    act(() => AgentChatTestSource.instances[1]!.snapshot(agentChatFixtures.idleAfterCompletion))
    await waitFor(() => expect(screen.getByRole('status', { name: 'Agent state' })).toHaveTextContent('Completed'))
    expect(first.close).toHaveBeenCalled()
    expect(sent(mounted.mock)).toHaveLength(0)
  })

  it('ignores an old stream after switching Agent context', async () => {
    installChatSource()
    const mounted = mountChat(agentChatFixtures.active); await mounted.ready()
    await waitFor(() => expect(AgentChatTestSource.instances).toHaveLength(1))
    const old = AgentChatTestSource.instances[0]!
    const context = { ...agentChatFixtures.empty.context, agentId: 'other-agent' }
    mounted.switchContext(context)
    await waitFor(() => expect(mounted.client.getQueryData(agentChatStateKey(context))).toBeDefined())
    act(() => old.snapshot(agentChatFixtures.active))
    expect(screen.queryByText('Reading the README')).not.toBeInTheDocument()
    expect(old.close).toHaveBeenCalled()
  })

  it('supports Enter, Shift+Enter, IME composition and focus without intercepting Escape', async () => {
    const mounted = mountChat(); await mounted.ready()
    const input = screen.getByRole('textbox', { name: 'Message' })
    await userEvent.type(input, 'First{shift>}{enter}{/shift}Second')
    expect(input).toHaveValue('First\nSecond'); expect(sent(mounted.mock)).toHaveLength(0)
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 })
    expect(sent(mounted.mock)).toHaveLength(0)
    const escape = vi.fn(); window.addEventListener('keydown', escape)
    fireEvent.keyDown(input, { key: 'Escape' }); expect(escape).toHaveBeenCalledOnce()
    window.removeEventListener('keydown', escape)
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(sent(mounted.mock)).toHaveLength(1))
    expect(input).toHaveFocus()
  })

  it('does not force-scroll while reading above; Jump to latest restores following', async () => {
    const mounted = mountChat(agentChatFixtures.active); await mounted.ready()
    const scroll = screen.getByRole('region', { name: 'Agent conversation transcript' })
    Object.defineProperties(scroll, { scrollHeight: { configurable: true, value: 600 }, clientHeight: { configurable: true, value: 200 } })
    scroll.scrollTop = 0; fireEvent.scroll(scroll)
    const state: AgentChatState = structuredClone(agentChatFixtures.active); state.revision++
    state.messages[1]!.content = 'More public output'; mounted.mock.setState(state)
    await act(() => mounted.refresh())
    expect(scroll.scrollTop).toBe(0)
    await userEvent.click(await screen.findByRole('button', { name: 'Jump to latest' }))
    expect(scroll.scrollTop).toBe(600)
  })

  it('keeps queued receipts visible and cancelable when text is outside the bounded history cut', async () => {
    const state: AgentChatState = structuredClone(agentChatFixtures.activeWithQueue)
    state.messages = state.messages.filter((message) => message.id !== state.turns[2]!.messageId); state.hasEarlierMessages = true
    const mounted = mountChat(state); await mounted.ready()
    const omitted = screen.getByRole('region', { name: 'Messages outside the current history page' })
    expect(within(omitted).getByLabelText('Queued')).toBeInTheDocument()
    expect(within(omitted).getByText('Message outside this history page')).toBeInTheDocument()
    await userEvent.click(within(omitted).getByRole('button', { name: 'Cancel queued message' }))
    await waitFor(() => expect(mounted.mock.calls.some((call) => call.path.endsWith('/turns/request-3/cancel'))).toBe(true))
    expect(sent(mounted.mock)).toHaveLength(0)
  })

  it('loads bounded history pages with the returned cursor and deduplicates overlaps', async () => {
    const initial: AgentChatState = { ...structuredClone(agentChatFixtures.idleAfterCompletion), hasEarlierMessages: true }
    const mounted = mountChat(initial); await mounted.ready()
    const cursors: (string | null)[] = []
    const older = { id: 'old-user', conversationId: initial.conversation!.id, role: 'user', content: 'Earlier prompt' }
    server.use(http.get('/api/workspaces/:workspaceId/agent-chat/conversations/:id/history', ({ request }) => {
      const params = new URL(request.url).searchParams; cursors.push(params.get('before'))
      expect(params.get('limit')).toBe('50')
      return HttpResponse.json({ conversationId: initial.conversation!.id,
        messages: params.has('before') ? [older] : [older, ...initial.messages], nextCursor: params.has('before') ? null : '40' })
    }))
    await userEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }))
    await screen.findByText('Earlier prompt')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load earlier messages' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }))
    await waitFor(() => expect(cursors).toEqual([null, '40']))
    expect(screen.getAllByText('Earlier prompt')).toHaveLength(1)
    expect(screen.getAllByText('It is a workflow engine.', { selector: '.conversation-message-content, .conversation-message-content p' })).toHaveLength(1)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load earlier messages' })).not.toBeInTheDocument())
  })

  it('a denied read hides cached messages and a later network error cannot reveal them', async () => {
    const mounted = mountChat(agentChatFixtures.active); await mounted.ready(); write('Protected draft')
    server.use(http.get('/api/workspaces/:workspaceId/agent-chat', () => errorResponse('FORBIDDEN', 'Chat read access revoked.', 403)))
    await act(() => mounted.refresh())
    await screen.findByText('Agent chat access unavailable')
    expect(screen.queryByText('Reading the README')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
    server.use(http.get('/api/workspaces/:workspaceId/agent-chat', () => HttpResponse.error()))
    await act(() => mounted.refresh())
    expect(screen.queryByText('Reading the README')).not.toBeInTheDocument()
    expect(getConversationDraft(agentChatContextKey(agentChatFixtures.active.context))).toBe('Protected draft')
  })

  it('has narrow layout containment classes and an accessible reply live region', async () => {
    const mounted = mountChat(agentChatFixtures.idleAfterCompletion); await mounted.ready()
    expect(screen.getByTestId('agent-conversation')).toHaveClass('agent-conversation')
    expect(screen.getByRole('region', { name: 'Agent conversation transcript' })).toHaveClass('conversation-viewport-scroll')
    expect(screen.getByText('New reply from Coder: It is a workflow engine.')).toHaveAttribute('aria-live', 'polite')
    // jsdom cannot prove geometry; HANDOFF.md includes the actual 320px/phone overflow check.
  })

  it('keeps drafts offline and does not send them automatically on reconnect', async () => {
    const mounted = mountChat(); await mounted.ready(); write('Offline draft')
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    act(() => window.dispatchEvent(new Event('offline')))
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    expect(screen.getByText('You are offline')).toBeInTheDocument()
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    act(() => window.dispatchEvent(new Event('online')))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled())
    expect(sent(mounted.mock)).toHaveLength(0)
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Offline draft')
  })
})

it('cold readback keeps completed parent/unresolved child work visible instead of labeling the chat idle', async () => {
  installChatSource()
  const state = structuredClone(agentChatFixtures.idleAfterCompletion)
  state.activitySnapshot = { schemaVersion: 1, revision: String(state.revision), scope: { kind: 'agent_chat', conversationId: state.conversation.id,
    workspaceId: state.context.workspaceId, workflowId: state.context.workflowId, nodeId: state.context.workflowNodeId, agentId: state.context.agentId },
  active: [{ ref: { kind: 'subagent', itemId: 'child' }, phase: 'active', outcome: null, delivery: null, evidence: 'unknown', startedAt: null }],
  queued: [], latest: null, pendingInteractions: [], activities: [], page: { before: null, nextCursor: null, hasMore: false } }
  const view = mountChat(state); await view.ready()
  expect(screen.getByText('Unfinished work unconfirmed')).toBeInTheDocument()
  await userEvent.hover(screen.getByRole('status', { name: 'Agent state' }))
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Some tools or subagents have no confirmed outcome.')
})
it('keeps a persisted unavailable question visible with disabled reply options and the qualified recovery message', async () => {
  installChatSource()
  const state = approvalState()
  state.responseAvailability = { ...state.responseAvailability!, available: false, status: 'recovery_required', path: null,
    reason: 'callback_lost', message: 'The native callback was lost after restart. No reply will be sent automatically.' }
  const view = mountChat(state); await view.ready()
  expect(screen.getByText(state.responseAvailability.message)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /approve once/i })).toBeDisabled()
})


it('displays the accepted chat account after the provider default changes', async () => {
  const initial = structuredClone(agentChatFixtures.idleAfterCompletion)
  if (!initial.conversation) throw new Error('A saved conversation is required')
  initial.conversation.providerAccountBinding = accountBinding()
  server.use(http.get('/api/provider-accounts/:id', () => HttpResponse.json({ ...observedAccount(), isDefault: false })))
  const mounted = mountChat(initial)
  await mounted.ready()
  await userEvent.click(screen.getByLabelText('Saved account details'))
  expect(await screen.findByRole('region', { name: 'Saved chat account' })).toHaveTextContent('Original account')
  expect(screen.queryByRole('combobox', { name: 'Account' })).not.toBeInTheDocument()
})

it('retains a removed account and its source Run without offering a replacement chat', async () => {
  const initial: AgentChatState = structuredClone(agentChatFixtures.idleAfterCompletion)
  if (!initial.conversation) throw new Error('A saved conversation is required')
  initial.conversation.providerAccountBinding = accountBinding()
  initial.conversation.origin = { kind: 'run_execution', runId: 'saved-run', executionId: 'saved-execution',
    sourceNativeSessionId: 'saved-source-session' }
  initial.context.runId = 'saved-run'
  initial.sessionState = 'unavailable'
  initial.availability = { canSend: false, reason: 'native_session_missing', message: 'Original account unavailable' }
  server.use(http.get('/api/provider-accounts/:id', () => HttpResponse.json({ ...observedAccount(),
    removedAt: '2026-10-01T13:00:00.000Z', isDefault: false })))
  const mounted = mountChat(initial)
  await mounted.ready()
  await userEvent.click(screen.getByLabelText('Saved account details'))
  expect(await screen.findByText('Saved account unavailable')).toBeVisible()
  expect(await screen.findAllByText(/This account was removed from selection/)).not.toHaveLength(0)
  expect(screen.getByRole('region', { name: 'Source Run account · saved chat account' })).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Start separate chat without this Run' })).not.toBeInTheDocument()
  expect(mounted.newConversation).not.toHaveBeenCalled()
})
