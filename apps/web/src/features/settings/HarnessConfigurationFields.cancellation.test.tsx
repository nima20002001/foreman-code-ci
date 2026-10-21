import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, waitFor } from '@testing-library/react'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it, vi } from 'vitest'
import { server } from '../../mocks/server'
import { HarnessConfigurationFields } from './HarnessConfigurationFields'
import { createHarnessEditor } from './harnessEditor'

const clients: QueryClient[] = []
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
})

it('abandons distinct debounced native checks when the editor changes and closes', async () => {
  const requests: Array<{ signal: AbortSignal; reasoningEffort: string }> = []
  server.use(http.post('/api/management/harnesses/validate', async ({ request }) => {
    const input = await request.json() as { configuration: { reasoningEffort: string } }
    requests.push({ signal: request.signal, reasoningEffort: input.configuration.reasoningEffort })
    await new Promise<void>((resolve) => {
      if (request.signal.aborted) resolve()
      else request.signal.addEventListener('abort', () => resolve(), { once: true })
    })
    return HttpResponse.json({ error: { code: 'ABORTED', message: 'Check canceled.' } }, { status: 503 })
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const configuration = DEFAULT_HARNESS_DEFAULTS.codex
  const show = (reasoningEffort: 'medium' | 'high') => <QueryClientProvider client={client}>
    <HarnessConfigurationFields allowHarnessChange={false} section="session"
      editor={createHarnessEditor({ ...configuration, reasoningEffort })} onChange={vi.fn()} />
  </QueryClientProvider>
  const view = render(show('medium'))
  await waitFor(() => expect(requests).toHaveLength(1))
  view.rerender(show('high'))
  await waitFor(() => expect(requests).toHaveLength(2))
  expect(requests.map(request => request.reasoningEffort)).toEqual(['medium', 'high'])
  expect(requests[0]!.signal.aborted).toBe(true)
  expect(requests[1]!.signal.aborted).toBe(false)
  view.unmount()
  await waitFor(() => expect(requests[1]!.signal.aborted).toBe(true))
})
