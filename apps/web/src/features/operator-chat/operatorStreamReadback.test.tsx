import { useState } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { deferred } from '../../test/deferred'
import { operatorState } from './pr17-test-fixtures'
import { useOperatorChatReadback } from './useOperatorChatReadback'
import { useOperatorChatStream } from './useOperatorChatStream'
import type { ConnectionState, PartialState } from './operatorChatShared'

class StreamSource extends EventTarget {
  static instances: StreamSource[] = []
  static CLOSED = 2
  readyState = 1
  constructor(readonly url: string) { super(); StreamSource.instances.push(this) }
  close() { this.readyState = 2 }
  send(type: string, data: unknown) {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }))
  }
}
function Chat({ id = 'chat' }: { id?: string }) {
  const readback = useOperatorChatReadback(true, true, id)
  const [, setPartial] = useState<PartialState>()
  const [, setConnection] = useState<ConnectionState>()
  useOperatorChatStream({ enabled: true, open: true, selectedId: id, accessDenied: readback.accessDenied,
    acceptState: readback.acceptState, readGeneration: readback.readGeneration, setPartial, setConnection })
  return <p>{readback.accessDenied ? 'Access denied' : readback.selected.data?.messages[0]?.content}</p>
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('finishes authoritative reads during sustained parsed activity traffic and performs a trailing read', async () => {
  StreamSource.instances = []
  vi.stubGlobal('EventSource', StreamSource)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const initial = operatorState({ conversation: { ...operatorState().conversation, id: 'chat' },
    messages: [{ id: 'answer', conversationId: 'chat', role: 'assistant', content: 'Initial answer' }] })
  const response = deferred<void>()
  const trailingResponse = deferred<void>()
  let reads = 0
  let aborted = false
  server.use(http.get('/api/operator/conversations/summaries', () => HttpResponse.json({ conversations: [] })),
    http.get('/api/operator/conversations/:id', async ({ request }) => {
    reads += 1
    if (reads === 2) {
      request.signal.addEventListener('abort', () => { aborted = true })
      await response.promise
    }
    if (reads === 3) await trailingResponse.promise
    return HttpResponse.json({ ...initial, revision: reads,
      messages: [{ ...initial.messages[0]!, content: reads === 1 ? 'Initial answer' : `Read ${reads}` }] })
  }))
  const view = render(<QueryClientProvider client={client}><Chat /></QueryClientProvider>)
  await screen.findByText('Initial answer')
  const stream = StreamSource.instances[0]!
  act(() => stream.send('snapshot', initial))
  await waitFor(() => expect(reads).toBe(2))
  for (let index = 1; index <= 12; index += 1) {
    act(() => stream.send('activity', { id: index, conversationId: 'chat', type: 'activity', data: {
      revision: index + 2, activity: { id: 'tool', requestId: 'request-one', sequence: '1',
        revision: index, kind: 'tool', title: 'Work', status: 'running' },
    } }))
  }
  expect(aborted).toBe(false)
  await act(async () => { response.resolve(); await response.promise })
  await screen.findByText('Read 2')
  await waitFor(() => expect(reads).toBe(3))
  await act(async () => { trailingResponse.resolve(); await trailingResponse.promise })
  await screen.findByText('Read 3')
  expect(aborted).toBe(false)
  expect(reads).toBe(3)
  view.unmount()
  client.clear()
})

it.each([401, 403])('keeps a denied read rejected after a stream snapshot (status %s)', async status => {
  StreamSource.instances = []
  vi.stubGlobal('EventSource', StreamSource)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  server.use(http.get('/api/operator/conversations/summaries', () => HttpResponse.json({ conversations: [] })),
    http.get('/api/operator/conversations/:id', () => HttpResponse.json({ error: {
      code: 'FORBIDDEN', message: 'Read denied',
    } }, { status })))
  const view = render(<QueryClientProvider client={client}><Chat /></QueryClientProvider>)
  await screen.findByText('Access denied')
  const state = operatorState({ conversation: { ...operatorState().conversation, id: 'chat' } })
  act(() => StreamSource.instances[0]!.send('snapshot', state))
  expect(screen.getByText('Access denied')).toBeInTheDocument()
  expect(screen.queryByText('First line\nSecond line')).not.toBeInTheDocument()
  view.unmount()
  client.clear()
})
