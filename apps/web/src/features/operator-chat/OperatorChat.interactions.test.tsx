import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionControlStateSchema, unavailableSessionControls, type OperatorConversationState } from '@foreman-code/contracts'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { getOperatorConversation, sendOperatorMessage } from '../../shared/api/client'
import { subscribeOperatorChat } from '../../shared/api/operatorChatStream'
import { listOperatorConversationSummaries } from '../../shared/api/operatorChatSummaries'
import { useConversationDraftStore } from '../conversations'
import { ConversationComposer } from '../conversations/ConversationComposer'
import { OperatorChat } from './OperatorChat'
import { OperatorTranscript } from './OperatorTranscript'
import { OperatorChatVisibilityProvider } from './visibility'
import { useOperatorChatStore } from './operatorChatStore'
import { summarizeOperatorConversation } from './operatorChatStatus'
import { operatorState } from './pr17-test-fixtures'
import { readPendingOperatorMessage } from './operatorOutbox'

vi.mock('../../shared/api/client', async (original) => ({ ...await original<typeof import('../../shared/api/client')>(),
  getOperatorConversation: vi.fn(), sendOperatorMessage: vi.fn(),
}))
vi.mock('../../shared/api/operatorChatSummaries', () => ({ listOperatorConversationSummaries: vi.fn() }))
vi.mock('../../shared/api/operatorChatStream', () => ({ subscribeOperatorChat: vi.fn((_id, listeners) => {
  listeners.connection?.('connected'); return () => {}
}) }))
const clients: QueryClient[] = []
function renderChat() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><button>Before chat</button><OperatorChatVisibilityProvider enabled><OperatorChat /></OperatorChatVisibilityProvider><button>After chat</button></QueryClientProvider>)
  return client
}
beforeEach(() => {
  vi.clearAllMocks()
  useOperatorChatStore.setState({ open: false, historyOpen: false, selectedConversationId: 'conversation-one' })
  useConversationDraftStore.getState().clearAllDrafts()
  vi.mocked(listOperatorConversationSummaries).mockResolvedValue({ conversations: [summarizeOperatorConversation(operatorState())] })
  vi.mocked(getOperatorConversation).mockImplementation(async (id) => operatorState({ conversation: { ...operatorState().conversation, id } }))
})
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()); vi.unstubAllGlobals() })

describe('Operator chat interactions', () => {
  it('polls attention while closed without downloading message histories', async () => {
    const client = renderChat()
    await waitFor(() => expect(listOperatorConversationSummaries).toHaveBeenCalled())
    expect(getOperatorConversation).not.toHaveBeenCalled()
    const pending = { ...summarizeOperatorConversation(operatorState()), conversationId: 'decision-chat', needsAttention: true }
    vi.mocked(listOperatorConversationSummaries).mockResolvedValue({ conversations: [pending] })
    await act(() => client.invalidateQueries({ queryKey: ['operator-chat', 'summaries'] }))
    const launcher = await screen.findByRole('button', { name: /1 conversation need your decision/ })
    fireEvent.click(launcher)
    await waitFor(() => expect(getOperatorConversation).toHaveBeenCalledWith('decision-chat', expect.anything()))
    expect(useOperatorChatStore.getState().selectedConversationId).toBe('decision-chat')
  })
  it('focuses the nonmodal chat and restores its retained launcher on Escape', async () => {
    renderChat()
    const launcher = screen.getByRole('button', { name: 'Open Operator chat' })
    fireEvent.click(launcher)
    expect(screen.getByRole('dialog', { name: 'Operator chat' })).toHaveAttribute('aria-modal', 'false')
    expect(screen.getByRole('button', { name: 'Close Operator chat' })).toHaveFocus()
    expect(launcher).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close Operator chat' }), { key: 'Escape' })
    await waitFor(() => expect(launcher).toHaveFocus())
    expect(launcher).toHaveAttribute('aria-expanded', 'false')
  })
  it('allows drafting, but not sending, while the Operator is active', async () => {
    useOperatorChatStore.setState({ open: true })
    renderChat()
    const textarea = await screen.findByRole('textbox', { name: 'Message' })
    expect(textarea).not.toBeDisabled()
    fireEvent.change(textarea, { target: { value: 'My next message' } })
    expect(screen.getByRole('button', { name: 'Stop response' })).toBeEnabled()
    expect(useConversationDraftStore.getState().drafts['conversation-one']).toBe('My next message')
    expect(sendOperatorMessage).not.toHaveBeenCalled()
    const user = userEvent.setup()
    textarea.focus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Stop response' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: /Agent settings:/ })).toHaveFocus()
  })
  it('keeps context-left in the header beside Close, showing the model window before the first turn', async () => {
    server.use(http.get('/api/operator/conversations/:conversationId/session-controls', ({ params }) =>
      HttpResponse.json(SessionControlStateSchema.parse({
        conversationId: String(params.conversationId), revision: 0, profileKey: 'profile', desiredMode: 'regular',
        appliedMode: null, defaults: {}, desired: {}, applied: null, applicability: 'next-turn', context: null,
        nativeSessionId: null, nativeProviderVersion: null, compaction: null, compactions: [], busyReason: null,
        capabilities: { ...unavailableSessionControls('profile'), modelCapacity: 200000 },
      }))))
    useOperatorChatStore.setState({ open: true })
    renderChat()
    const close = await screen.findByRole('button', { name: 'Close Operator chat' })
    const context = await screen.findByRole('button', { name: '0% context' })
    expect(close.parentElement).toContainElement(context)
    const composer = within(screen.getByRole('form', { name: 'Conversation composer' }))
    expect(composer.queryByRole('button', { name: /context/i })).not.toBeInTheDocument()
    expect(composer.queryByRole('combobox', { name: 'Conversation mode' })).not.toBeInTheDocument()
    expect(screen.queryByText(/context unknown/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/starts on the next turn/)).not.toBeInTheDocument()
  })
  it('shows no context meter before the first turn when the model window is not known yet', async () => {
    useOperatorChatStore.setState({ open: true })
    renderChat()
    await screen.findByRole('button', { name: 'Close Operator chat' })
    await screen.findByRole('textbox', { name: 'Message' })
    expect(screen.queryByRole('button', { name: /context/i })).not.toBeInTheDocument()
  })
  it('keeps a rejected turn reason visible after reload without retrying it', async () => {
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
    window.localStorage.clear()
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
      request: async (_name: string, _options: LockOptions, work: (lock: Lock) => unknown) => work({ name: 'outbox', mode: 'exclusive' } as Lock),
    } })
    try {
      const reason = 'Persistent Codex chat requires an explicit experimental opt-in outside production; this provider is not production-qualified.'
      vi.mocked(getOperatorConversation).mockResolvedValue(operatorState({ turnState: 'idle', activeRequestId: null }))
      vi.mocked(sendOperatorMessage).mockRejectedValue(new Error(reason))
      useOperatorChatStore.setState({ open: true })
      renderChat()
      const textarea = await screen.findByRole('textbox', { name: 'Message' })
      fireEvent.change(textarea, { target: { value: 'Audit ping. Do not call tools.' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
      await waitFor(() => expect(readPendingOperatorMessage('conversation-one').sendFailure).toBe(reason))
      expect(screen.getByRole('alert')).toHaveTextContent(reason)
      expect(sendOperatorMessage).toHaveBeenCalledTimes(1)

      cleanup()
      renderChat()
      expect(await screen.findByRole('alert')).toHaveTextContent(reason)
      expect(screen.getByRole('button', { name: 'Retry pending message' })).toBeEnabled()
      expect(sendOperatorMessage).toHaveBeenCalledTimes(1)
    } finally {
      window.localStorage.clear()
      if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
      else Reflect.deleteProperty(navigator, 'locks')
    }
  })
  it('keeps streaming text visible until the persisted final reply replaces it', async () => {
    useOperatorChatStore.setState({ open: true })
    renderChat()
    await screen.findByRole('textbox', { name: 'Message' })
    const listeners = vi.mocked(subscribeOperatorChat).mock.calls.at(-1)![1]
    act(() => listeners.event({ id: 1, type: 'delta', conversationId: 'conversation-one', data: { activityChange: {
      schemaVersion: 1, owner: { kind: 'chat_request', conversationId: 'conversation-one', requestId: 'request-one' },
      native: { harness: 'codex', sessionId: 'native-session', turnId: 'native-turn', itemId: 'answer' },
      source: { schemaVersion: 1, system: 'codex', eventId: 'streaming-answer', observedAt: '2026-10-01T00:00:00Z' },
      change: { kind: 'text.append', itemId: 'answer', text: 'Streaming reply', finality: 'provisional' },
    } } }))
    expect(screen.getByText('Streaming reply')).toBeInTheDocument()
    vi.mocked(getOperatorConversation).mockImplementation(() => new Promise(() => {}))
    act(() => listeners.event({ id: 2, type: 'message', conversationId: 'conversation-one', data: { requestId: 'request-one' } }))
    expect(screen.getByText('Streaming reply')).toBeInTheDocument()
    act(() => listeners.snapshot(operatorState({ revision: 2, turnState: 'idle', activeRequestId: null,
      messages: [{ id: 'final', conversationId: 'conversation-one', requestId: 'request-one', role: 'assistant',
        nativeMessageId: 'answer', nativeMessageComplete: true, content: 'Streaming reply' }] })))
    expect(screen.getAllByText('Streaming reply')).toHaveLength(1)
    expect(screen.queryByLabelText('Operator is typing')).not.toBeInTheDocument()
  })
  it('closes the narrow history drawer after selecting a chat', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    useOperatorChatStore.setState({ open: true, historyOpen: true })
    renderChat()
    expect(useOperatorChatStore.getState().historyOpen).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Open history' }))
    fireEvent.click(await screen.findByRole('button', { name: /^First conversation/ }))
    expect(useOperatorChatStore.getState().historyOpen).toBe(false)
    expect(screen.queryByRole('complementary', { name: 'Operator conversation history' })).not.toBeInTheDocument()
  })
  it('keeps a newly edited draft when the previous message is acknowledged', () => {
    render(<ConversationComposer conversationId="draft-test" allowEditingWhileSending isSending onSubmit={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'New draft' } })
    act(() => useConversationDraftStore.getState().clearDraft('draft-test', 'Previous message'))
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('New draft')
  })
  it('preserves a reader position and offers an explicit jump to new output', () => {
    const messages: OperatorConversationState['messages'] = operatorState().messages
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    clients.push(client)
    const view = render(<QueryClientProvider client={client}><OperatorTranscript messages={messages} partialText="" /></QueryClientProvider>)
    const region = screen.getByRole('region', { name: 'Operator transcript' })
    Object.defineProperty(region, 'scrollHeight', { configurable: true, value: 1_000 })
    Object.defineProperty(region, 'clientHeight', { configurable: true, value: 200 })
    region.scrollTop = 100
    fireEvent.scroll(region)
    view.rerender(<QueryClientProvider client={client}><OperatorTranscript messages={messages} partialText="New response" /></QueryClientProvider>)
    expect(region.scrollTop).toBe(100)
    fireEvent.click(screen.getByRole('button', { name: /Jump to latest/ }))
    expect(region.scrollTop).toBe(1_000)
  })
})
