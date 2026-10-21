import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { OperatorChat } from './OperatorChat'
import { installCanonicalOperatorFixture } from './canonicalOperator.test-support'
import { OperatorChatVisibilityProvider } from './visibility'
import { askOperator, useOperatorChatStore } from './operatorChatStore'
import { configuredOperatorSetup } from './operatorSetupTestFixture'
import { operatorState } from './pr17-test-fixtures'
import { summarizeOperatorConversation } from './operatorChatStatus'
import { useConversationDraftStore } from '../conversations'
import { clearRevisionedFormPersistence } from '../settings/revisionedForm'
import { server } from '../../mocks/server'

const api = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn(), list: vi.fn(), send: vi.fn() }))
vi.mock('../../shared/api/client', async original => ({
  ...await original(),
  createOperatorConversation: api.create,
  getOperatorConversation: api.get,
  sendOperatorMessage: api.send,
}))
vi.mock('../../shared/api/operatorChatSummaries', () => ({
  listOperatorConversationSummaries: api.list,
  deleteOperatorConversation: vi.fn(),
  restoreOperatorConversation: vi.fn(),
}))
vi.mock('../../shared/api/operatorChatStream', () => ({ subscribeOperatorChat: () => () => {} }))

let client: QueryClient
beforeEach(installCanonicalOperatorFixture)
beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  clearRevisionedFormPersistence()
  useConversationDraftStore.getState().clearAllDrafts()
  useOperatorChatStore.getState().reset()
  useOperatorChatStore.setState({ open: true, historyOpen: true, selectedConversationId: 'conversation-one' })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  api.get.mockImplementation(async id => operatorState({
    conversation: { ...operatorState().conversation, id },
    messages: id === 'new-chat' ? [] : operatorState().messages,
    turnState: 'idle', activeRequestId: null,
  }))
  api.list.mockResolvedValue({ conversations: [
    summarizeOperatorConversation(operatorState({ turnState: 'idle', activeRequestId: null })),
  ] })
  api.create.mockResolvedValue({ conversation: { ...operatorState().conversation, id: 'new-chat' } })
  server.use(http.get('/api/operator/setup', () => HttpResponse.json(configuredOperatorSetup('codex'))))
})
afterEach(() => {
  cleanup()
  client.clear()
})

function mount() {
  render(<QueryClientProvider client={client}>
    <OperatorChatVisibilityProvider enabled><OperatorChat /></OperatorChatVisibilityProvider>
  </QueryClientProvider>)
}

it('keeps an edited draft when app-request creation finishes its delayed history refresh', async () => {
  mount()
  await screen.findByRole('textbox', { name: 'Message' })
  let finishHistory!: () => void
  const history = new Promise<void>(resolve => { finishHistory = resolve })
  api.list.mockImplementation(async () => {
    await history
    return { conversations: [summarizeOperatorConversation(operatorState({ turnState: 'idle', activeRequestId: null }))] }
  })
  act(() => askOperator('Original app instruction', { send: false }))
  await waitFor(() => expect(useOperatorChatStore.getState().selectedConversationId).toBe('new-chat'))
  const input = await screen.findByRole('textbox', { name: 'Message' })
  expect(input).toHaveValue('Original app instruction')
  fireEvent.change(input, { target: { value: 'User replacement instruction' } })
  expect(input).toHaveValue('User replacement instruction')
  await act(async () => { finishHistory() })
  await waitFor(() => expect(client.isFetching()).toBe(0))
  expect(input).toHaveValue('User replacement instruction')
  expect(useConversationDraftStore.getState().drafts['new-chat']).toBe('User replacement instruction')
  expect(api.send).not.toHaveBeenCalled()
})

it('keeps a failed app request and resumes its instruction on explicit retry', async () => {
  api.create.mockRejectedValueOnce(new Error('Creation temporarily unavailable'))
  mount()
  await screen.findByRole('textbox', { name: 'Message' })
  act(() => askOperator('Install the selected computer harness', { send: false }))
  expect(await screen.findByText('Conversation could not be created')).toBeVisible()
  expect(useOperatorChatStore.getState().request?.content).toBe('Install the selected computer harness')
  expect(screen.getByText('Install the selected computer harness')).toBeVisible()
  await waitFor(() => expect(client.isMutating()).toBe(0))
  expect(api.create).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Retry requested chat' }))
  await waitFor(() => expect(useOperatorChatStore.getState().selectedConversationId).toBe('new-chat'))
  expect(await screen.findByRole('textbox', { name: 'Message' })).toHaveValue('Install the selected computer harness')
  expect(useOperatorChatStore.getState().request).toBeUndefined()
  expect(api.create).toHaveBeenCalledTimes(2)
  expect(api.create.mock.calls[1]![0]).toEqual(api.create.mock.calls[0]![0])
  expect(api.send).not.toHaveBeenCalled()
})

it('does not automatically send an app instruction superseded by a user edit', async () => {
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: async (_name: string, _options: LockOptions, work: (lock: Lock) => unknown) =>
      work({ name: 'outbox', mode: 'exclusive' } as Lock),
  } })
  let finishHistory!: () => void
  const history = new Promise<void>(resolve => { finishHistory = resolve })
  try {
    api.send.mockImplementation(async (id, command) => ({ replayed: false,
      state: operatorState({ conversation: { ...operatorState().conversation, id },
        messages: [{ id: 'sent', conversationId: id, requestId: command.requestId,
          role: 'user', content: command.content }],
        turnState: 'idle', activeRequestId: null,
      }),
    }))
    mount()
    await screen.findByRole('textbox', { name: 'Message' })
    api.list.mockImplementation(async () => {
      await history
      return { conversations: [summarizeOperatorConversation(operatorState({ turnState: 'idle', activeRequestId: null }))] }
    })
    act(() => askOperator('Install the harness on Computer A'))
    await waitFor(() => expect(useOperatorChatStore.getState().selectedConversationId).toBe('new-chat'))
    const input = await screen.findByRole('textbox', { name: 'Message' })
    fireEvent.change(input, { target: { value: 'Only inspect Computer A; do not install anything' } })
    expect(input).toHaveValue('Only inspect Computer A; do not install anything')
    await act(async () => { finishHistory() })
    await waitFor(() => expect(client.isFetching()).toBe(0))
    expect(input).toHaveValue('Only inspect Computer A; do not install anything')
    expect(api.send).not.toHaveBeenCalled()
  } finally {
    finishHistory?.()
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
    else Reflect.deleteProperty(navigator, 'locks')
  }
})

it('sends the retained app instruction once after retrying a failed creation', async () => {
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: async (_name: string, _options: LockOptions, work: (lock: Lock) => unknown) =>
      work({ name: 'outbox', mode: 'exclusive' } as Lock),
  } })
  try {
    api.create.mockRejectedValueOnce(new Error('Creation temporarily unavailable'))
    api.send.mockImplementation(async (id, command) => ({ replayed: false,
      state: operatorState({ conversation: { ...operatorState().conversation, id },
        messages: [{ id: 'sent', conversationId: id, requestId: command.requestId,
          role: 'user', content: command.content }],
        turnState: 'idle', activeRequestId: null,
      }),
    }))
    mount()
    await screen.findByRole('textbox', { name: 'Message' })
    act(() => askOperator('Inspect the selected computer'))
    await screen.findByText('Conversation could not be created')
    expect(api.send).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry requested chat' }))
    await waitFor(() => expect(api.send).toHaveBeenCalledWith('new-chat',
      expect.objectContaining({ content: 'Inspect the selected computer' })))
    await waitFor(() => expect(client.isMutating()).toBe(0))
    expect(api.create).toHaveBeenCalledTimes(2)
    expect(api.send).toHaveBeenCalledTimes(1)
    expect(useOperatorChatStore.getState().request).toBeUndefined()
  } finally {
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
    else Reflect.deleteProperty(navigator, 'locks')
  }
})

it('keeps a replacement app request when an earlier creation is still pending', async () => {
  let finishCreation!: (value: Awaited<ReturnType<typeof api.create>>) => void
  api.create.mockReturnValueOnce(new Promise(resolve => { finishCreation = resolve }))
  mount()
  await screen.findByRole('textbox', { name: 'Message' })
  act(() => askOperator('Original app instruction', { send: false }))
  await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1))
  act(() => askOperator('Replacement app instruction', { send: false }))
  await act(async () => {
    finishCreation({ conversation: { ...operatorState().conversation, id: 'superseded-chat' } })
  })
  await waitFor(() => expect(useOperatorChatStore.getState().selectedConversationId).toBe('new-chat'))
  expect(await screen.findByRole('textbox', { name: 'Message' })).toHaveValue('Replacement app instruction')
  expect(useConversationDraftStore.getState().drafts['superseded-chat']).toBeUndefined()
  expect(api.create).toHaveBeenCalledTimes(2)
  expect(api.send).not.toHaveBeenCalled()
})

it('keeps a Settings handoff draft reachable after switching chats and reopening history', async () => {
  const original = operatorState({ turnState: 'idle', activeRequestId: null })
  const settingsRequest = operatorState({
    conversation: { ...original.conversation, id: 'new-chat', title: 'Settings request' },
    messages: [],
    turnState: 'idle',
    activeRequestId: null,
  })
  api.create.mockResolvedValue({ conversation: settingsRequest.conversation })
  api.get.mockImplementation(async id => id === 'new-chat' ? settingsRequest : original)
  api.list.mockResolvedValue({ conversations: [original, settingsRequest].map(summarizeOperatorConversation) })
  mount()
  await screen.findByRole('textbox', { name: 'Message' })
  act(() => askOperator('Configure the selected harness', { send: false }))
  await waitFor(() => expect(useOperatorChatStore.getState().selectedConversationId).toBe('new-chat'))
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Configure the selected harness')
  fireEvent.click(screen.getByRole('button', { name: 'Open history' }))
  fireEvent.click(screen.getByRole('button', { name: /^First conversation/ }))
  await waitFor(() => expect(useOperatorChatStore.getState().selectedConversationId).toBe('conversation-one'))
  cleanup()
  client.clear()
  mount()
  fireEvent.click(await screen.findByRole('button', { name: /^Settings request/ }))
  expect(await screen.findByRole('textbox', { name: 'Message' })).toHaveValue('Configure the selected harness')
  expect(api.create).toHaveBeenCalledOnce()
  expect(api.send).not.toHaveBeenCalled()
})
