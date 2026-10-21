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

describe('dbg', () => {
  it('keeps streaming text visible until the persisted final reply replaces it', async () => {
    useOperatorChatStore.setState({ open: true })
    const client = renderChat()
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
    const data = client.getQueryData<any>(['operator-chat', 'conversation', 'conversation-one'])
    console.error('DBGSTATE', JSON.stringify({ turnState: data?.turnState, revision: data?.revision, active: data?.activeRequestId,
      snapRev: data?.activitySnapshot?.revision, hasSnap: !!data?.activitySnapshot, msgs: data?.messages?.map((m: any) => [m.id, m.nativeMessageComplete, m.content]) }))
    console.error('DBGKEYS', JSON.stringify(client.getQueryCache().getAll().map(q => q.queryKey)))
    expect(screen.getAllByText('Streaming reply')).toHaveLength(1)
    expect(screen.queryByLabelText('Operator is typing')).not.toBeInTheDocument()
  })
})
