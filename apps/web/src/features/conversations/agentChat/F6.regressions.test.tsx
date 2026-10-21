import { useRef } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import type { Message } from '@foreman-code/contracts'
import { agentChatFixtures, type AgentChatState, type AgentChatTurn, type SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import { server } from '../../../mocks/server'
import { createAgentChatMock } from '../../../shared/mocks/agentChatHandlers'
import { AgentPopover } from '../../../shared/ui/nocturne'
import { AgentChatPanel } from '../../graph/AgentPanels'
import { getConversationDraft, useConversationDraftStore } from '../conversationDraftStore'
import { agentChatContextKey } from './model'
import { agentChatStateKey } from './useAgentChat'
import { AgentChatTestSource, approvalState, installChatSource, mountChat } from './testSupport'

const root = '/api/workspaces/:workspaceId/agent-chat'
const messagePath = `${root}/messages`, historyPath = `${root}/conversations/:id/history`
const write = (value: string) => fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value } })
const gate = () => {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}
const receiptState = (input: SendAgentChatMessageRequest, delivery: AgentChatTurn['delivery']): AgentChatState => {
  const state: AgentChatState = structuredClone(agentChatFixtures.idleAfterCompletion)
  const turn: AgentChatTurn = { ...state.turns[0]!, requestId: input.requestId, messageId: `message-${input.requestId}`,
    sequence: '2', intent: input.intent, delivery }
  state.turns.push(turn)
  state.messages.push({ id: turn.messageId, requestId: turn.requestId, conversationId: state.conversation!.id, role: 'user', content: input.content })
  state.revision += 10
  if (delivery === 'accepted') {
    state.sessionState = 'active'
    state.activeTurn = { requestId: turn.requestId, nativeTurnId: 'accepted-turn', startedAt: turn.createdAt }
  } else if (delivery === 'queued') {
    state.sessionState = 'active'
    state.activeTurn = structuredClone(agentChatFixtures.active.activeTurn)
    state.turns[0]!.delivery = 'accepted'
  } else if (delivery === 'unknown') state.sessionState = 'uncertain'
  return state
}

afterEach(() => {
  useConversationDraftStore.getState().clearAllDrafts()
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('F6 B-R01 receipt readback', () => {
  for (const transport of ['GET', 'SSE'] as const) {
    for (const delivery of ['queued', 'accepted', 'completed'] as const) {
      it.each([false, true])(`${transport} ${delivery} receipt reconciles a lost acknowledgement (edited draft: %s)`, async (edited) => {
        installChatSource()
        // GET also covers the first-message transition from no conversation to a persisted one.
        const mounted = mountChat(transport === 'GET' ? agentChatFixtures.empty : agentChatFixtures.idleAfterCompletion)
        await mounted.ready()
        if (transport === 'SSE') await waitFor(() => expect(AgentChatTestSource.instances).toHaveLength(1))
        const sent: SendAgentChatMessageRequest[] = [], post = gate()
        server.use(http.post(messagePath, async ({ request }) => {
          sent.push(await request.json() as SendAgentChatMessageRequest)
          await post.promise
          return HttpResponse.error()
        }))
        write('Admitted despite lost acknowledgement')
        await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
        await waitFor(() => expect(sent).toHaveLength(1))
        if (edited) write('My next draft, edited while the request was pending')
        const recovered = receiptState(sent[0]!, delivery)
        if (transport === 'GET') mounted.mock.setState(recovered)
        await act(async () => { post.release() })
        if (transport === 'SSE') {
          await screen.findByLabelText('Unknown')
          if (!edited) {
            fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter' })
            await screen.findByText(/review the warning/)
          }
          mounted.mock.setState(recovered)
          act(() => AgentChatTestSource.instances[0]!.snapshot(recovered))
        }
        const label = { queued: 'Queued', accepted: 'Delivered', completed: 'Completed' }[delivery]
        await screen.findAllByLabelText(label).then(items => items.at(-1)!)
        const input = screen.getByRole('textbox', { name: 'Message' })
        await waitFor(() => expect(input).toHaveValue(edited ? 'My next draft, edited while the request was pending' : ''))
        expect(screen.queryAllByLabelText('Unknown')).toHaveLength(0)
        expect(screen.queryByText(/review the warning/)).not.toBeInTheDocument()
        if (!edited) {
          expect(screen.getByRole('button', { name: delivery === 'completed' ? 'Send message' : 'Queue message' })).toBeDisabled()
          await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
        }
        expect(sent).toHaveLength(1)
        // A later equal-text draft is intentional; repeated receipt readback must not erase it.
        write(sent[0]!.content)
        mounted.mock.setState({ ...recovered, revision: recovered.revision + 1 })
        await act(() => mounted.refresh())
        expect(input).toHaveValue(sent[0]!.content)
        expect(sent).toHaveLength(1)
      })
    }
  }

  it.each(['lost acknowledgement', 'successful unknown response'] as const)('retains unknown resend protection outside the message cut after %s', async (outcome) => {
    const mounted = mountChat(agentChatFixtures.idleAfterCompletion)
    await mounted.ready()
    const sent: SendAgentChatMessageRequest[] = []
    server.use(http.post(messagePath, async ({ request }) => {
      const input = await request.json() as SendAgentChatMessageRequest
      sent.push(input)
      const state = receiptState(input, sent.length === 1 ? 'unknown' : 'accepted')
      state.messages = state.messages.filter((message) => message.requestId !== input.requestId)
      state.hasEarlierMessages = true
      mounted.mock.setState(state)
      if (sent.length === 1 && outcome === 'lost acknowledgement') return HttpResponse.error()
      return HttpResponse.json({ state, turn: state.turns.at(-1), replayed: false })
    }))
    write('This text is outside the current page')
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findAllByLabelText('Unknown').then(items => items.at(-1)!)
    const input = screen.getByRole('textbox', { name: 'Message' })
    expect(input).toHaveValue('This text is outside the current page')
    fireEvent.keyDown(input, { key: 'Enter' })
    await screen.findByText(/review the warning/)
    expect(sent).toHaveLength(1)
    const outside = screen.getByRole('region', { name: 'Messages outside the current history page' })
    expect(within(outside).getByText('This text is outside the current page')).toBeInTheDocument()
    await userEvent.click(within(outside).getByRole('button', { name: 'Send again as new message' }))
    const warning = screen.getByRole('alertdialog')
    expect(within(warning).getByText(/original message may already have been accepted/)).toBeInTheDocument()
    expect(sent).toHaveLength(1)
    await userEvent.click(within(warning).getByRole('button', { name: 'Send as new message' }))
    await waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1]!.requestId).not.toBe(sent[0]!.requestId)
    expect(sent[1]!.content).toBe(sent[0]!.content)
  })
})

// Server-array order, no timestamps and no usable pagination information in app ids.
const numberedMessage = (n: number, conversationId: string): Message => ({ id: `opaque-${n * 7919 % 65537}`, conversationId,
  role: n % 2 ? 'user' : 'assistant', content: `message ${n}`, nativeMessageComplete: true })
const transcriptText = () => Array.from(within(screen.getByRole('list', { name: 'Conversation history' })).getAllByText(/^message \d+$/))
  .map((element) => element.textContent)

describe('F6 B-R02 history bootstrap and ordering', () => {
  it('one click loads genuinely earlier messages across the real latest-100 / page-50 boundary, including a concurrent new message', async () => {
    const initial: AgentChatState = structuredClone(agentChatFixtures.idleAfterCompletion)
    const all = Array.from({ length: 200 }, (_, i) => numberedMessage(i + 1, initial.conversation!.id))
    initial.messages = all.slice(-100); initial.turns = []; initial.hasEarlierMessages = true
    const mounted = mountChat(initial)
    await mounted.ready()
    expect(transcriptText()).toEqual(all.slice(100).map((message) => message.content))
    const cursors: (string | null)[] = []
    server.use(http.get(historyPath, async ({ request }) => {
      const params = new URL(request.url).searchParams, before = params.get('before')
      expect(params.get('limit')).toBe('50')
      cursors.push(before)
      if (before === '151') {
        all.push(numberedMessage(201, initial.conversation!.id))
        mounted.mock.setState({ ...initial, revision: initial.revision + 1, messages: all.slice(-100) })
        await mounted.refresh()
      }
      const end = before === null ? all.length : Number(before) - 1
      return HttpResponse.json({ conversationId: initial.conversation!.id, messages: all.slice(Math.max(0, end - 50), end),
        nextCursor: end > 50 ? String(end - 49) : null })
    }))
    await userEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }))
    await screen.findByText('message 51')
    expect(cursors).toEqual([null, '151', '101'])
    expect(transcriptText()).toEqual(all.slice(50).map((message) => message.content))
    expect(screen.getAllByText('message 201', { selector: '.conversation-message-content, .conversation-message-content p' })).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }))
    await screen.findByText('message 1')
    expect(cursors).toEqual([null, '151', '101', '51'])
    expect(transcriptText()).toEqual(all.map((message) => message.content))
    expect(screen.queryByRole('button', { name: 'Load earlier messages' })).not.toBeInTheDocument()
  })
})

describe('F6 B-R03 denied history', () => {
  it('hides cached history, messages, activity, approval and draft after history 403; a stale GET and later network error cannot reveal them', async () => {
    const initial = approvalState(); initial.hasEarlierMessages = true
    const mounted = mountChat(initial)
    await mounted.ready(); write('Keep this protected local draft')
    const older: Message = { id: 'older-protected', conversationId: initial.conversation!.id, role: 'user', content: 'Protected earlier history' }
    let pages = 0
    server.use(http.get(historyPath, () => {
      if (++pages === 1) return HttpResponse.json({ conversationId: initial.conversation!.id, messages: [older, ...initial.messages], nextCursor: '40' })
      return HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'History access was revoked.' } }, { status: 403 })
    }))
    await userEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }))
    await screen.findByText('Protected earlier history')
    const pendingRead = gate(); let readStarted = false
    server.use(http.get(root, async () => { readStarted = true; await pendingRead.promise; return HttpResponse.json(initial) }))
    let refresh!: Promise<void>
    act(() => { refresh = mounted.refresh() })
    await waitFor(() => expect(readStarted).toBe(true))
    await userEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }))
    await screen.findByText('Agent chat access unavailable')
    const assertHidden = () => {
      expect(screen.queryByText('Protected earlier history')).not.toBeInTheDocument()
      expect(screen.queryByText('Summarize the repository.')).not.toBeInTheDocument()
      expect(screen.queryByText('Reading the README')).not.toBeInTheDocument()
      expect(screen.queryByRole('region', { name: 'Agent approval request' })).not.toBeInTheDocument()
      expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
      expect(document.querySelector('.operator-tool-activity')).toBeNull()
    }
    assertHidden()
    await act(async () => { pendingRead.release(); await refresh })
    assertHidden()
    server.use(http.get(root, () => HttpResponse.error()))
    await act(() => mounted.refresh())
    assertHidden()
    expect(getConversationDraft(agentChatContextKey(initial.context))).toBe('Keep this protected local draft')
    server.use(http.get(root, () => HttpResponse.json(initial)))
    await act(() => mounted.refresh())
    await screen.findByText('Protected earlier history')
    expect(screen.getByRole('region', { name: 'Agent approval request' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep this protected local draft')
  })
})

function toolHeavyState(turnCount: number, completed: boolean): AgentChatState {
  const state: AgentChatState = structuredClone(agentChatFixtures.idleAfterCompletion)
  state.messages = []; state.activities = []; state.turns = []; state.revision += turnCount * 2 + Number(completed)
  for (let turn = 1; turn <= turnCount; turn++) {
    const requestId = `request-heavy-${turn}`
    state.messages.push({ id: `user-heavy-${turn}`, conversationId: state.conversation!.id, requestId, role: 'user', content: `Heavy prompt ${turn}` })
    if (turn < turnCount || completed) state.messages.push({ id: `reply-heavy-${turn}`, conversationId: state.conversation!.id, requestId,
      role: 'assistant', nativeMessageComplete: true, content: `Completed reply ${turn}` })
    for (let tool = 1; tool <= 24; tool++) state.activities.push({ id: `activity-${turn}-${tool}`, requestId,
      sequence: String((turn - 1) * 24 + tool), revision: 1, kind: 'tool', title: `Public tool ${turn}/${tool}`, status: 'completed' })
  }
  state.sessionState = completed ? 'idle' : 'active'
  state.activeTurn = completed ? null : { requestId: `request-heavy-${turnCount}`, nativeTurnId: 'heavy-native-turn', startedAt: state.conversation!.createdAt }
  return state
}
function ChatPopover({ client, state }: { client: QueryClient; state: AgentChatState }) {
  const anchor = useRef<HTMLButtonElement>(null)
  return <QueryClientProvider client={client}><button ref={anchor}>Agent node</button>
    <AgentPopover open anchor={anchor} title="Coder" panel="chat" onClose={() => {}}
      settings={null} info={null} chat={<AgentChatPanel name="Coder" context={state.context} activity="Current activity" running />} />
  </QueryClientProvider>
}

describe('F6 B-R04 completed replies remain the following target', () => {
  it.each([320, 1280])('places tool-heavy turns before their replies in the real popover at width %s; follow/jump work without moving a browsing user', async (width) => {
    vi.stubGlobal('innerWidth', width)
    const initial = toolHeavyState(3, false), mock = createAgentChatMock(initial)
    server.use(...mock.handlers)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(<ChatPopover client={client} state={initial} />)
    await screen.findByText('Heavy prompt 3')
    const scroll = screen.getByRole('region', { name: 'Agent conversation transcript' })
    expect(scroll.closest('.n-agent-popover')).not.toBeNull()
    // jsdom supplies no layout: these metrics exercise the real scroll handler, not browser geometry.
    const rows = () => [...scroll.querySelectorAll('.agent-chat-tool, .conversation-message-content')]
    const height = width === 320 ? 160 : 240
    let top = 0
    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, get: () => rows().length * 40 },
      clientHeight: { configurable: true, value: height },
      scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, scroll.scrollHeight - height)) } },
    })
    const refresh = (state: AgentChatState) => {
      mock.setState(state)
      return client.invalidateQueries({ queryKey: agentChatStateKey(state.context) })
    }
    const assertLatestAtBottom = (text: string) => {
      const reply = within(scroll).getByText(text, { selector: '.conversation-message-content, .conversation-message-content p' })
        .closest('.conversation-message-content')!
      for (const tool of scroll.querySelectorAll('.agent-chat-tool')) {
        expect(tool.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
      }
      expect(rows().at(-1)).toBe(reply)
      const replyTop = rows().indexOf(reply) * 40
      expect(replyTop).toBeGreaterThanOrEqual(top)
      expect(replyTop + 40).toBeLessThanOrEqual(top + height)
    }
    await act(() => refresh(toolHeavyState(3, true)))
    await within(scroll).findByText('Completed reply 3', { selector: '.conversation-message-content, .conversation-message-content p' })
    assertLatestAtBottom('Completed reply 3')
    scroll.scrollTop = 0; fireEvent.scroll(scroll)
    await act(() => refresh(toolHeavyState(4, true)))
    expect(scroll.scrollTop).toBe(0)
    await userEvent.click(await screen.findByRole('button', { name: 'Jump to latest' }))
    await within(scroll).findByText('Completed reply 4', { selector: '.conversation-message-content, .conversation-message-content p' })
    assertLatestAtBottom('Completed reply 4')
  })
})
