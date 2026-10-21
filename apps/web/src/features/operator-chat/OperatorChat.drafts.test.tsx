import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SendOperatorMessageRequestSchema, type OperatorConversationState } from '@foreman-code/contracts'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { installBrowserLocks } from '../../test/browserLocks'
import { deferred } from '../../test/deferred'
import { subscribeOperatorChat } from '../../shared/api/operatorChatStream'
import { useConversationDraftStore } from '../conversations'
import { OperatorChat } from './OperatorChat'
import { OperatorChatVisibilityProvider } from './visibility'
import { useOperatorChatStore } from './operatorChatStore'
import { summarizeOperatorConversation } from './operatorChatStatus'
import { operatorState } from './pr17-test-fixtures'

vi.mock('../../shared/api/operatorChatStream', () => ({ subscribeOperatorChat: vi.fn(() => () => {}) }))

const clients: QueryClient[] = []
let states: Map<string, OperatorConversationState>
let restoreLocks: () => void

function renderChat() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  return render(<QueryClientProvider client={client}>
    <OperatorChatVisibilityProvider enabled><OperatorChat /></OperatorChatVisibilityProvider>
  </QueryClientProvider>)
}

function snapshot(id: string) {
  const subscription = vi.mocked(subscribeOperatorChat).mock.calls.filter(([conversationId]) => conversationId === id).at(-1)
  expect(subscription).toBeDefined()
  act(() => subscription![1].snapshot(states.get(id)!))
}

function history() {
  return within(screen.getByRole('navigation', { name: 'Conversations' }))
}

async function openDraft() {
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
  await waitFor(() => expect(useOperatorChatStore.getState().selectedConversationId).toBe('draft-chat'))
  expect(await screen.findByRole('textbox', { name: 'Message' })).toHaveValue('')
  snapshot('draft-chat')
}

beforeEach(() => {
  vi.clearAllMocks()
  restoreLocks = installBrowserLocks()
  useConversationDraftStore.getState().clearAllDrafts()
  useOperatorChatStore.getState().reset()
  useOperatorChatStore.setState({ open: true, selectedConversationId: 'conversation-one' })
  const saved = operatorState({ turnState: 'idle', activeRequestId: null })
  states = new Map([[saved.conversation.id, saved]])
  server.use(
    http.get('/api/operator/conversations/summaries', () => HttpResponse.json({
      conversations: [...states.values()].filter(state => state.messages.length || state.hasEarlierMessages)
        .map(summarizeOperatorConversation),
    })),
    http.post('/api/operator/conversations', () => {
      const draft = operatorState({ conversation: { ...saved.conversation, id: 'draft-chat', title: 'New conversation' },
        messages: [], revision: 0, turnState: 'idle', activeRequestId: null })
      states.set(draft.conversation.id, draft)
      return HttpResponse.json({ conversation: draft.conversation }, { status: 201 })
    }),
    http.get('/api/operator/conversations/:conversationId', ({ params }) =>
      HttpResponse.json(states.get(String(params.conversationId)))),
    http.post('/api/operator/conversations/:conversationId/messages', async ({ params, request }) => {
      const command = SendOperatorMessageRequestSchema.parse(await request.json())
      const id = String(params.conversationId)
      const draft = states.get(id)!
      const state: OperatorConversationState = { ...draft, revision: draft.revision + 1,
        conversation: { ...draft.conversation, title: command.content },
        messages: [{ id: 'first-message', conversationId: id, requestId: command.requestId,
          role: 'user', content: command.content }] }
      states.set(id, state)
      return HttpResponse.json({ state, replayed: false }, { status: 202 })
    }),
  )
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach(client => client.clear())
  restoreLocks()
})

describe('Operator draft chat history', () => {
  it('keeps an empty stream snapshot hidden while the history refresh is pending', async () => {
    renderChat()
    fireEvent.click(screen.getByRole('button', { name: 'Open history' }))
    await history().findByRole('button', { name: /^First conversation/ })
    await openDraft()
    const refresh = deferred<void>()
    const refreshStarted = deferred<void>()
    server.use(http.get('/api/operator/conversations/summaries', async () => {
      refreshStarted.resolve()
      await refresh.promise
      return HttpResponse.json({ conversations: [summarizeOperatorConversation(states.get('conversation-one')!)] })
    }))
    try {
      snapshot('draft-chat')
      await refreshStarted.promise
      expect(history().queryByRole('button', { name: /New conversation/ })).not.toBeInTheDocument()
      expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('')
    } finally {
      refresh.resolve()
    }
  })

  it('keeps an empty New chat out of history when switching chats and reopening the interface', async () => {
    const view = renderChat()
    fireEvent.click(screen.getByRole('button', { name: 'Open history' }))
    await history().findByRole('button', { name: /^First conversation/ })
    await openDraft()
    expect(history().queryByRole('button', { name: /New conversation/ })).not.toBeInTheDocument()
    expect(history().getAllByRole('button', { name: /^(First conversation|New conversation)/ })).toHaveLength(1)

    fireEvent.click(history().getByRole('button', { name: /^First conversation/ }))
    await waitFor(() => expect(useOperatorChatStore.getState().selectedConversationId).toBe('conversation-one'))
    view.unmount()
    renderChat()
    await history().findByRole('button', { name: /^First conversation/ })
    expect(history().queryByRole('button', { name: /New conversation/ })).not.toBeInTheDocument()
    expect(history().getAllByRole('button', { name: /^(First conversation|New conversation)/ })).toHaveLength(1)
  })

  it('keeps a selected empty draft hidden after remount and lists it with its title on first send', async () => {
    const view = renderChat()
    fireEvent.click(screen.getByRole('button', { name: 'Open history' }))
    await history().findByRole('button', { name: /^First conversation/ })
    await openDraft()
    expect(history().queryByRole('button', { name: /New conversation/ })).not.toBeInTheDocument()
    view.unmount()
    renderChat()
    const message = await screen.findByRole('textbox', { name: 'Message' })
    expect(message).toHaveValue('')
    snapshot('draft-chat')
    expect(history().queryByRole('button', { name: /New conversation/ })).not.toBeInTheDocument()
    fireEvent.change(message, { target: { value: 'Plan the workspace' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    expect(await history().findByRole('button', { name: /^Plan the workspace/ })).toBeInTheDocument()
    expect(history().getAllByRole('button', { name: /^(First conversation|Plan the workspace|New conversation)/ })).toHaveLength(2)
    expect(history().queryByRole('button', { name: /New conversation/ })).not.toBeInTheDocument()
  })

  it('retains a conversation whose loaded message window is empty but has earlier messages', async () => {
    const saved = states.get('conversation-one')!
    states.set('conversation-one', { ...saved, messages: [], hasEarlierMessages: true })
    renderChat()
    fireEvent.click(screen.getByRole('button', { name: 'Open history' }))
    await history().findByRole('button', { name: /^First conversation/ })
    snapshot('conversation-one')
    expect(history().getByRole('button', { name: /^First conversation/ })).toBeInTheDocument()
  })
})
