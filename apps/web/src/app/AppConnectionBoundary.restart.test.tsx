import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { server } from '../mocks/server'
import { apiClient } from '../shared/api/client'
import { AppConnectionBoundary } from './AppConnectionBoundary'

let client: QueryClient

afterEach(() => {
  cleanup()
  client?.clear()
})

function Page() {
  const result = useQuery({ queryKey: ['restart-read'],
    queryFn: ({ signal }) => apiClient.request('/api/restart-read', z.object({ value: z.string() }), { signal }) })
  return <>
    <input aria-label="Draft" defaultValue="unsaved" />
    <p>{result.data?.value ?? result.error?.message}</p>
  </>
}

it.each(['network', 502, 503] as const)('automatically recovers reads after %s during a deploy', async failure => {
  let restarting = false
  let reads = 0
  let otherReads = 0
  server.use(
    http.get('/api/restart-read', () => {
      reads++
      if (!restarting) return HttpResponse.json({ value: reads === 1 ? 'Before deploy' : 'After deploy' })
      return failure === 'network' ? HttpResponse.error() : new HttpResponse('Restarting', { status: failure })
    }),
    http.get('/api/other-read', () => {
      otherReads++
      return HttpResponse.json({ value: 'Other data' })
    }),
  )
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  function OtherRead() {
    useQuery({ queryKey: ['other-read'], queryFn: () =>
      apiClient.request('/api/other-read', z.object({ value: z.string() })) })
    return null
  }
  render(<QueryClientProvider client={client}><AppConnectionBoundary>
    <Page /><OtherRead />
  </AppConnectionBoundary></QueryClientProvider>)
  await screen.findByText('Before deploy')
  const draft = screen.getByRole('textbox', { name: 'Draft' })
  restarting = true
  await act(async () => { await client.invalidateQueries({ queryKey: ['restart-read'] }) })
  expect(await screen.findByText('Updating — reconnecting…')).toBeInTheDocument()
  expect(screen.queryByText('The API request could not be completed.')).not.toBeInTheDocument()
  const failedReads = reads
  await waitFor(() => expect(reads).toBeGreaterThan(failedReads), { timeout: 4000 })
  restarting = false
  await screen.findByText('After deploy', {}, { timeout: 4000 })
  await waitFor(() => expect(screen.queryByText('Updating — reconnecting…')).not.toBeInTheDocument())
  await waitFor(() => expect(otherReads).toBeGreaterThan(1))
  expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(draft)
  expect(draft).toHaveValue('unsaved')
})

it.each(['network', 502, 503] as const)('waits calmly for initial access during %s', async failure => {
  let restarting = true
  server.use(http.get('/api/local-human', () => {
    if (restarting) return failure === 'network' ? HttpResponse.error() : new HttpResponse(null, { status: failure })
    return HttpResponse.json({ principal: { id: 'owner', name: 'Browser', expiresAt: '2099-01-01T00:00:00Z',
      grants: [{ actions: ['settings:read'], scope: {} }] } })
  }))
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><AppConnectionBoundary>
    <p>Connected page</p>
  </AppConnectionBoundary></QueryClientProvider>)
  expect(await screen.findByText('Updating — reconnecting…')).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'Cannot reach the server' })).not.toBeInTheDocument()
  restarting = false
  expect(await screen.findByText('Connected page', {}, { timeout: 4000 })).toBeInTheDocument()
})
