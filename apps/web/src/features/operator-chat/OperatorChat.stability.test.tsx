import type { subscribeOperatorChat } from '../../shared/api/operatorChatStream'
import { sessionControlsApi } from '../../shared/api/sessionControls'
import { SessionControlStateSchema, unavailableSessionControls } from '@foreman-code/contracts'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { operatorChatSettings, DEFAULT_HARNESS_DEFAULTS, type OperatorConversationState } from '@foreman-code/contracts'
import { server } from '../../mocks/server'
import { ApiError } from '../../shared/api/client'
import { protectedKey } from '../../shared/api/protectedChatStorage'
import { clearRevisionedFormPersistence } from '../settings/revisionedForm'
import { useConversationDraftStore } from '../conversations'
import { OperatorChat } from './OperatorChat'
import { OperatorChatVisibilityProvider } from './visibility'
import { useOperatorChatStore } from './operatorChatStore'
import { configuredOperatorSetup } from './operatorSetupTestFixture'
import { operatorDecision, operatorState } from './pr17-test-fixtures'
import { summarizeOperatorConversation } from './operatorChatStatus'
import { rejectableDeferred } from '../../test/deferred'

const api = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn(), create: vi.fn(), send: vi.fn(),
  remove: vi.fn(), restore: vi.fn(), cancel: vi.fn(), subscribe: vi.fn() }))
vi.mock('../../shared/api/client', async original => ({ ...await original<typeof import('../../shared/api/client')>(),
  getOperatorConversation: api.get, createOperatorConversation: api.create, sendOperatorMessage: api.send,
  cancelOperatorTurn: api.cancel }))
vi.mock('../../shared/api/operatorChatSummaries', () => ({ listOperatorConversationSummaries: api.list,
  deleteOperatorConversation: api.remove, restoreOperatorConversation: api.restore }))
vi.mock('../../shared/api/operatorChatStream', () => ({ subscribeOperatorChat: api.subscribe }))

const listKey = ['operator-chat', 'summaries']
let client: QueryClient
let states: Record<string, OperatorConversationState>
let listed: string[]
let originalLocks: PropertyDescriptor | undefined
function state(id: string, title: string, revision = 1) {
  return operatorState({ conversation: { ...operatorState().conversation, id, title }, revision,
    messages: [], turnState: 'idle', activeRequestId: null, settings: operatorChatSettings(DEFAULT_HARNESS_DEFAULTS.codex) })
}
function mount() {
  return render(<QueryClientProvider client={client}>
    <OperatorChatVisibilityProvider enabled><OperatorChat /></OperatorChatVisibilityProvider>
  </QueryClientProvider>)
}
async function deleteFirst() {
  fireEvent.click(await screen.findByRole('button', { name: 'Chat options: Draft topic' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
  await screen.findByRole('button', { name: 'Undo' })
}
beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  clearRevisionedFormPersistence()
  useConversationDraftStore.getState().clearAllDrafts()
  useOperatorChatStore.getState().reset()
  useOperatorChatStore.setState({ open: true, historyOpen: true, selectedConversationId: 'a' })
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  states = { a: state('a', 'Draft topic'), b: state('b', 'Other topic'), c: state('c', 'New topic') }
  listed = ['a', 'b']
  api.subscribe.mockReturnValue(() => {})
  api.get.mockImplementation(async id => states[id])
  api.list.mockImplementation(async () => ({ conversations: listed.map(id => summarizeOperatorConversation(states[id]!)) }))
  api.create.mockResolvedValue({ conversation: states.c!.conversation })
  api.remove.mockImplementation(async () => {
    listed = ['b']
    return { conversationId: 'a', revision: 2 }
  })
  api.restore.mockImplementation(async () => {
    states.a = state('a', 'Draft topic', 3)
    listed = ['a', 'b']
    return { conversationId: 'a', revision: 3 }
  })
  originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: async (_name: string, _options: LockOptions, work: () => unknown) => work(),
  } })
  server.use(http.get('/api/operator/setup', () => HttpResponse.json(configuredOperatorSetup('codex'))))
})
afterEach(() => {
  cleanup()
  client.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
  else Reflect.deleteProperty(navigator, 'locks')
})

it('keeps an unsent empty conversation reachable through history and a restarted client', async () => {
  const view = mount()
  const input = await screen.findByRole('textbox', { name: 'Message' })
  fireEvent.change(input, { target: { value: 'Exact unsent draft\nsecond line' } })
  fireEvent.click(screen.getByRole('button', { name: /^Other topic/ }))
  await waitFor(() => expect(useOperatorChatStore.getState().selectedConversationId).toBe('b'))
  view.unmount()
  client.clear()
  useConversationDraftStore.setState({ drafts: {} })
  window.dispatchEvent(new StorageEvent('storage', { key: protectedKey('draft', 'a'),
    newValue: 'Exact unsent draft\nsecond line' }))
  mount()
  fireEvent.click(await screen.findByRole('button', { name: /^Draft topic/ }))
  expect(await screen.findByRole('textbox', { name: 'Message' })).toHaveValue('Exact unsent draft\nsecond line')
  expect(useOperatorChatStore.getState().selectedConversationId).toBe('a')
  expect(api.create).not.toHaveBeenCalled()
  expect(api.send).not.toHaveBeenCalled()
})

it('shows a newer restoration from another client and fences pre-deletion history responses', async () => {
  mount()
  await deleteFirst()
  api.list.mockResolvedValue({ conversations: [summarizeOperatorConversation(states.a!), summarizeOperatorConversation(states.b!)] })
  await act(async () => { await client.invalidateQueries({ queryKey: listKey }) })
  expect(screen.queryByRole('button', { name: /^Draft topic/ })).not.toBeInTheDocument()
  states.a = state('a', 'Restored in other tab', 3)
  api.list.mockResolvedValue({ conversations: [summarizeOperatorConversation(states.a!), summarizeOperatorConversation(states.b!)] })
  await act(async () => { await client.invalidateQueries({ queryKey: listKey }) })
  expect(await screen.findByRole('button', { name: /^Restored in other tab/ })).toBeVisible()
  api.list.mockResolvedValue({ conversations: [summarizeOperatorConversation(state('a', 'Stale topic', 1)),
    summarizeOperatorConversation(states.b!)] })
  await act(async () => { await client.invalidateQueries({ queryKey: listKey }) })
  expect(screen.getByRole('button', { name: /^Restored in other tab/ })).toBeVisible()
  expect(screen.queryByRole('button', { name: /^Stale topic/ })).not.toBeInTheDocument()
  expect(api.restore).not.toHaveBeenCalled()
})

it.each(['select', 'new', 'round-trip'] as const)('does not let delayed Undo overwrite a newer %s navigation', async navigation => {
  mount()
  await deleteFirst()
  const response = rejectableDeferred<{ conversationId: string; revision: number }>()
  const history = rejectableDeferred<void>()
  api.restore.mockReturnValueOnce(response.promise)
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  await waitFor(() => expect(api.restore).toHaveBeenCalledOnce())
  api.list.mockImplementation(async () => {
    await history.promise
    return { conversations: ['a', 'b'].map(id => summarizeOperatorConversation(states[id]!)) }
  })
  states.a = state('a', 'Draft topic', 3)
  await act(async () => { response.resolve({ conversationId: 'a', revision: 3 }) })
  if (navigation === 'new') fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
  else act(() => {
    useOperatorChatStore.getState().select('a')
    useOperatorChatStore.getState().select('b')
    if (navigation === 'round-trip') useOperatorChatStore.getState().select('a')
  })
  const expected = { new: 'c', 'round-trip': 'a', select: 'b' }[navigation]
  await waitFor(() => expect(useOperatorChatStore.getState().selectedConversationId).toBe(expected))
  const generation = useOperatorChatStore.getState().navigationGeneration
  await act(async () => { history.resolve(); await Promise.resolve() })
  await waitFor(() => expect(client.isMutating()).toBe(0))
  expect(useOperatorChatStore.getState()).toMatchObject({ selectedConversationId: expected, navigationGeneration: generation })
})

it('recovers the original receipt after a send timeout even when completed GET readback arrived first', async () => {
  const response = rejectableDeferred<never>()
  api.send.mockReturnValueOnce(response.promise).mockImplementation(async (_id, command) => ({
    replayed: true, state: states.a, requestId: command.requestId,
  }))
  mount()
  const input = await screen.findByRole('textbox', { name: 'Message' })
  fireEvent.change(input, { target: { value: 'Continue once' } })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await waitFor(() => expect(api.send).toHaveBeenCalledOnce())
  const command = api.send.mock.calls[0]![1]
  states.a = { ...states.a!, revision: 4, messages: [{ id: 'accepted', conversationId: 'a', requestId: command.requestId,
    role: 'user', content: command.content }] }
  await act(async () => { await client.invalidateQueries({ queryKey: ['operator-chat', 'conversation', 'a'] }) })
  expect(await screen.findByText('Continue once', { selector: 'p' })).toBeVisible()
  await act(async () => { response.reject(new ApiError({ code: 'REQUEST_TIMEOUT', message: 'Timed out' })) })
  await waitFor(() => expect(client.isMutating()).toBe(0))
  expect(api.send.mock.calls[1]).toEqual(['a', { ...command, recovery: 'receipt' }])
  expect(api.send.mock.calls.filter(([, input]) => input.recovery !== 'receipt')).toHaveLength(1)
  expect(screen.queryByRole('button', { name: 'Retry pending message' })).not.toBeInTheDocument()
  expect(input).toHaveValue('')
})

it.each([false, true])('allows clearing a profile refusal only when all attempts are definitely unaccepted (earlier loss=%s)', async earlierLoss => {
  const conflict = new ApiError({ code: 'HARNESS_PROFILE_SELECTION_CONFLICT', message: 'Select the saved profile first.' }, 409)
  if (earlierLoss) api.send.mockRejectedValueOnce(new ApiError({ code: 'NETWORK_ERROR', message: 'Lost response' }))
    .mockRejectedValueOnce(new ApiError({ code: 'OPERATOR_RECEIPT_NOT_FOUND', message: 'No receipt' }, 404))
  api.send.mockRejectedValue(conflict)
  mount()
  const input = await screen.findByRole('textbox', { name: 'Message' })
  fireEvent.change(input, { target: { value: 'Retained request' } })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await waitFor(() => expect(api.send).toHaveBeenCalled())
  await waitFor(() => expect(client.isMutating()).toBe(0))
  if (earlierLoss) {
    const retry = await screen.findByRole('button', { name: 'Retry pending message' })
    await waitFor(() => expect(retry).toBeEnabled())
    fireEvent.click(retry)
    await screen.findAllByText('Select the saved profile first.')
    await waitFor(() => expect(client.isMutating()).toBe(0))
    expect(screen.queryByRole('button', { name: 'Clear rejected attempt and keep draft' })).not.toBeInTheDocument()
  } else {
    fireEvent.click(await screen.findByRole('button', { name: 'Clear rejected attempt and keep draft' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry pending message' })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled()
  }
  expect(input).toHaveValue('Retained request')
})

it.each(['closed', 'disabled'])('stops settled session controls polling while the panel is %s and reads again when reopened', async mode => {
  const controls = SessionControlStateSchema.parse({ conversationId: 'a', revision: 1, profileKey: 'profile',
    desiredMode: 'regular', appliedMode: 'regular', defaults: {}, desired: {}, applied: {}, applicability: 'applied',
    context: null, nativeSessionId: null, nativeProviderVersion: null, compaction: null, compactions: [],
    busyReason: null, capabilities: unavailableSessionControls('profile') })
  const read = vi.spyOn(sessionControlsApi, 'read').mockResolvedValue(controls)
  const view = mount()
  await waitFor(() => expect(read).toHaveBeenCalled())
  if (mode === 'closed') fireEvent.click(screen.getByRole('button', { name: 'Close Operator chat' }))
  else view.rerender(<QueryClientProvider client={client}>
    <OperatorChatVisibilityProvider enabled={false}><OperatorChat /></OperatorChatVisibilityProvider>
  </QueryClientProvider>)
  const count = read.mock.calls.length
  vi.useFakeTimers()
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000) })
    expect(read).toHaveBeenCalledTimes(count)
  } finally { vi.useRealTimers() }
  if (mode === 'closed') fireEvent.click(await screen.findByRole('button', { name: 'Open Operator chat' }))
  else view.rerender(<QueryClientProvider client={client}>
    <OperatorChatVisibilityProvider enabled><OperatorChat /></OperatorChatVisibilityProvider>
  </QueryClientProvider>)
  await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(count))
})

it.each([false, true])('keeps Stop bound to the accepted request while a control draft is edited (approval wait=%s)', async waiting => {
  states.a = { ...states.a!, turnState: 'active', activeRequestId: 'accepted-turn',
    ...(waiting ? { pendingInteraction: operatorDecision, responseDelivery: 'offered' as const } : {}) }
  api.cancel.mockImplementation(async () => ({ state: { ...states.a!, turnState: 'canceling' } }))
  mount()
  const input = await screen.findByRole('textbox', { name: 'Message' })
  fireEvent.change(input, { target: { value: '/compact' } })
  fireEvent.click(screen.getByRole('button', { name: 'Stop response' }))
  await waitFor(() => expect(api.cancel).toHaveBeenCalledExactlyOnceWith('a', 'accepted-turn'))
  expect(input).toHaveValue('/compact')
  expect(api.send).not.toHaveBeenCalled()
})

it.each([false, true])('uses saved full native identity for live-text readiness at the mounted transcript boundary (empty final=%s)', async emptyFinal => {
  const native = { harness: 'codex' as const, sessionId: 'native-session', turnId: 'native-turn',
    itemId: 'native-item', partId: '0', generation: '1' }
  states.a = { ...states.a!, turnState: 'active', activeRequestId: 'accepted-turn', messages: [
    { id: 'question', conversationId: 'a', requestId: 'accepted-turn', role: 'user', content: 'Question' },
  ] }
  mount()
  await screen.findByRole('textbox', { name: 'Message' })
  const listeners = api.subscribe.mock.calls[0]![1] as Parameters<typeof subscribeOperatorChat>[1]
  act(() => listeners.event({ id: 1, conversationId: 'a', type: 'delta', data: { activityChange: {
    schemaVersion: 1, owner: { kind: 'chat_request', conversationId: 'a', requestId: 'accepted-turn' }, native,
    source: { schemaVersion: 1, system: 'codex', eventId: 'fragment', observedAt: '2026-10-01T00:00:00Z' },
    change: { kind: 'text.append', itemId: native.itemId, partId: native.partId, text: 'Live answer', finality: 'provisional' },
  } } }))
  await screen.findByText('Live answer')
  const saved = { id: 'saved-answer', conversationId: 'a', requestId: 'accepted-turn', role: 'assistant' as const,
    nativeMessageId: native.itemId, activityNative: native, activityChannel: 'assistant' as const,
    nativeMessageComplete: false, content: 'Live answer' }
  states.a = { ...states.a!, revision: 2, messages: [...states.a!.messages, saved] }
  await act(async () => { await client.invalidateQueries({ queryKey: ['operator-chat', 'conversation', 'a'] }) })
  expect(await screen.findByRole('status', { name: 'Operator is typing' })).toBeVisible()
  expect(screen.getAllByText('Live answer')).toHaveLength(1)
  states.a = { ...states.a!, revision: 3, messages: [states.a!.messages[0]!,
    { ...saved, nativeMessageComplete: true, content: emptyFinal ? '' : 'Saved final answer' }] }
  await act(async () => { await client.invalidateQueries({ queryKey: ['operator-chat', 'conversation', 'a'] }) })
  await waitFor(() => expect(screen.queryByText('Live answer')).not.toBeInTheDocument())
  if (!emptyFinal) expect(screen.getByText('Saved final answer')).toBeVisible()
  expect(screen.getByRole('status', { name: 'Operator is typing' })).toBeVisible()
})

it.each(['idle', 'error'] as const)('removes responding dots immediately on %s and keeps them gone across refetch', async turnState => {
  const running = { ...states.a!, turnState: 'active' as const, activeRequestId: 'accepted-turn' }
  states.a = running
  mount()
  expect(await screen.findByRole('status', { name: 'Operator is typing' })).toBeVisible()
  await waitFor(() => expect(client.isFetching()).toBe(0))
  const response = rejectableDeferred<OperatorConversationState>()
  api.get.mockImplementationOnce(() => response.promise)
  const refetch = client.invalidateQueries({ queryKey: ['operator-chat', 'conversation', 'a'] })
  await waitFor(() => expect(client.isFetching()).toBeGreaterThan(0))
  const listeners = api.subscribe.mock.calls[0]![1] as Parameters<typeof subscribeOperatorChat>[1]
  try {
    act(() => listeners.event({ id: 1, conversationId: 'a', type: 'state',
      data: { requestId: 'accepted-turn', turnState } }))
    expect(screen.queryByRole('status', { name: 'Operator is typing' })).not.toBeInTheDocument()
  } finally {
    await act(async () => { response.resolve(running); await refetch })
  }
  expect(screen.queryByRole('status', { name: 'Operator is typing' })).not.toBeInTheDocument()
  states.a = { ...running, revision: 2, turnState, activeRequestId: null, messages: [
    { id: 'final-answer', conversationId: 'a', requestId: 'accepted-turn', role: 'assistant', content: 'Finished reply' },
  ] }
  await act(async () => { await client.invalidateQueries({ queryKey: ['operator-chat', 'conversation', 'a'] }) })
  expect(await screen.findByText('Finished reply')).toBeVisible()
  expect(screen.queryByRole('status', { name: 'Operator is typing' })).not.toBeInTheDocument()
  states.a = running
  await act(async () => { await client.invalidateQueries({ queryKey: ['operator-chat', 'conversation', 'a'] }) })
  expect(screen.queryByRole('status', { name: 'Operator is typing' })).not.toBeInTheDocument()
  act(() => listeners.reconnect())
  expect(screen.queryByRole('status', { name: 'Operator is typing' })).not.toBeInTheDocument()
  states.a = { ...running, revision: 3, activeRequestId: 'next-turn' }
  await act(async () => { await client.invalidateQueries({ queryKey: ['operator-chat', 'conversation', 'a'] }) })
  expect(screen.getByRole('status', { name: 'Operator is typing' })).toBeVisible()
  act(() => listeners.event({ id: 2, conversationId: 'a', type: 'state',
    data: { requestId: 'accepted-turn', turnState } }))
  expect(screen.getByRole('status', { name: 'Operator is typing' })).toBeVisible()
})

it.each(['event', 'reconnect', 'history'] as const)('settles an observed tool outside the recent window after %s', async trigger => {
  const running = { id: 'old-tool', requestId: 'accepted-turn', kind: 'tool' as const,
    title: 'Old command', status: 'running' as const, sequence: '1', revision: 1 }
  const newer = Array.from({ length: 100 }, (_, index) => ({ ...running, id: `newer-${index}`,
    title: `Newer command ${index}`, status: 'completed' as const, sequence: String(index + 2) }))
  states.a = { ...states.a!, revision: 1, turnState: 'active', activeRequestId: 'accepted-turn',
    messages: [{ id: 'question', conversationId: 'a', requestId: 'accepted-turn', role: 'user', content: 'Question' }],
    activities: trigger === 'history' ? newer : [running],
    activityNextCursor: trigger === 'history' ? '2' : null }
  let complete = false
  const exact = vi.fn()
  const historyRead = vi.fn()
  server.use(http.get('/api/operator/conversations/:id/activity', ({ request }) => {
    const params = new URL(request.url).searchParams
    if (params.get('activityId') === running.id) {
      exact(params.get('requestId'))
      return HttpResponse.json({ activities: [{ ...running, status: 'completed', output: 'Saved result', revision: 2 }], nextCursor: null })
    }
    historyRead(params.get('before'))
    return HttpResponse.json({ activities: [complete
      ? { ...running, status: 'completed', output: 'Saved result', revision: 2 }
      : running], nextCursor: null })
  }))
  mount()
  await screen.findByRole('textbox', { name: 'Message' })
  if (trigger === 'history') fireEvent.click(await screen.findByRole('button', { name: 'Load earlier activity' }))
  expect(await screen.findByText('Tool · Old command')).toBeVisible()
  states.a = { ...states.a!, revision: 2, activities: newer }
  complete = true
  const listeners = api.subscribe.mock.calls[0]![1] as Parameters<typeof subscribeOperatorChat>[1]
  if (trigger === 'event') act(() => listeners.event({ id: 1, conversationId: 'a', type: 'activity',
    data: { revision: 2, activity: { ...running, status: 'completed', revision: 2 } } }))
  else act(() => listeners.reconnect())
  await waitFor(() => expect(exact).toHaveBeenCalledWith('accepted-turn'))
  await screen.findByText('Tool · Newer command 99')
  if (trigger !== 'history') {
    await waitFor(() => expect(screen.queryByText('Tool · Old command')).not.toBeInTheDocument())
    fireEvent.click(await screen.findByRole('button', { name: 'Load earlier activity' }))
  }
  const tool = await screen.findByText('Tool · Old command')
  fireEvent.click(tool.closest('summary')!)
  expect(await screen.findByText('Saved result')).toBeVisible()
  expect(historyRead).toHaveBeenCalledExactlyOnceWith('2')
  expect(screen.getAllByText('Tool · Old command')).toHaveLength(1)
  expect(screen.queryByText('Running')).not.toBeInTheDocument()
})
