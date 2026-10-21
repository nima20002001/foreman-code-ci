import type { AgentChatContext } from '@foreman-code/contracts/agent-chat'
import { createElement, type PropsWithChildren } from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionControlStateSchema, unavailableSessionControls } from '@foreman-code/contracts'
import { sessionControlsApi } from '../../../shared/api/sessionControls'
import { useConversationDraftStore } from '../conversationDraftStore'
import { pendingControl, reservePendingControl, clearPendingControl, recoverPendingControl } from './controlRequest'
import { useSessionControls } from './useSessionControls'
import { SessionContext } from './SessionControls'
import { ApiError } from '../../../shared/api/client'
import { OperatorComposer } from '../../operator-chat/OperatorComposer'
import { ConversationComposer } from '../ConversationComposer'
import { deferred } from '../../../test/deferred'

const initial = SessionControlStateSchema.parse({ conversationId: 'chat', revision: 1, profileKey: 'profile',
  desiredMode: 'regular', appliedMode: 'regular', defaults: {}, desired: {}, applied: {}, applicability: 'applied',
  context: null, nativeSessionId: 'native', nativeProviderVersion: 'test', compaction: null, compactions: [],
  busyReason: null, capabilities: { ...unavailableSessionControls('profile'), modelCapacity: 200000 } })
function mount(context?: AgentChatContext) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children)
  return { ...renderHook(() => useSessionControls(context ? undefined : 'chat', context ? { workspaceId: context.workspaceId, context } : {}), { wrapper }), client }
}
let originalLocks: PropertyDescriptor | undefined
beforeEach(() => {
  originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
  const tails = new Map<string, Promise<unknown>>()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request<T>(name: string, options: LockOptions, callback: () => T): Promise<T> {
      const work = (tails.get(name) ?? Promise.resolve()).catch(() => { /* ignore: a failed earlier lock holder must not block the next one. */ }).then(() => {
        options.signal?.throwIfAborted()
        return callback()
      })
      tails.set(name, work)
      return work
    },
  } })
})
afterEach(() => {
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
  else Reflect.deleteProperty(navigator, 'locks')
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); useConversationDraftStore.getState().clearAllDrafts() })

it('reuses the original compact input after a lost response and remount, then clears the confirmed draft', async () => {
  let saved = initial
  vi.spyOn(sessionControlsApi, 'read').mockImplementation(async () => saved)
  const change = vi.spyOn(sessionControlsApi, 'change').mockRejectedValueOnce(new Error('Response lost'))
  useConversationDraftStore.getState().setDraft('chat', '/compact')
  const first = mount()
  await waitFor(() => expect(first.result.current.state).toBeDefined())
  await act(async () => {
    await expect(first.result.current.command('/compact', 'chat')).rejects.toThrow('Response lost')
  })
  const original = change.mock.calls[0]![1]
  first.unmount()
  const second = mount()
  await waitFor(() => expect(second.result.current.state).toBeDefined())
  change.mockImplementationOnce(async () => {
    saved = { ...initial, revision: 3, compaction: { requestId: original.requestId, nativeSessionId: 'native',
      nativeOperationId: 'compact-turn', status: 'completed', beforeTokens: 100,
      message: 'Context compacted.', observedAt: new Date().toISOString() } }
    return saved
  })
  await act(async () => { await second.result.current.command('/compact', 'chat') })
  expect(change.mock.calls[1]![1]).toEqual(original)
  expect(useConversationDraftStore.getState().drafts.chat).toBeUndefined()
  expect(pendingControl(JSON.stringify(['operator', 'chat', null]))).toBeNull()
})

it('clears a recovered command draft on readback while preserving later edits', async () => {
  vi.spyOn(sessionControlsApi, 'read').mockResolvedValue(initial)
  const change = vi.spyOn(sessionControlsApi, 'change').mockRejectedValue(new Error('Response lost'))
  useConversationDraftStore.getState().setDraft('chat', '/compact')
  const first = mount()
  await waitFor(() => expect(first.result.current.state).toBeDefined())
  await act(async () => { await first.result.current.command('/compact', 'chat').catch(() => { /* ignore: the rejection is asserted through the persisted pending control below. */ }) })
  first.unmount()
  const original = change.mock.calls[0]![1]
  useConversationDraftStore.getState().setDraft('chat', 'A later edit')
  vi.mocked(sessionControlsApi.read).mockResolvedValue({ ...initial, compaction: {
    requestId: original.requestId, nativeSessionId: 'native', nativeOperationId: 'compact-turn', status: 'completed',
    beforeTokens: 100, message: 'Context compacted.', observedAt: new Date().toISOString(),
  } })
  const second = mount()
  await waitFor(() => expect(second.result.current.state?.compaction?.status).toBe('completed'))
  expect(useConversationDraftStore.getState().drafts.chat).toBe('A later edit')
  expect(change).toHaveBeenCalledTimes(1)
})

it('reports storage failure and sends no native control without a durable identity', async () => {
  vi.spyOn(sessionControlsApi, 'read').mockResolvedValue(initial)
  const change = vi.spyOn(sessionControlsApi, 'change')
  const mounted = mount()
  await waitFor(() => expect(mounted.result.current.state).toBeDefined())
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Control storage is full') })
  await act(async () => {
    await expect(mounted.result.current.change({ kind: 'compact' })).rejects.toThrow('Control storage is full')
  })
  await waitFor(() => expect(mounted.result.current.mutation.isError).toBe(true))
  expect(mounted.result.current.mutation.error?.message).toBe('Control storage is full')
  expect(change).not.toHaveBeenCalled()
})

it('keeps node control identity across reloads that reconstruct context fields in another order', async () => {
  const context = { workspaceId: 'workspace', workflowId: 'workflow', workflowNodeId: 'node', agentId: 'agent' }
  vi.spyOn(sessionControlsApi, 'readContext').mockResolvedValue(initial)
  const change = vi.spyOn(sessionControlsApi, 'changeContext').mockRejectedValueOnce(new Error('Response lost'))
  const first = mount(context)
  await waitFor(() => expect(first.result.current.state).toBeDefined())
  await act(async () => { await expect(first.result.current.change({ kind: 'compact' })).rejects.toThrow('Response lost') })
  const original = change.mock.calls[0]![1]
  first.unmount()
  const second = mount({ agentId: 'agent', workflowNodeId: 'node', workflowId: 'workflow', workspaceId: 'workspace' })
  await waitFor(() => expect(second.result.current.state).toBeDefined())
  change.mockResolvedValueOnce({ ...initial, compaction: { requestId: original.requestId,
    nativeSessionId: 'native', nativeOperationId: 'compact-turn', status: 'completed', beforeTokens: 100,
    message: 'Context compacted.', observedAt: new Date().toISOString() } })
  await act(async () => { await second.result.current.change({ kind: 'compact' }) })
  expect(change.mock.calls[1]![1]).toEqual(original)
})

it('reserves one compact identity across competing tabs and preserves it through a lost winner response', async () => {
  const scope = JSON.stringify(['operator', 'chat', null])
  const ids = vi.spyOn(crypto, 'randomUUID')
  const [first, second] = await Promise.all([
    reservePendingControl(scope, { kind: 'compact' }, 1),
    reservePendingControl(scope, { kind: 'compact' }, 2),
  ])
  expect(second).toEqual(first)
  expect(ids).toHaveBeenCalledTimes(1)
  await clearPendingControl(scope, 'losing-request')
  expect(pendingControl(scope)).toEqual(first)
  expect(await reservePendingControl(scope, { kind: 'compact' }, 3)).toEqual(first)
  await recoverPendingControl(scope, { ...initial, compaction: {
    requestId: first.request.requestId, nativeSessionId: 'native', nativeOperationId: 'turn', status: 'completed',
    beforeTokens: 100, message: 'Done', observedAt: new Date().toISOString(),
  } })
  expect(pendingControl(scope)).toBeNull()
})

it('clears a superseded settings journal using the original completed receipt', async () => {
  const scope = JSON.stringify(['operator', 'chat', null])
  const original = await reservePendingControl(scope, { kind: 'mode', mode: 'plan' }, 1)
  await recoverPendingControl(scope, { ...initial, lastRequestId: 'later-writer' })
  expect(pendingControl(scope)).toEqual(original)
  await recoverPendingControl(scope, { ...initial, lastRequestId: 'later-writer',
    completedRequestId: original.request.requestId })
  expect(pendingControl(scope)).toBeNull()
  expect((await reservePendingControl(scope, { kind: 'mode', mode: 'regular' }, 3)).request.requestId)
    .not.toBe(original.request.requestId)
})

it('recovers a superseded receipt before admitting a different control', async () => {
  let saved = initial
  vi.spyOn(sessionControlsApi, 'read').mockImplementation(async () => saved)
  const change = vi.spyOn(sessionControlsApi, 'change').mockRejectedValueOnce(new Error('Response lost'))
  const first = mount()
  await waitFor(() => expect(first.result.current.state).toBeDefined())
  await act(async () => { await expect(first.result.current.change({ kind: 'mode', mode: 'plan' })).rejects.toThrow('Response lost') })
  const original = change.mock.calls[0]![1]
  first.unmount()
  saved = { ...initial, revision: 4, lastRequestId: 'other-settings-writer' }
  const second = mount()
  await waitFor(() => expect(second.result.current.state?.revision).toBe(4))
  change.mockResolvedValueOnce({ ...saved, completedRequestId: original.requestId })
    .mockImplementationOnce(async (_id, request) => ({ ...saved, revision: 5, lastRequestId: request.requestId }))
  await act(async () => { await second.result.current.change({ kind: 'mode', mode: 'regular' }) })
  expect(change.mock.calls[1]![1]).toEqual(original)
  expect(change.mock.calls[2]![1]).toMatchObject({ kind: 'mode', mode: 'regular', expectedRevision: 4 })
  expect(pendingControl(JSON.stringify(['operator', 'chat', null]))).toBeNull()
})

it('clears a definitively rejected recovery so a different control can be retried', async () => {
  const scope = JSON.stringify(['operator', 'chat', null])
  await reservePendingControl(scope, { kind: 'mode', mode: 'plan' }, 0)
  vi.spyOn(sessionControlsApi, 'read').mockResolvedValue(initial)
  const change = vi.spyOn(sessionControlsApi, 'change').mockRejectedValueOnce(
    new ApiError({ code: 'SESSION_REVISION_CONFLICT', message: 'Settings changed.' }, 409),
  ).mockImplementation(async (_id, request) => ({ ...initial, revision: 2, lastRequestId: request.requestId }))
  const mounted = mount()
  await waitFor(() => expect(mounted.result.current.state).toBeDefined())
  await act(async () => {
    await expect(mounted.result.current.change({ kind: 'mode', mode: 'regular' })).rejects.toThrow('Settings changed.')
  })
  expect(pendingControl(scope)).toBeNull()
  await act(async () => { await mounted.result.current.change({ kind: 'mode', mode: 'regular' }) })
  expect(change.mock.calls[1]![1]).toMatchObject({ kind: 'mode', mode: 'regular', expectedRevision: 1 })
})

it('retains an uncertain recovery and refuses to replace its request', async () => {
  const scope = JSON.stringify(['operator', 'chat', null])
  const original = await reservePendingControl(scope, { kind: 'compact' }, 1)
  vi.spyOn(sessionControlsApi, 'read').mockResolvedValue(initial)
  const change = vi.spyOn(sessionControlsApi, 'change').mockRejectedValue(
    new ApiError({ code: 'SESSION_COMPACT_UNCONFIRMED', message: 'Still unconfirmed.' }, 409),
  )
  const mounted = mount()
  await waitFor(() => expect(mounted.result.current.state).toBeDefined())
  await act(async () => {
    await expect(mounted.result.current.change({ kind: 'mode', mode: 'plan' })).rejects.toThrow('Still unconfirmed.')
  })
  expect(pendingControl(scope)).toEqual(original)
  expect(change).toHaveBeenCalledOnce()
})

it.each(['accepted', 'running', 'uncertain'] as const)('treats %s compaction as progress and clears only its original draft on completion', async status => {
  let saved = initial
  vi.spyOn(sessionControlsApi, 'read').mockImplementation(async () => saved)
  vi.spyOn(sessionControlsApi, 'change').mockImplementation(async (_id, request) => {
    saved = { ...initial, revision: 2, compaction: { requestId: request.requestId, nativeSessionId: 'native',
      nativeOperationId: 'compact-turn', status, beforeTokens: 100,
      message: 'Compacting context.', observedAt: new Date().toISOString() } }
    return saved
  })
  useConversationDraftStore.getState().setDraft('chat', '/compact')
  const mounted = mount()
  await waitFor(() => expect(mounted.result.current.state).toBeDefined())
  await act(async () => { await expect(mounted.result.current.command('/compact', 'chat')).resolves.toBe(true) })
  expect(useConversationDraftStore.getState().drafts.chat).toBe('/compact')
  saved = { ...saved, revision: 3, compaction: { ...saved.compaction!, status: 'completed', message: 'Context compacted.' } }
  await act(async () => { await mounted.result.current.query.refetch() })
  await waitFor(() => expect(useConversationDraftStore.getState().drafts.chat).toBeUndefined())
})

it('keeps newer GET settings when a delayed POST returns an older revision', async () => {
  let saved = initial
  const read = vi.spyOn(sessionControlsApi, 'read').mockImplementation(async () => saved)
  const response = deferred<typeof initial>()
  const change = vi.spyOn(sessionControlsApi, 'change').mockReturnValue(response.promise)
  const mounted = mount()
  await waitFor(() => expect(mounted.result.current.state).toBeDefined())
  let pending!: Promise<unknown>
  act(() => { pending = mounted.result.current.change({ kind: 'mode', mode: 'plan' }) })
  await waitFor(() => expect(change).toHaveBeenCalledOnce())
  saved = { ...initial, revision: 4, desiredMode: 'regular' }
  await act(async () => { await mounted.result.current.query.refetch() })
  await waitFor(() => expect(mounted.result.current.state?.revision).toBe(4))
  await act(async () => {
    read.mockReturnValue(new Promise(() => {}))
    response.resolve({ ...initial, revision: 2, desiredMode: 'plan', lastRequestId: change.mock.calls[0]![1].requestId })
    await pending
  })
  const key = mounted.client.getQueryCache().getAll()[0]!.queryKey
  expect(mounted.client.getQueryData(key)).toMatchObject({ revision: 4, desiredMode: 'regular' })
  await waitFor(() => expect(mounted.result.current.state).toMatchObject({ revision: 4, desiredMode: 'regular' }))
})

it('keeps newer POST settings when a GET already in flight returns stale settings', async () => {
  const read = vi.spyOn(sessionControlsApi, 'read').mockResolvedValue(initial)
  const mounted = mount()
  await waitFor(() => expect(mounted.result.current.state).toBeDefined())
  const response = deferred<typeof initial>()
  read.mockReturnValue(response.promise)
  let fetching!: Promise<unknown>
  act(() => { fetching = mounted.result.current.query.refetch() })
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  const key = mounted.client.getQueryCache().getAll()[0]!.queryKey
  act(() => { mounted.client.setQueryData(key, { ...initial, revision: 4, desiredMode: 'plan' }) })
  await waitFor(() => expect(mounted.result.current.state?.revision).toBe(4))
  await act(async () => { response.resolve(initial); await fetching })
  expect(mounted.client.getQueryData(key)).toMatchObject({ revision: 4, desiredMode: 'plan' })
  await waitFor(() => expect(mounted.result.current.state).toMatchObject({ revision: 4, desiredMode: 'plan' }))
})

it.each(['conversation', 'profile'] as const)('ignores a mutation snapshot for a mismatching %s', async target => {
  const read = vi.spyOn(sessionControlsApi, 'read').mockResolvedValue(initial)
  vi.spyOn(sessionControlsApi, 'change').mockResolvedValue({ ...initial, revision: 10, desiredMode: 'plan',
    ...(target === 'conversation' ? { conversationId: 'other-chat' } : { profileKey: 'other-profile' }) })
  const mounted = mount()
  await waitFor(() => expect(mounted.result.current.state).toBeDefined())
  read.mockReturnValue(new Promise(() => {}))
  await act(async () => {
    await expect(mounted.result.current.change({ kind: 'mode', mode: 'plan' }))
      .rejects.toThrow('Session controls belong to another conversation or native profile.')
  })
  expect(mounted.result.current.state).toMatchObject({ revision: 1, desiredMode: 'regular', conversationId: 'chat', profileKey: 'profile' })
})

it('rejects a GET snapshot owned by another conversation', async () => {
  const read = vi.spyOn(sessionControlsApi, 'read').mockResolvedValue(initial)
  const mounted = mount()
  await waitFor(() => expect(mounted.result.current.state).toBeDefined())
  read.mockResolvedValue({ ...initial, revision: 10, conversationId: 'other-chat' })
  await act(async () => { await mounted.result.current.query.refetch() })
  expect(mounted.result.current.state).toEqual(initial)
})

it('accepts a newer profile for the same chat, uses its revision and fences delayed old-profile reads', async () => {
  const read = vi.spyOn(sessionControlsApi, 'read').mockResolvedValue(initial)
  const change = vi.spyOn(sessionControlsApi, 'change').mockImplementation(async (_id, request) => ({
    ...initial, profileKey: 'profile-b', capabilities: { ...initial.capabilities, profileKey: 'profile-b' },
    revision: 11, lastRequestId: request.requestId,
  }))
  const mounted = mount()
  await waitFor(() => expect(mounted.result.current.state?.profileKey).toBe('profile'))
  const next = { ...initial, profileKey: 'profile-b', revision: 10,
    capabilities: { ...initial.capabilities, profileKey: 'profile-b' } }
  read.mockResolvedValue(next)
  await act(async () => { await mounted.result.current.query.refetch() })
  await waitFor(() => expect(mounted.result.current.state).toEqual(next))
  await act(async () => { await mounted.result.current.change({ kind: 'mode', mode: 'plan' }) })
  expect(change.mock.calls[0]![1].expectedRevision).toBe(10)
  await waitFor(() => expect(mounted.result.current.state).toMatchObject({ profileKey: 'profile-b', revision: 11 }))
  read.mockResolvedValue(initial)
  await act(async () => { await mounted.result.current.query.refetch() })
  expect(mounted.result.current.state).toMatchObject({ profileKey: 'profile-b', revision: 11 })
})

it('pauses inactive controls polling and recovers retained commands after reopening', async () => {
  const read = vi.spyOn(sessionControlsApi, 'read').mockResolvedValue(initial)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children)
  const mounted = renderHook(({ enabled }) => useSessionControls('chat', { enabled }), {
    wrapper, initialProps: { enabled: true },
  })
  await waitFor(() => expect(mounted.result.current.state).toBeDefined())
  const scope = JSON.stringify(['operator', 'chat', null])
  const pending = await reservePendingControl(scope, { kind: 'mode', mode: 'plan' }, 1)
  mounted.rerender({ enabled: false })
  const count = read.mock.calls.length
  vi.useFakeTimers()
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000) })
    expect(read).toHaveBeenCalledTimes(count)
    expect(pendingControl(scope)).toEqual(pending)
  } finally { vi.useRealTimers() }
  read.mockResolvedValue({ ...initial, revision: 2, lastRequestId: pending.request.requestId })
  mounted.rerender({ enabled: true })
  await waitFor(() => expect(pendingControl(scope)).toBeNull())
  expect(mounted.result.current.state?.revision).toBe(2)
  mounted.unmount()
  client.clear()
})

it('keeps a pending control and its late response owned by the original chat', async () => {
  const read = vi.spyOn(sessionControlsApi, 'read').mockImplementation(async id => ({ ...initial, conversationId: id }))
  const response = deferred<typeof initial>()
  const change = vi.spyOn(sessionControlsApi, 'change').mockReturnValue(response.promise)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children)
  const mounted = renderHook(({ id }) => useSessionControls(id), { wrapper, initialProps: { id: 'chat' } })
  await waitFor(() => expect(mounted.result.current.state?.conversationId).toBe('chat'))
  useConversationDraftStore.getState().setDraft('chat', '/plan')
  useConversationDraftStore.getState().setDraft('other-chat', 'Independent draft')
  let pending!: Promise<unknown>
  act(() => { pending = mounted.result.current.command('/plan', 'chat') })
  await waitFor(() => expect(change).toHaveBeenCalledOnce())
  mounted.rerender({ id: 'other-chat' })
  await waitFor(() => expect(mounted.result.current.state?.conversationId).toBe('other-chat'))
  expect(mounted.result.current.mutation.isPending).toBe(false)
  read.mockReturnValue(new Promise(() => {}))
  await act(async () => {
    response.resolve({ ...initial, revision: 2, desiredMode: 'plan', lastRequestId: change.mock.calls[0]![1].requestId })
    await pending
  })
  expect(mounted.result.current.state).toMatchObject({ conversationId: 'other-chat', desiredMode: 'regular', revision: 1 })
  expect(useConversationDraftStore.getState().drafts['other-chat']).toBe('Independent draft')
  expect(useConversationDraftStore.getState().drafts.chat).toBeUndefined()
})

it.each([
  ['Operator', 'completed'], ['node', 'completed'],
  ['Operator', 'failed'], ['node', 'failed'],
  ['Operator', 'no-op'], ['node', 'no-op'],
] as const)('updates the %s composer lost-response error when its compact request becomes %s on polling', async (role, status) => {
  let saved = initial
  vi.spyOn(sessionControlsApi, 'read').mockImplementation(async () => saved)
  const change = vi.spyOn(sessionControlsApi, 'change').mockRejectedValue(new Error('Response lost'))
  let controls!: ReturnType<typeof useSessionControls>
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  function Composer() {
    controls = useSessionControls('chat')
    if (role === 'Operator') return createElement(OperatorComposer, { conversationId: 'chat', sessionControls: controls,
      onNewChat: vi.fn(), onSubmit: vi.fn() })
    return createElement(ConversationComposer, { conversationId: 'chat', sessionControls: controls, onSubmit: vi.fn() })
  }
  render(createElement(QueryClientProvider, { client }, createElement(Composer)))
  await waitFor(() => expect(controls.state).toBeDefined())
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: '/compact' } })
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter' })
  await waitFor(() => expect(screen.getAllByRole('alert').some(element => element.textContent?.includes('Response lost'))).toBe(true))
  saved = { ...initial, revision: 2, compaction: { requestId: 'another-compact-request',
    nativeSessionId: 'native', nativeOperationId: 'another-turn', status: 'completed', beforeTokens: 100,
    message: 'Another request completed.', observedAt: new Date().toISOString() } }
  await act(async () => { await controls.query.refetch() })
  expect(screen.getAllByRole('alert').some(element => element.textContent?.includes('Response lost'))).toBe(true)
  saved = { ...initial, revision: 3, compaction: { requestId: change.mock.calls[0]![1].requestId,
    nativeSessionId: 'native', nativeOperationId: 'compact-turn', status, beforeTokens: 100,
    message: status === 'failed' ? 'Native compaction failed.' : 'Context compacted.', observedAt: new Date().toISOString() } }
  await act(async () => { await controls.query.refetch() })
  if (status === 'failed') {
    await waitFor(() => expect(screen.getAllByRole('alert').every(element => element.textContent === 'Native compaction failed.')).toBe(true))
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('/compact')
  } else {
    await waitFor(() => expect(screen.queryAllByRole('alert')).toHaveLength(0))
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('')
  }
  await waitFor(() => expect(pendingControl(JSON.stringify(['operator', 'chat', null]))).toBeNull())
})


it('opens context settings only after activation and restores focus without reopening', async () => {
  vi.spyOn(sessionControlsApi, 'read').mockResolvedValue(initial)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  function Controls() {
    return <SessionContext controls={useSessionControls('chat')} />
  }
  const view = render(<QueryClientProvider client={client}><Controls /></QueryClientProvider>)
  const meter = await screen.findByRole('button', { name: '0% context' })
  fireEvent.mouseEnter(meter)
  act(() => meter.focus())
  expect(meter).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(meter)
  expect(meter).toHaveAttribute('aria-expanded', 'true')
  fireEvent.keyDown(screen.getByRole('heading', { name: 'Context' }), { key: 'Escape' })
  expect(meter).toHaveFocus()
  expect(meter).toHaveAttribute('aria-expanded', 'false')
  view.unmount()
  client.clear()
})
