import { useCallback, useRef, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it, vi } from 'vitest'
import type { OperatorConversationState } from '@foreman-code/contracts'
import { server } from '../../mocks/server'
import { operatorState } from './pr17-test-fixtures'
import { useOperatorChatStream } from './useOperatorChatStream'
import type { ConnectionState, PartialState } from './operatorChatShared'

class Source extends EventTarget {
  static CLOSED = 2
  static current: Source
  readyState = 1
  close = vi.fn()
  constructor() { super(); Source.current = this }
  snapshot() {
    this.dispatchEvent(new MessageEvent('snapshot', { data: JSON.stringify(operatorState()) }))
  }
}
const clients: QueryClient[] = []
afterEach(() => { clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); vi.useRealTimers() })

function Conversation() {
  const [connection, setConnection] = useState<ConnectionState>()
  const [state, setState] = useState<OperatorConversationState>()
  const [, setPartial] = useState<PartialState>()
  const readGeneration = useRef(0)
  const acceptState = useCallback((_id: string, value: OperatorConversationState) => setState(value), [])
  useOperatorChatStream({ enabled: true, open: true, selectedId: 'conversation-one', accessDenied: false,
    acceptState, readGeneration, setPartial, setConnection })
  return <><p role="status">{connection?.state}</p><p>{state?.messages[0]?.content}</p></>
}

it('restores live conversation streaming after more than six failed recovery reads', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal('EventSource', Source)
  let reads = 0
  server.use(http.get('*/api/operator/conversations/conversation-one', () => {
    reads++
    if (reads <= 6) return HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'API restarting' } }, { status: 503 })
    return HttpResponse.json(operatorState())
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const view = render(<QueryClientProvider client={client}><Conversation /></QueryClientProvider>)
  const original = Source.current
  act(() => {
    original.readyState = Source.CLOSED
    original.dispatchEvent(new Event('error'))
  })
  for (const [index, delay] of [1000, 2000, 4000, 8000, 10000, 10000].entries()) {
    await act(async () => { await vi.advanceTimersByTimeAsync(delay) })
    expect(reads).toBe(index + 1)
    expect(client.isFetching()).toBe(0)
  }
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(reads).toBe(7)
  expect(Source.current).not.toBe(original)
  act(() => Source.current.snapshot())
  expect(screen.getByRole('status')).toHaveTextContent('connected')
  expect(screen.getByText(/First line/)).toBeVisible()
  view.unmount()
  await vi.advanceTimersByTimeAsync(30000)
  expect(reads).toBe(7)
  expect(Source.current.close).toHaveBeenCalledOnce()
})
