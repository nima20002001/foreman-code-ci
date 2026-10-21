import { RuntimeIdentitySchema } from '@foreman-code/contracts'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../mocks/server'
import { bindProtectedChatInstance } from '../shared/api/protectedChatStorage'
import { ApiError, apiClient } from '../shared/api/client'
import { ReleaseAutoReload, RuntimeInstanceBoundary } from './RuntimeInstanceBoundary'
import { useState } from 'react'
import { UnsavedChangesContext, useUnsavedChanges } from '../shared/ui/unsavedChanges'
import { ApiClient } from '../shared/api/client'
import { finishSessionChange } from '../shared/api/sessionBoundary'
import { deferred } from '../test/deferred'
import { z } from 'zod'

vi.mock('../shared/api/protectedChatStorage', async (original) => ({
  ...await original<typeof import('../shared/api/protectedChatStorage')>(), bindProtectedChatInstance: vi.fn(() => false),
}))
vi.mock('../shared/api/documentBuildIdentity', () => ({
  documentBuildIdentity: { version: 1, buildId: 'a'.repeat(64), contractsId: 'b'.repeat(64) },
}))
const buildIdentity = { version: 1, buildId: 'a'.repeat(64), contractsId: 'b'.repeat(64) }
const identity = { installationId: 'd95abeb8-598a-49a4-8c3c-c6e3533053e8', checkoutId: 'a'.repeat(64), databaseId: 'b'.repeat(64) }
const clients: QueryClient[] = []
beforeEach(() => {
  vi.mocked(bindProtectedChatInstance).mockReset().mockReturnValue(false)
  server.use(http.get('*/api/runtime/identity', () => HttpResponse.json(identity)),
    http.get('*/api/runtime/build-identity/v1', () => HttpResponse.json(buildIdentity)))
})
afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  finishSessionChange()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><RuntimeInstanceBoundary>
    <p>Protected content</p>
    <input aria-label="Draft" defaultValue="" />
  </RuntimeInstanceBoundary></QueryClientProvider>)
  return client
}
it('withholds protected content until the local installation is bound', async () => {
  mount()
  expect(screen.queryByText('Protected content')).not.toBeInTheDocument()
  expect(await screen.findByText('Protected content')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Reload app' })).not.toBeInTheDocument()
  expect(bindProtectedChatInstance).toHaveBeenCalledWith(`installation:${identity.installationId}`)
})
it.each(['network', 502, 503] as const)('automatically recovers from an initial %s outage', async (failure) => {
  let requests = 0
  server.use(http.get('*/api/runtime/identity', () => {
    requests += 1
    if (requests > 1) return HttpResponse.json(identity)
    return failure === 'network' ? HttpResponse.error() : new HttpResponse(null, { status: failure })
  }))
  mount()
  expect(await screen.findByText('Reconnecting…')).toBeVisible()
  expect(screen.queryByRole('heading', { name: 'Could not verify this app' })).not.toBeInTheDocument()
  expect(bindProtectedChatInstance).not.toHaveBeenCalled()
  expect(await screen.findByText('Protected content', {}, { timeout: 4_000 })).toBeVisible()
  expect(screen.queryByText('Reconnecting…')).not.toBeInTheDocument()
  expect(requests).toBe(2)
})
it('backs off automatic retries and caps the delay at ten seconds', async () => {
  vi.useFakeTimers()
  const request = vi.spyOn(apiClient, 'request').mockImplementation(async (path) => {
    if (path === '/api/runtime/build-identity/v1') return buildIdentity as never
    throw new ApiError({ code: 'NETWORK_ERROR', message: 'Disconnected' })
  })
  const identityRequests = () => request.mock.calls.filter(([path]) => path === '/api/runtime/identity').length
  mount()
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(identityRequests()).toBe(1)
  let attempts = 1
  for (const delay of [1_000, 2_000, 4_000, 8_000, 10_000, 10_000]) {
    await act(() => vi.advanceTimersByTimeAsync(delay - 1))
    expect(identityRequests()).toBe(attempts)
    await act(() => vi.advanceTimersByTimeAsync(1))
    attempts += 1
    expect(identityRequests()).toBe(attempts)
  }
  expect(screen.getByText('Reconnecting…')).toBeVisible()
  expect(screen.queryByRole('heading', { name: 'Could not verify this app' })).not.toBeInTheDocument()
})
it('keeps the mounted page and draft through an outage and automatically resumes', async () => {
  const client = mount()
  await screen.findByText('Protected content')
  const draft = screen.getByRole('textbox', { name: 'Draft' })
  await userEvent.setup().type(draft, 'Unsaved draft')
  const bindingCalls = vi.mocked(bindProtectedChatInstance).mock.calls.length
  let requests = 0
  server.use(http.get('*/api/runtime/identity', () => {
    requests += 1
    return requests <= 2 ? new HttpResponse(null, { status: 503 }) : HttpResponse.json(identity)
  }))
  void client.invalidateQueries({ queryKey: ['workbench', 'runtime-identity'] })
  expect(await screen.findByText('Reconnecting…')).toBeVisible()
  expect(screen.getByText('Protected content')).toBeVisible()
  expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(draft)
  expect(draft).toHaveValue('Unsaved draft')
  await waitFor(() => expect(screen.queryByText('Reconnecting…')).not.toBeInTheDocument(), { timeout: 5_000 })
  expect(requests).toBe(3)
  expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(draft)
  expect(draft).toHaveValue('Unsaved draft')
  expect(bindProtectedChatInstance).toHaveBeenCalledTimes(bindingCalls)
})
it('hides previously rendered content for a definitive invalid identity response', async () => {
  const client = mount()
  await screen.findByText('Protected content')
  let requests = 0
  server.use(http.get('*/api/runtime/identity', () => {
    requests += 1
    return HttpResponse.json({ ...identity, installationId: 'invalid' })
  }))
  await client.invalidateQueries({ queryKey: ['workbench', 'runtime-identity'] })
  expect(await screen.findByRole('heading', { name: 'Could not verify this app' })).toBeVisible()
  expect(screen.queryByText('Protected content')).not.toBeInTheDocument()
  expect(screen.queryByText('Reconnecting…')).not.toBeInTheDocument()
  expect(requests).toBe(1)
})
it('keeps content hidden on storage failure and allows a real retry', async () => {
  vi.mocked(bindProtectedChatInstance).mockImplementation(() => { throw new Error('storage blocked') })
  mount()
  expect(await screen.findByText('Browser storage is unavailable. Allow storage for this app, then try again.')).toBeVisible()
  expect(screen.queryByText('Protected content')).not.toBeInTheDocument()
  vi.mocked(bindProtectedChatInstance).mockReturnValue(false)
  await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(screen.getByText('Protected content')).toBeVisible())
})

function mountReleaseWatcher(unsaved: () => boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const guard = { request: async () => true, surfaces: async () => true, changed: vi.fn(), register: () => () => {}, unsaved }
  render(<QueryClientProvider client={client}><RuntimeInstanceBoundary>
    <UnsavedChangesContext.Provider value={guard}><ReleaseAutoReload /><input aria-label="Draft" defaultValue="" /></UnsavedChangesContext.Provider>
  </RuntimeInstanceBoundary></QueryClientProvider>)
  return client
}
function stubReload() {
  const reload = vi.fn()
  vi.stubGlobal('location', { ...window.location, reload })
  return reload
}

it('reloads silently after a release when nothing is unsaved', async () => {
  const reload = stubReload()
  const client = mountReleaseWatcher(() => false)
  await screen.findByRole('textbox', { name: 'Draft' })
  expect(reload).not.toHaveBeenCalled()
  server.use(http.get('*/api/runtime/build-identity/v1', () => HttpResponse.json({ ...buildIdentity, buildId: 'c'.repeat(64) })))
  await act(async () => { await client.invalidateQueries({ queryKey: ['workbench', 'runtime-build-identity'] }) })
  await waitFor(() => expect(reload).toHaveBeenCalledOnce())
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  vi.unstubAllGlobals()
})

it('waits for unsaved edits to settle before reloading an updated app', async () => {
  const reload = stubReload()
  let dirty = true
  const client = mountReleaseWatcher(() => dirty)
  const draft = await screen.findByRole('textbox', { name: 'Draft' })
  await userEvent.setup().type(draft, 'Unsaved draft')
  vi.useFakeTimers({ shouldAdvanceTime: true })
  server.use(http.get('*/api/runtime/build-identity/v1', () => HttpResponse.json({ ...buildIdentity, buildId: 'c'.repeat(64) })))
  await act(async () => { await client.invalidateQueries({ queryKey: ['workbench', 'runtime-build-identity'] }) })
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
  expect(reload).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(draft)
  expect(draft).toHaveValue('Unsaved draft')
  dirty = false
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
  expect(reload).toHaveBeenCalledOnce()
  vi.unstubAllGlobals()
})

it('hides the previous document state when the database installation changes', async () => {
  const client = mount()
  await screen.findByText('Protected content')
  await userEvent.setup().type(screen.getByRole('textbox', { name: 'Draft' }), 'Previous installation draft')
  vi.mocked(bindProtectedChatInstance).mockImplementation(() => { throw new Error('Different installation') })
  server.use(http.get('*/api/runtime/identity', () => HttpResponse.json({
    ...identity, installationId: 'a95abeb8-598a-49a4-8c3c-c6e3533053e8',
  })))
  await act(async () => { await client.invalidateQueries({ queryKey: ['workbench', 'runtime-identity'] }) })
  expect(screen.queryByText('Protected content')).not.toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: 'Draft' })).not.toBeInTheDocument()
  expect(await screen.findByRole('heading', { name: 'Could not verify this app' })).toBeVisible()
})

it('detects a changed build at first contact before mounting protected operations', async () => {
  const reload = stubReload()
  server.use(http.get('*/api/runtime/build-identity/v1', () => HttpResponse.json({
    ...buildIdentity, buildId: 'c'.repeat(64), contractsId: 'd'.repeat(64),
  })))
  mountReleaseWatcher(() => false)
  await waitFor(() => expect(reload).toHaveBeenCalled())
  expect(screen.queryByRole('textbox', { name: 'Draft' })).not.toBeInTheDocument()
  vi.unstubAllGlobals()
})

function RegisteredDraft() {
  const [value, setValue] = useState('Unsaved draft')
  useUnsavedChanges({ label: 'Workflow draft', dirty: value.length > 0, save: () => undefined,
    discard: () => setValue('') })
  return <input aria-label="Registered draft" value={value} onChange={event => setValue(event.target.value)} />
}

it('keeps a registered dirty editor mounted when a new build arrives and reloads only after it is clean', async () => {
  const reload = stubReload()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const editors = new Map<string, import('../shared/ui/unsavedChanges').EditorRegistration>()
  const guard = { request: async () => true, surfaces: async () => true, changed: vi.fn(),
    register: (id: string, editor: import('../shared/ui/unsavedChanges').EditorRegistration) => {
      editors.set(id, editor)
      return () => { editors.delete(id) }
    }, unsaved: () => [...editors.values()].some(({ current }) => current.dirty || current.busy || current.uncertain) }
  render(<QueryClientProvider client={client}><RuntimeInstanceBoundary>
    <UnsavedChangesContext.Provider value={guard}><ReleaseAutoReload /><RegisteredDraft /></UnsavedChangesContext.Provider>
  </RuntimeInstanceBoundary></QueryClientProvider>)
  const draft = await screen.findByRole('textbox', { name: 'Registered draft' })
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  server.use(http.get('*/api/runtime/build-identity/v1', () => HttpResponse.json({ ...buildIdentity, buildId: 'c'.repeat(64), contractsId: 'd'.repeat(64) })))
  await act(async () => { await client.invalidateQueries({ queryKey: ['workbench', 'runtime-build-identity'] }) })
  await screen.findByText('App updated. Your pending changes are kept until it can reload.')
  expect(reload).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox', { name: 'Registered draft' })).toBe(draft)
  expect(draft).toHaveValue('Unsaved draft')
  await expect(apiClient.request('/api/workspaces', RuntimeIdentitySchema)).rejects.toMatchObject({ code: 'APP_UPDATED' })
  await userEvent.setup().clear(draft)
  await act(async () => { await vi.advanceTimersByTimeAsync(4_999) })
  expect(reload).not.toHaveBeenCalled()
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(reload).toHaveBeenCalledOnce()
  vi.unstubAllGlobals()
})

it('compares the loaded bundle when its first identity response is delayed until after a release', async () => {
  const reload = stubReload()
  let releaseIdentity: (() => void) | undefined
  const delayed = new Promise<void>(resolve => { releaseIdentity = resolve })
  server.use(http.get('*/api/runtime/identity', async () => {
    await delayed
    return HttpResponse.json(identity)
  }), http.get('*/api/runtime/build-identity/v1', () => HttpResponse.json({ ...buildIdentity, buildId: 'c'.repeat(64) })))
  mountReleaseWatcher(() => false)
  expect(screen.queryByRole('textbox', { name: 'Draft' })).not.toBeInTheDocument()
  await act(async () => { releaseIdentity?.() })
  await waitFor(() => expect(reload).toHaveBeenCalled())
  expect(screen.queryByRole('textbox', { name: 'Draft' })).not.toBeInTheDocument()
  vi.unstubAllGlobals()
})

it('aborts old requests, clears protected caches and rejects delayed responses after an installation change', async () => {
  const reload = stubReload()
  const cache = mount()
  await screen.findByText('Protected content')
  cache.setQueryData(['protected-record'], { secret: 'old installation' })
  const pending = deferred<Response>()
  let signal: AbortSignal | null | undefined
  const client = new ApiClient({ fetch: async (_url, options) => {
    signal = options?.signal
    return pending.promise
  } })
  const result = client.request('/api/management/workspaces', z.object({ ok: z.boolean() }))
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
  vi.mocked(bindProtectedChatInstance).mockReturnValue(true)
  server.use(http.get('*/api/runtime/identity', () => HttpResponse.json({
    ...identity, installationId: '8b8fe654-6e4a-4d4c-b451-2795ccbf7074',
  })))
  await act(async () => { await cache.invalidateQueries({ queryKey: ['workbench', 'runtime-identity'] }) })
  await waitFor(() => expect(reload).toHaveBeenCalledOnce())
  expect(signal?.aborted).toBe(true)
  expect(cache.getQueryData(['protected-record'])).toBeUndefined()
  pending.resolve(new Response(JSON.stringify({ ok: true })))
  await rejected
})
