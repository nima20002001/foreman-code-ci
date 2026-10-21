import { useCallback, useRef, useState } from 'react'
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import type { OperatorConversationState } from '@foreman-code/contracts'
import { server } from '../../mocks/server'
import { getOperatorConversation } from '../../shared/api/client'
import { beginSessionChange, finishSessionChange } from '../../shared/api/sessionBoundary'
import { useOperatorChatStream } from './useOperatorChatStream'
import { detailKey, type ConnectionState, type PartialState } from './operatorChatShared'
import { operatorState } from './pr17-test-fixtures'

class Source extends EventTarget {
  static CLOSED = 2
  static CONNECTING = 0
  static sources: Source[] = []
  static connectOverHttp = false
  readyState = 0
  close = vi.fn(() => { this.readyState = Source.CLOSED })
  constructor(readonly url: string) {
    super()
    Source.sources.push(this)
    if (Source.connectOverHttp) void this.connect()
  }
  async connect() {
    const response = await fetch(new URL(this.url, window.location.origin))
    if (this.close.mock.calls.length) return
    if (!response.ok) { this.fail(); return }
    this.dispatchEvent(new Event('open'))
    this.snapshot(await response.json())
  }
  fail() { this.readyState = Source.CLOSED; this.dispatchEvent(new Event('error')) }
  snapshot(state: OperatorConversationState) {
    this.readyState = 1
    this.dispatchEvent(new MessageEvent('snapshot', { data: JSON.stringify(state) }))
  }
  event() {
    this.dispatchEvent(new MessageEvent('state', { data: JSON.stringify({
      id: 1, conversationId: 'conversation-one', type: 'state', data: {},
    }) }))
  }
}
let client: QueryClient
let state: OperatorConversationState
let denied = false
beforeEach(() => {
  Source.sources = []
  Source.connectOverHttp = false
  vi.stubGlobal('EventSource', Source)
  state = operatorState()
  denied = false
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  server.use(http.get('*/api/operator/conversations/conversation-one', () => denied
    ? HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'No access' } }, { status: 403 })
    : HttpResponse.json(state)))
})
afterEach(() => {
  cleanup()
  client.clear()
  finishSessionChange()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
function View({ id = 'conversation-one', open = true }: { id?: string; open?: boolean }) {
  const cache = useQueryClient()
  const query = useQuery({ queryKey: detailKey(id), queryFn: ({ signal }) => getOperatorConversation(id, { signal }) })
  const acceptState = useCallback((conversationId: string, value: OperatorConversationState) => {
    cache.setQueryData(detailKey(conversationId), value)
  }, [cache])
  const readGeneration = useRef(0)
  const [, setPartial] = useState<PartialState>()
  const [connection, setConnection] = useState<ConnectionState>()
  useOperatorChatStream({ enabled: true, open, selectedId: id, accessDenied: false,
    acceptState, readGeneration, setPartial, setConnection })
  return <><output aria-label="Connection">{connection?.state}</output>
    <p>{query.data?.messages.at(-1)?.content}</p></>
}
function mount() {
  return render(<QueryClientProvider client={client}><View /></QueryClientProvider>)
}
it.each([429, 503])('replaces a terminal source after retryable %s admission and consumes a later event', async status => {
  Source.connectOverHttp = true
  let attempts = 0
  server.use(http.get('*/api/operator/conversations/conversation-one/events', () => {
    attempts++
    return attempts === 1 ? new HttpResponse(null, { status }) : HttpResponse.json(state)
  }))
  mount()
  await screen.findByText('First line Second line', { exact: false })
  await waitFor(() => expect(Source.sources).toHaveLength(2), { timeout: 4_000 })
  expect(Source.sources[0]!.close).toHaveBeenCalledOnce()
  const replacement = Source.sources[1]!
  // A replacement still requires its own bootstrap before events are accepted.
  await waitFor(() => expect(screen.getByLabelText('Connection')).toHaveTextContent('connected'))
  state = operatorState({ revision: 2, messages: [{ ...state.messages[0]!, content: 'Recovered stream event' }] })
  act(() => replacement.event())
  await screen.findByText('Recovered stream event')
})

it('stops terminal reconnection after a confirmed read authorization denial', async () => {
  mount()
  await screen.findByText('First line Second line', { exact: false })
  denied = true
  act(() => Source.sources[0]!.fail())
  await waitFor(() => expect(client.getQueryState(detailKey('conversation-one'))?.status).toBe('error'))
  vi.useFakeTimers()
  await act(() => vi.advanceTimersByTimeAsync(30_000))
  expect(Source.sources).toHaveLength(1)
})

it.each(['dispose', 'close', 'session'] as const)('cancels a scheduled replacement on %s change', async kind => {
  const view = mount()
  await screen.findByText('First line Second line', { exact: false })
  vi.useFakeTimers()
  act(() => Source.sources[0]!.fail())
  act(() => {
    if (kind === 'dispose') view.unmount()
    else if (kind === 'session') beginSessionChange()
    else view.rerender(<QueryClientProvider client={client}><View open={false} /></QueryClientProvider>)
  })
  await act(() => vi.advanceTimersByTimeAsync(30_000))
  expect(Source.sources).toHaveLength(1)
  expect(Source.sources[0]!.close).toHaveBeenCalledOnce()
})

it('switches conversations while open and reconnects only the selected conversation', async () => {
  const second = operatorState({
    conversation: { ...state.conversation, id: 'conversation-two', title: 'Second conversation' },
    messages: [{ ...state.messages[0]!, conversationId: 'conversation-two', content: 'Second conversation answer' }],
  })
  server.use(http.get('*/api/operator/conversations/conversation-two', () => HttpResponse.json(second)))
  const view = mount()
  await screen.findByText('First line Second line', { exact: false })
  vi.useFakeTimers()
  act(() => Source.sources[0]!.fail())
  view.rerender(<QueryClientProvider client={client}><View id="conversation-two" /></QueryClientProvider>)
  expect(Source.sources).toHaveLength(2)
  const selected = Source.sources[1]!
  expect(selected.url).toContain('/conversations/conversation-two/events')
  act(() => selected.snapshot(second))
  expect(screen.getByText('Second conversation answer')).toBeVisible()
  act(() => selected.fail())
  await act(() => vi.advanceTimersByTimeAsync(30_000))
  expect(Source.sources).toHaveLength(3)
  expect(Source.sources.slice(1).every(source => source.url.includes('/conversations/conversation-two/events'))).toBe(true)
  expect(Source.sources[0]!.close).toHaveBeenCalledOnce()
  const recovered = { ...second, revision: 2,
    messages: [{ ...second.messages[0]!, content: 'Second conversation recovered' }] }
  act(() => Source.sources[2]!.snapshot(recovered))
  expect(screen.getByText('Second conversation recovered')).toBeVisible()
  expect(screen.queryByText('Second conversation answer')).not.toBeInTheDocument()
})
