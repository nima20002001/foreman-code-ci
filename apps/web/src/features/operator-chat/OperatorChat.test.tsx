import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OperatorChat } from './OperatorChat'
import { OperatorChatVisibilityProvider } from './visibility'
import { useOperatorChatStore } from './operatorChatStore'
import { operatorState } from './pr17-test-fixtures'
import { ApiError } from '../../shared/api/client'

const api = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn(), list: vi.fn(), send: vi.fn() }))
vi.mock('../../shared/api/client', async (original) => ({ ...await original<typeof import('../../shared/api/client')>(),
  createOperatorConversation: api.create, getOperatorConversation: api.get, sendOperatorMessage: api.send }))
vi.mock('../../shared/api/operatorChatSummaries', async (original) => ({ ...await original<typeof import('../../shared/api/operatorChatSummaries')>(),
  listOperatorConversationSummaries: api.list }))
vi.mock('../../shared/api/operatorChatStream', () => ({ subscribeOperatorChat: () => () => {} }))

const clients: QueryClient[] = []
beforeEach(() => {
  vi.clearAllMocks()
  useOperatorChatStore.getState().reset()
  api.list.mockResolvedValue({ conversations: [] })
  api.create.mockResolvedValue({ conversation: { ...operatorState().conversation, id: 'new-chat' } })
  api.get.mockResolvedValue(operatorState({ conversation: { ...operatorState().conversation, id: 'new-chat' },
    messages: [], turnState: 'idle', activeRequestId: null }))
})
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()) })

function renderChat(enabled = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  return render(<QueryClientProvider client={client}>
    <OperatorChatVisibilityProvider enabled={enabled}><OperatorChat /></OperatorChatVisibilityProvider>
  </QueryClientProvider>)
}

describe('OperatorChat', () => {
  it('opens a useful starting interface without creating a conversation', async () => {
    renderChat()
    fireEvent.click(screen.getByRole('button', { name: 'Open Operator chat' }))
    expect(await screen.findByRole('heading', { name: 'Chat with Operator' })).toBeVisible()
    expect(screen.queryByText('Ask about your workspaces and workflows, or describe a change you need.')).not.toBeInTheDocument()
    fireEvent.focus(screen.getByRole('button', { name: 'About Chat with Operator' }))
    expect(screen.getByRole('tooltip')).toHaveTextContent('Ask about your workspaces and workflows, or describe a change you need.')
    expect(screen.getAllByRole('button', { name: 'Start chat' })).toHaveLength(1)
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open history' })).toHaveAttribute('aria-expanded', 'false')
    expect(api.create).not.toHaveBeenCalled()
    expect(api.send).not.toHaveBeenCalled()
  })
  it('creates once on explicit start, shows pending state, and opens the existing composer', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof api.create>>) => void
    api.create.mockImplementation(() => new Promise((done) => { resolve = done }))
    renderChat()
    fireEvent.click(screen.getByRole('button', { name: 'Open Operator chat' }))
    const start = screen.getByRole('button', { name: 'Start chat' })
    fireEvent.click(start)
    fireEvent.click(start)
    expect(await screen.findByRole('button', { name: 'Starting…' })).toBeDisabled()
    expect(start).toHaveAttribute('aria-busy', 'true')
    expect(api.create).toHaveBeenCalledTimes(1)
    await act(async () => resolve({ conversation: { ...operatorState().conversation, id: 'new-chat' } }))
    expect(await screen.findByRole('textbox', { name: 'Message' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Chat with Operator' })).not.toBeInTheDocument()
    expect(useOperatorChatStore.getState().selectedConversationId).toBe('new-chat')
    expect(api.send).not.toHaveBeenCalled()
  })
  it('keeps the starting action available after a creation failure', async () => {
    api.create.mockRejectedValueOnce(new Error('Try again later.'))
    renderChat()
    fireEvent.click(screen.getByRole('button', { name: 'Open Operator chat' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Conversation could not be created')
    expect(screen.getByRole('alert')).toHaveTextContent('Try again later.')
    const retry = screen.getByRole('button', { name: 'Start chat' })
    expect(retry).toBeEnabled()
    expect(useOperatorChatStore.getState().selectedConversationId).toBeUndefined()
    fireEvent.click(retry)
    expect(await screen.findByRole('textbox', { name: 'Message' })).toBeVisible()
    expect(api.create).toHaveBeenCalledTimes(2)
    const original = api.create.mock.calls[0]![0]
    expect(original.commandId).toEqual(expect.any(String))
    expect(api.create.mock.calls[1]![0]).toEqual(original)
    fireEvent.click(screen.getByRole('button', { name: 'Open history' }))
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(3))
    expect(api.create.mock.calls[2]![0].commandId).not.toBe(original.commandId)
    expect(api.send).not.toHaveBeenCalled()
  })
  it('does not offer the start action after Operator access is denied', async () => {
    api.list.mockRejectedValue(new ApiError({ code: 'ACCESS_DENIED', message: 'Denied' }, 403))
    renderChat()
    fireEvent.click(screen.getByRole('button', { name: 'Open Operator chat' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Operator access unavailable'))
    expect(screen.queryByRole('button', { name: 'Start chat' })).not.toBeInTheDocument()
    expect(api.create).not.toHaveBeenCalled()
  })
  it('hides only the UI when visibility is disabled', () => {
    renderChat(false)
    expect(screen.queryByRole('button', { name: 'Open Operator chat' })).not.toBeInTheDocument()
  })
})
