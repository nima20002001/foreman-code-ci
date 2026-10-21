// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_INTERACTION_FIXTURES, type OperatorConversationState } from '@foreman-code/contracts'
import { OperatorChat } from './OperatorChat'
import { useOperatorChatStore } from './operatorChatStore'

const api = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), create: vi.fn(), clearDraft: vi.fn() }))
vi.mock('../../shared/api/client', async (original) => ({ ApiError: (await original<typeof import('../../shared/api/client')>()).ApiError, getOperatorConversation: api.get, createOperatorConversation: api.create, sendOperatorMessage: vi.fn(), cancelOperatorTurn: vi.fn(), respondOperatorInteraction: vi.fn() }))
vi.mock('../../shared/api/operatorChatSummaries', () => ({ listOperatorConversationSummaries: api.list }))
vi.mock('../../shared/api/operatorChatStream', () => ({ subscribeOperatorChat: () => () => {} }))
vi.mock('../../shared/api/sessionBoundary', async (original) => ({ ...(await original<typeof import('../../shared/api/sessionBoundary')>()), sessionGeneration: () => 1, sessionIsSwitching: () => false }))
vi.mock('./useOperatorChatVisibility', () => ({ useOperatorChatVisibility: () => true }))
vi.mock('./operatorOutbox', () => ({ readPendingOperatorMessage: () => ({}), reserveOperatorMessage: vi.fn(), acknowledgeOperatorMessage: vi.fn(), assertOperatorMessageReserved: vi.fn() }))
vi.mock('./OperatorComposer', () => ({ OperatorComposer: ({ conversationId }: { conversationId: string }) => <div data-testid="composer">Composer for {conversationId}</div> }))
vi.mock('../conversations', () => ({
  ConversationHistory: ({ messages }: { messages: { id: string; content: string }[] }) => <div>{messages.map((message) => <p key={message.id}>{message.content}</p>)}</div>,
  ConversationComposer: ({ conversationId }: { conversationId: string }) => <div data-testid="composer">Composer for {conversationId}</div>,
  useConversationDraftStore: (selector: (value: { clearDraft: typeof api.clearDraft }) => unknown) => selector({ clearDraft: api.clearDraft }),
}))
// This UI fixture includes the fields exercised here; API schema tests cover transport validation.
const state = {
  conversation: { id: 'c1', title: 'Deployment investigation', agentId: 'operator', scope: 'application', operatorConfigurationVersionId: 'operator-v1' },
  messages: [{ id: 'm1', conversationId: 'c1', role: 'assistant', content: 'Previously loaded context' }],
  turnState: 'idle', revision: 1,
} satisfies Partial<OperatorConversationState>
const summary = { conversationId: 'c1', title: state.conversation.title, turnState: 'idle' as const, revision: 1, activeRequestId: null, needsAttention: false }
const listKey = ['operator-chat', 'summaries']
const detailKey = ['operator-chat', 'conversation', 'c1']
let client: QueryClient
beforeEach(() => {
  vi.clearAllMocks()
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
  useOperatorChatStore.setState({ open: true, historyOpen: true, selectedConversationId: undefined })
  api.list.mockResolvedValue({ conversations: [] })
  api.get.mockResolvedValue(state)
})
afterEach(() => { cleanup(); client.clear(); useOperatorChatStore.setState({ open: false, historyOpen: false, selectedConversationId: undefined }) })
const mount = () => render(<QueryClientProvider client={client}><OperatorChat /></QueryClientProvider>)
describe('PR17 Operator chat recovery', () => {
  it('distinguishes loading history from an empty list', async () => {
    let resolve!: (value: { conversations: [] }) => void
    api.list.mockReturnValue(new Promise((done) => { resolve = done }))
    mount()
    expect(screen.getByText('Loading conversation history…')).toBeInTheDocument()
    await act(async () => { resolve({ conversations: [] }) })
    expect(await screen.findByText('No conversations yet. Start a new chat.')).toBeInTheDocument()
    expect(screen.queryByText('Loading conversation history…')).not.toBeInTheDocument()
  })
  it('provides a direct history retry without discarding cached conversations', async () => {
    client.setQueryData(listKey, { conversations: [summary] })
    api.list.mockRejectedValue(new Error('offline'))
    mount()
    await act(async () => { await client.invalidateQueries({ queryKey: listKey }) })
    expect(await screen.findByText(/Previously loaded conversations are still shown/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Deployment investigation/ })).toBeInTheDocument()
    api.list.mockResolvedValue({ conversations: [summary] })
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry history' }))
    expect(api.list).toHaveBeenCalledTimes(2)
  })
  it('keeps messages available after a failed refresh and offers conversation retry', async () => {
    useOperatorChatStore.setState({ selectedConversationId: 'c1' })
    client.setQueryData(detailKey, state)
    api.get.mockRejectedValue(new Error('offline'))
    mount()
    await act(async () => { await client.invalidateQueries({ queryKey: detailKey }) })
    expect(await screen.findByText(/Previously loaded messages are still shown/)).toBeInTheDocument()
    expect(screen.getByText('Previously loaded context')).toBeInTheDocument()
    api.get.mockResolvedValue(state)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry conversation' }))
    expect(api.get).toHaveBeenCalledTimes(2)
  })
  it('identifies the conversation and switches through the history sidebar', async () => {
    const second = { ...state, conversation: { ...state.conversation, id: 'c2', title: 'Release plan' }, messages: [] }
    useOperatorChatStore.setState({ historyOpen: false, selectedConversationId: 'c1' })
    client.setQueryData(listKey, { conversations: [summary, { ...summary, conversationId: 'c2', title: second.conversation.title }] })
    client.setQueryData(detailKey, state)
    client.setQueryData(['operator-chat', 'conversation', 'c2'], second)
    mount()
    expect(screen.queryByRole('button', { name: /^Deployment investigation/ })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Operator conversation history')).toHaveAttribute('inert')
    expect(screen.getByLabelText('Operator conversation history')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByLabelText('Switch conversation')).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open history' }))
    await userEvent.setup().click(screen.getByRole('button', { name: /^Release plan/ }))
    expect(screen.getByRole('button', { name: /^Release plan/ })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('composer')).toHaveTextContent('c2')
  })
  it('presents the native operation in the transcript with collapsed details', () => {
    useOperatorChatStore.setState({ selectedConversationId: 'c1' })
    client.setQueryData(detailKey, { ...state, turnState: 'active', activeRequestId: 'request-1', responseDelivery: 'offered', pendingInteraction: {
      session: { harness: 'codex', providerVersion: 'test', nativeSessionId: 'native-session' },
      turn: { nativeTurnId: 'native-turn', nativeRequestId: 'native-request' }, nativeRequestType: 'item/commandExecution/requestApproval',
      request: { command: ['pnpm', 'test'], cwd: '/project' }, responseOptions: NATIVE_INTERACTION_FIXTURES.codex.responseOptions,
    } })
    mount()
    expect(screen.getByRole('heading', { name: 'Run a command' })).toBeInTheDocument()
    expect(screen.getByText('pnpm test')).toBeInTheDocument()
    expect(screen.getByText('Request details').closest('details')).not.toHaveAttribute('open')
    expect(screen.getByLabelText('Operator transcript')).toContainElement(screen.getByLabelText('Operator approval request'))
  })
})
