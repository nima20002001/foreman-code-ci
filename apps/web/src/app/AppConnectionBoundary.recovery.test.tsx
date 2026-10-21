import { QueryClient, QueryClientProvider, onlineManager, useQuery } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { server } from '../mocks/server'
import { deferred } from '../test/deferred'
import { apiClient } from '../shared/api/client'
import { settingsExperienceKeys } from '../shared/api/settingsExperience'
import { UnsavedChangesContext } from '../shared/ui/unsavedChanges'
import { AppConnectionBoundary } from './AppConnectionBoundary'
import { ReleaseAutoReload } from './RuntimeInstanceBoundary'

let client: QueryClient
const unavailable = () => HttpResponse.json({ error: {
  code: 'SESSION_CHECK_FAILED', message: 'Connection interrupted.',
} }, { status: 503 })

afterEach(() => {
  cleanup()
  client?.clear()
  onlineManager.setOnline(true)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function Page() {
  const read = useQuery({ queryKey: ['recovery-page'], queryFn: ({ signal }) =>
    apiClient.request('/api/recovery-page', z.object({ value: z.string() }), { signal }) })
  return <><input aria-label="Unsaved draft" defaultValue="Keep this draft" /><p>{read.data?.value}</p></>
}

function mount(unsaved = () => false) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const guard = { request: async () => true, surfaces: async () => true, changed: () => {},
    register: () => () => {}, unsaved }
  render(<QueryClientProvider client={client}><AppConnectionBoundary>
    <UnsavedChangesContext.Provider value={guard}><ReleaseAutoReload /><Page /></UnsavedChangesContext.Provider>
  </AppConnectionBoundary></QueryClientProvider>)
}

function RetryingRead() {
  const read = useQuery({ queryKey: ['retrying-read'], queryFn: ({ signal }) =>
    apiClient.request('/api/retrying-read', z.object({ value: z.string() }), { signal }) })
  return <p>{read.isPending ? 'Retry read pending' : read.error?.message ?? read.data?.value}</p>
}

it('refreshes healthy reads only after a failed read actually recovers, not while its retry is pending', async () => {
  const retryStarted = deferred()
  const retryResponse = deferred()
  const healthyResponse = deferred()
  let attempts = 0
  let healthyReads = 0
  server.use(
    http.get('/api/recovery-page', async () => {
      healthyReads++
      if (healthyReads > 1) await healthyResponse.promise
      return HttpResponse.json({ value: 'Healthy page' })
    }),
    http.get('/api/retrying-read', async () => {
      attempts++
      if (attempts === 1) return unavailable()
      retryStarted.resolve()
      await retryResponse.promise
      return HttpResponse.json({ value: 'Recovered read' })
    }),
  )
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const view = render(<QueryClientProvider client={client}><AppConnectionBoundary>
    <Page /><RetryingRead />
  </AppConnectionBoundary></QueryClientProvider>)
  try {
    await screen.findByText('Healthy page')
    await screen.findByText('Connection interrupted.')
    expect(healthyReads).toBe(1)
    let retry!: Promise<void>
    await act(async () => {
      retry = client.refetchQueries({ queryKey: ['retrying-read'], exact: true })
      await retryStarted.promise
    })
    expect(await screen.findByText('Retry read pending')).toBeVisible()
    expect(client.getQueryState(['recovery-page'])).toMatchObject({ isInvalidated: false, fetchStatus: 'idle' })
    expect(healthyReads).toBe(1)
    await act(async () => {
      retryResponse.resolve()
      await retry
    })
    expect(await screen.findByText('Recovered read')).toBeVisible()
    await waitFor(() => expect(healthyReads).toBe(2))
    healthyResponse.resolve()
    await waitFor(() => expect(client.isFetching({ queryKey: ['recovery-page'] })).toBe(0))
    expect(healthyReads).toBe(2)
  } finally {
    retryResponse.resolve()
    healthyResponse.resolve()
    view.unmount()
    await client.cancelQueries()
  }
})

it('recovers a structured server outage and refreshes mounted reads without a reload or manual retry', async () => {
  let available = true
  let value = 'Before restart'
  server.use(http.get('/api/recovery-page', () => HttpResponse.json({ value })))
  mount()
  await screen.findByText('Before restart')
  const draft = screen.getByRole('textbox', { name: 'Unsaved draft' })
  server.use(http.get('/api/local-human', () => available ? HttpResponse.json({ principal: {
    id: 'browser-owner', name: 'Browser', expiresAt: '2099-01-01T00:00:00Z',
    grants: [{ actions: ['settings:read'], scope: {} }],
  } }) : unavailable()))
  available = false
  await act(async () => { await client.invalidateQueries({ queryKey: settingsExperienceKeys.access() }) })
  expect(await screen.findByRole('alert', { name: 'Server connection' })).toBeVisible()
  value = 'After restart'
  available = true
  expect(await screen.findByText('After restart', {}, { timeout: 4_000 })).toBeVisible()
  await waitFor(() => expect(screen.queryByRole('alert', { name: 'Server connection' })).not.toBeInTheDocument())
  expect(screen.getByRole('textbox', { name: 'Unsaved draft' })).toBe(draft)
  expect(draft).toHaveValue('Keep this draft')
})

it('probes a paused connection and resumes queries when the API returns without a browser online event', async () => {
  let available = true
  let value = 'Before disconnect'
  server.use(http.get('/api/recovery-page', () => available
    ? HttpResponse.json({ value }) : HttpResponse.error()))
  mount()
  await screen.findByText('Before disconnect')
  const draft = screen.getByRole('textbox', { name: 'Unsaved draft' })
  available = false
  server.use(http.get('/api/runtime/identity', () => HttpResponse.error()))
  await act(async () => { await client.invalidateQueries({ queryKey: ['recovery-page'] }) })
  expect(await screen.findByText('Updating — reconnecting…')).toBeVisible()
  act(() => { window.dispatchEvent(new Event('offline')) })
  // The API becomes reachable without Chrome delivering another connectivity event.
  server.resetHandlers()
  value = 'After disconnect'
  available = true
  server.use(http.get('/api/recovery-page', () => HttpResponse.json({ value })))
  expect(await screen.findByText('After disconnect', {}, { timeout: 4_000 })).toBeVisible()
  await waitFor(() => expect(screen.queryByText('Updating — reconnecting…')).not.toBeInTheDocument())
  expect(screen.getByRole('textbox', { name: 'Unsaved draft' })).toBe(draft)
})

it('checks the deployed build after recovery and uses the existing guarded app reload', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const reload = vi.fn()
  vi.stubGlobal('location', { ...window.location, reload })
  let available = true
  let dirty = true
  server.use(http.get('/api/recovery-page', () => available
    ? HttpResponse.json({ value: 'Connected page' }) : unavailable()))
  mount(() => dirty)
  await screen.findByText('Connected page')
  const draft = screen.getByRole('textbox', { name: 'Unsaved draft' })
  available = false
  await act(async () => { await client.invalidateQueries({ queryKey: ['recovery-page'] }) })
  server.use(http.get('/api/runtime/build-identity/v1', () => HttpResponse.json({
    version: 1, buildId: 'c'.repeat(64), contractsId: 'd'.repeat(64),
  })))
  available = true
  expect(await screen.findByText('App updated. Your pending changes are kept until it can reload.',
    {}, { timeout: 4_000 })).toBeVisible()
  expect(reload).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox', { name: 'Unsaved draft' })).toBe(draft)
  dirty = false
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
  expect(reload).toHaveBeenCalledOnce()
})

it('detects a release within seconds after a long API outage while runtime reads are backing off', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const reload = vi.fn()
  vi.stubGlobal('location', { ...window.location, reload })
  let available = true
  let released = false
  server.use(
    http.get('/api/*', () => available ? undefined : HttpResponse.error()),
    http.get('/api/recovery-page', () => HttpResponse.json({ value: 'Connected page' })),
    http.get('/api/runtime/build-identity/v1', () => HttpResponse.json({
      version: 1, buildId: (released ? 'c' : 'a').repeat(64), contractsId: 'b'.repeat(64),
    })),
  )
  mount(() => true)
  await screen.findByText('Connected page')
  const draft = screen.getByRole('textbox', { name: 'Unsaved draft' })
  available = false
  await act(async () => { void client.invalidateQueries() })
  await act(async () => { await vi.advanceTimersByTimeAsync(56_000) })
  expect(screen.getByText('Updating — reconnecting…')).toBeVisible()
  available = true
  released = true
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
  expect(screen.getByText('App updated. Your pending changes are kept until it can reload.')).toBeVisible()
  expect(screen.queryByText('Updating — reconnecting…')).not.toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Unsaved draft' })).toBe(draft)
  expect(reload).not.toHaveBeenCalled()
})
