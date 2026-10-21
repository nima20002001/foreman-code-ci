import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
import { findOperatorComposer, installCanonicalOperatorFixture } from './canonicalOperator.test-support'
import { OperatorTranscript } from './OperatorTranscript'
import { OperatorChatVisibilityProvider } from './visibility'
import { useOperatorChatStore } from './operatorChatStore'
import { summarizeOperatorConversation } from './operatorChatStatus'
import { operatorState } from './pr17-test-fixtures'

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
beforeEach(installCanonicalOperatorFixture)
beforeEach(() => {
  vi.clearAllMocks()
  useOperatorChatStore.setState({ open: false, historyOpen: false, selectedConversationId: 'conversation-one' })
  useConversationDraftStore.getState().clearAllDrafts()
  vi.mocked(listOperatorConversationSummaries).mockResolvedValue({ conversations: [summarizeOperatorConversation(operatorState())] })
  vi.mocked(getOperatorConversation).mockImplementation(async (id) => operatorState({ conversation: { ...operatorState().conversation, id } }))
})
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()); vi.unstubAllGlobals() })

describe('Operator chat interactions', () => {
  it('does no hidden history polling and reads attention when opened', async () => {
    renderChat()
    expect(listOperatorConversationSummaries).not.toHaveBeenCalled()
    expect(getOperatorConversation).not.toHaveBeenCalled()
    const pending = { ...summarizeOperatorConversation(operatorState()), conversationId: 'decision-chat', needsAttention: true }
    vi.mocked(listOperatorConversationSummaries).mockResolvedValue({ conversations: [pending] })
    fireEvent.click(screen.getByRole('button', { name: 'Open Operator chat' }))
    await waitFor(() => expect(listOperatorConversationSummaries).toHaveBeenCalled())
    // The launcher is hidden while the chat is open, so the decision shows on the conversation's history entry.
    expect(await screen.findByLabelText('Needs your decision')).toBeInTheDocument()
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
  it('keeps active drafting editable and exposes separate live delivery and active-only Stop', async () => {
    useOperatorChatStore.setState({ open: true })
    renderChat()
    const textarea = await findOperatorComposer()
    expect(textarea).not.toBeDisabled()
    fireEvent.change(textarea, { target: { value: 'My next message' } })
    expect(await screen.findByRole('button', { name: 'Stop active turn' })).toBeEnabled()
    await waitFor(() => expect(screen.getByRole('button', { name: /Steer now|Queue next/ })).toBeEnabled())
    expect(useConversationDraftStore.getState().drafts['conversation-one']).toBe('My next message')
    expect(sendOperatorMessage).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Delivery action'), { target: { value: 'interrupt_and_send' } })
    expect(sendOperatorMessage).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Interrupt and send' })).toBeEnabled()
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
      const textarea = await findOperatorComposer()
      fireEvent.change(textarea, { target: { value: 'Audit ping. Do not call tools.' } })
      await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled())
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
      await screen.findByText(reason)
      expect(sendOperatorMessage).toHaveBeenCalledTimes(1)

      cleanup()
      renderChat()
      expect(await screen.findByRole('button', { name: 'Retry original message' })).toBeEnabled()
      expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Audit ping. Do not call tools.')
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
    act(() => listeners.event({ id: 1, type: 'delta', conversationId: 'conversation-one', data: { scopeRevision: '2', message: {
      id: 'final', conversationId: 'conversation-one', requestId: 'request-one', role: 'assistant',
      activityNative: { harness: 'codex', sessionId: 'native-session', turnId: 'native-turn', itemId: 'answer' },
      nativeMessageId: 'answer', nativeMessageComplete: false, content: 'Streaming reply', revision: '1', sequence: '2',
    } } }))
    expect(await screen.findByText('Streaming reply')).toBeInTheDocument()
    vi.mocked(getOperatorConversation).mockImplementation(() => new Promise(() => {}))
    act(() => listeners.event({ id: 2, type: 'message', conversationId: 'conversation-one', data: { requestId: 'request-one' } }))
    expect(screen.getByText('Streaming reply')).toBeInTheDocument()
    act(() => listeners.snapshot(operatorState({ revision: 2, turnState: 'idle', activeRequestId: null,
      messages: [{ id: 'final', conversationId: 'conversation-one', requestId: 'request-one', role: 'assistant',
        nativeMessageId: 'answer', nativeMessageComplete: true, content: 'Streaming reply', revision: '2', sequence: '2' }] })))
    await waitFor(() => {
      expect(screen.getAllByText('Streaming reply')).toHaveLength(1)
      expect(screen.queryByLabelText('Operator is typing')).not.toBeInTheDocument()
    })
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
