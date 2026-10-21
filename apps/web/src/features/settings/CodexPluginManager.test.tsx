import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { routeTree } from '../../app/router'
import { server } from '../../mocks/server'
import { harnessSettingsKeys } from '../../shared/api/harnessSettings'
import { deferred } from '../../test/deferred'

const revision = 'sha256:' + 'a'.repeat(64)
const artifactIdentity = 'sha256:' + 'b'.repeat(64)
const checkedAt = '2026-09-20T00:00:00.000Z'
const base = { pluginId: 'notes@trusted', name: 'notes', marketplaceName: 'trusted', version: '1.0.0',
  enabled: true, sourceType: 'remote', installPolicy: 'AVAILABLE', authPolicy: 'ON_INSTALL', verification: 'catalog' }
const clients: QueryClient[] = []
beforeEach(() => {
  server.use(http.get('/api/management/harnesses/claude/setup-options', () => HttpResponse.json({
    graphqlMcp: { type: 'http', url: 'http://127.0.0.1:3999/mcp' },
  })))
})
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()); sessionStorage.clear() })
function mount(path: string, reuse?: QueryClient) {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
  const client = reuse ?? new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  if (!reuse) clients.push(client)
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return { router, client }
}
const listPayload = (installed = false, currentRevision = revision) => ({ items: [{ ...base, installed }], total: 1, nextOffset: null,
  revision: currentRevision, checkedAt, catalogStatus: 'complete', inventoryStatus: 'unknown' })
const detailPayload = (installed = false, currentRevision = revision) => ({ plugin: { ...base, installed }, revision: currentRevision, artifactIdentity,
  contents: installed ? { status: 'known', skills: ['summarize'], hooks: [], mcpServers: ['notes-mcp'], apps: [] } : { status: 'unknown' } })
function reads() {
  server.use(
    http.get('/api/management/harnesses/codex/plugins', () => HttpResponse.json(listPayload())),
    http.get('/api/management/harnesses/codex/plugins/operations', () => HttpResponse.json({ items: [] })),
    http.get('/api/management/harnesses/codex/plugins/:pluginId', () => HttpResponse.json(detailPayload())),
  )
}
async function openPlugin() {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'View notes plugin, available' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Install plugin' })).toBeEnabled())
  return user
}
it('discovers, installs, and removes using the exact reviewed snapshot', async () => {
  let installed = false
  const changes: Array<Record<string, unknown>> = []
  server.use(
    http.get('/api/management/harnesses/codex/plugins', ({ request }) => {
      const visible = (new URL(request.url).searchParams.get('view') === 'installed') === installed
      const payload = listPayload(installed)
      return HttpResponse.json({ ...payload, items: visible ? payload.items : [], total: visible ? 1 : 0 })
    }),
    http.get('/api/management/harnesses/codex/plugins/operations', () => HttpResponse.json({ items: [] })),
    http.get('/api/management/harnesses/codex/plugins/:pluginId', () => HttpResponse.json(detailPayload(installed))),
    http.post('/api/management/harnesses/codex/plugins/change', async ({ request }) => {
      const input = await request.json() as Record<string, unknown>; changes.push(input)
      installed = input.action === 'install'
      return HttpResponse.json({ pluginId: base.pluginId, action: input.action, status: 'applied', message: installed ? 'Installed in Codex.' : 'Removed from Codex.' })
    }),
  )
  const user = userEvent.setup()
  const { router } = mount('/settings/harnesses?harness=codex&section=plugins')
  await user.click(await screen.findByRole('button', { name: 'Discover' }, { timeout: 10_000 }))
  expect(await screen.findByRole('button', { name: 'View notes plugin, available' })).toHaveTextContent(/^notes$/)
  await openPlugin()
  expect(screen.getByRole('dialog', { name: 'notes plugin' })).not.toHaveTextContent('Bundle contents can be checked after installation.')
  await user.hover(screen.getByRole('button', { name: 'About Bundle contents' }))
  expect(screen.getByRole('tooltip')).toHaveTextContent('Bundle contents can be checked after installation.')
  await user.unhover(screen.getByRole('button', { name: 'About Bundle contents' }))
  await user.click(screen.getByRole('button', { name: 'Install plugin' }))
  const card = await screen.findByRole('button', { name: 'View notes plugin, installed' })
  expect(screen.getByRole('dialog', { name: 'notes plugin' })).toHaveTextContent('summarize')
  await user.click(screen.getByRole('button', { name: /^Close$/ }))
  await waitFor(() => expect(card).toHaveFocus())
  await user.click(card)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Remove plugin' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: 'Remove plugin' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'notes plugin' })).not.toBeInTheDocument())
  expect(changes.map((input) => input.action)).toEqual(['install', 'remove'])
  for (const input of changes) expect(input).toMatchObject({ expectedRevision: revision, artifactIdentity })
  expect(changes[0]?.commandId).not.toBe(changes[1]?.commandId)
  expect(router.state.location.search.pluginId).toBeUndefined()
}, 20_000)
it('opens Codex plugins only for Codex', async () => {
  mount('/settings/harnesses?harness=claude&section=plugins')
  expect(await screen.findByRole('heading', { name: 'Harnesses' })).toBeVisible()
  expect(screen.queryByRole('dialog', { name: 'Codex plugins' })).not.toBeInTheDocument()
})
it('retains a lost command through Refresh and panel remount, then retries its exact payload', async () => {
  reads()
  const requests: Array<Record<string, unknown>> = []
  server.use(http.post('/api/management/harnesses/codex/plugins/change', async ({ request }) => {
    const input = await request.json() as Record<string, unknown>; requests.push(input)
    return requests.length === 1 ? HttpResponse.error()
      : HttpResponse.json({ pluginId: base.pluginId, action: 'install', status: 'uncertain', message: 'The original write remains unresolved.' })
  }))
  const { client } = mount('/settings/harnesses?harness=codex&section=plugins&pluginView=available')
  const user = await openPlugin()
  await user.click(screen.getByRole('button', { name: 'Install plugin' }))
  await screen.findByRole('button', { name: 'Retry original request' })
  await user.click(screen.getByRole('button', { name: /^Close$/ }))
  await user.click(screen.getByRole('button', { name: /^Refresh$/ }))
  expect(await screen.findByRole('button', { name: 'Retry original request' })).toBeEnabled()
  cleanup()
  mount('/settings/harnesses?harness=codex&section=plugins&pluginView=available', client)
  await user.click(await screen.findByRole('button', { name: 'Retry original request' }))
  await waitFor(() => expect(requests).toHaveLength(2))
  expect(requests[1]).toEqual(requests[0])
  await user.click(await screen.findByRole('button', { name: 'View notes plugin, available' }))
  expect(screen.getByRole('button', { name: 'Install plugin' })).toBeDisabled()
}, 20_000)
it('does not turn Refresh into reconciliation and never executes another install during reconciliation', async () => {
  reads()
  let writes = 0; let reconciliations = 0
  server.use(
    http.post('/api/management/harnesses/codex/plugins/change', () => { writes++; return HttpResponse.json({ pluginId: base.pluginId, action: 'install', status: 'uncertain', message: 'The install or removal may have completed.' }) }),
    http.post('/api/management/harnesses/codex/plugins/reconcile', () => { reconciliations++; return HttpResponse.json({ pluginId: base.pluginId, action: 'install', status: 'reconciled', message: 'Current state recorded without another write.' }) }),
  )
  mount('/settings/harnesses?harness=codex&section=plugins&pluginView=available')
  const user = await openPlugin()
  await user.click(screen.getByRole('button', { name: 'Install plugin' }))
  await screen.findByRole('button', { name: 'Reconcile original request' })
  await user.click(screen.getByRole('button', { name: /^Close$/ }))
  await user.click(screen.getByRole('button', { name: /^Refresh$/ }))
  expect(writes).toBe(1); expect(reconciliations).toBe(0)
  await user.click(await screen.findByRole('button', { name: 'Reconcile original request' }))
  await waitFor(() => expect(reconciliations).toBe(1))
  expect(writes).toBe(1)
}, 20_000)
it('rehydrates an unresolved server receipt after a fresh page lifetime', async () => {
  reads()
  const input = { pluginId: base.pluginId, action: 'remove', commandId: '00000000-0000-4000-8000-000000000001', expectedRevision: revision, artifactIdentity }
  server.use(http.get('/api/management/harnesses/codex/plugins/operations', () => HttpResponse.json({ items: [{
    requestedBy: '00000000-0000-4000-8000-000000000002', commandId: input.commandId, input,
    result: { pluginId: base.pluginId, action: 'remove', status: 'uncertain', message: 'Earlier removal remains unresolved.' },
  }] })))
  mount('/settings/harnesses?harness=codex&section=plugins&pluginView=available')
  expect(await screen.findByRole('button', { name: 'Reconcile original request' })).toBeVisible()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'View notes plugin, available' }))
  expect(await screen.findByRole('button', { name: 'Install plugin' })).toBeDisabled()
})
it('does not combine newer list revisions with delayed old details', async () => {
  reads()
  const { client } = mount('/settings/harnesses?harness=codex&section=plugins&pluginView=available')
  await openPlugin()
  const next = 'sha256:' + 'c'.repeat(64)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const detailRequested = deferred()
  server.use(
    http.get('/api/management/harnesses/codex/plugins', () => HttpResponse.json(listPayload(false, next))),
    http.get('/api/management/harnesses/codex/plugins/operations', () => HttpResponse.json({ items: [] })),
    http.get('/api/management/harnesses/codex/plugins/:pluginId', async () => {
      detailRequested.resolve()
      await gate
      return HttpResponse.json(detailPayload(false, next))
    }),
  )
  const listUpdated = deferred()
  const disabled = deferred()
  const install = screen.getByRole('button', { name: 'Install plugin' })
  const observer = new MutationObserver(() => {
    if (install.hasAttribute('disabled')) disabled.resolve()
  })
  observer.observe(install, { attributes: true, attributeFilter: ['disabled'] })
  const unsubscribe = client.getQueryCache().subscribe(event => {
    if (event.query.queryKey.includes('codex-plugins')
      && (event.query.state.data as { revision?: string } | undefined)?.revision === next) listUpdated.resolve()
  })
  let refreshing: Promise<void> | undefined
  try {
    await act(async () => {
      refreshing = client.invalidateQueries({ queryKey: harnessSettingsKeys.root })
      await Promise.all([listUpdated.promise, detailRequested.promise])
    })
    // Query cache completion can precede the batched observer render.
    await disabled.promise
    expect(screen.getByRole('button', { name: 'Install plugin' })).toBeDisabled()
  } finally {
    observer.disconnect()
    unsubscribe()
    release()
    await act(async () => { await refreshing })
  }
  await waitFor(() => expect(screen.getByRole('button', { name: 'Install plugin' })).toBeEnabled())
}, 20_000)
it.each(['list', 'detail'])('keeps protected content hidden through success → 403 → 503 for %s', async (target) => {
  reads()
  const { client } = mount('/settings/harnesses?harness=codex&section=plugins&pluginView=available')
  await openPlugin()
  for (const status of [403, 503]) {
    server.use(http.get('/api/management/harnesses/codex/plugins/operations', () => HttpResponse.json({ items: [] })),
      http.get(target === 'list' ? '/api/management/harnesses/codex/plugins' : '/api/management/harnesses/codex/plugins/:pluginId', () => HttpResponse.json({ error: { code: status === 403 ? 'ACCESS_DENIED' : 'UNAVAILABLE', message: 'Unavailable' } }, { status })))
    await client.invalidateQueries({ queryKey: harnessSettingsKeys.root })
    expect(await screen.findByText('Plugin access unavailable')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Install plugin' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /View notes plugin/ })).not.toBeInTheDocument()
    expect(within(screen.getByRole('dialog', { name: 'Plugin details' })).queryByText('trusted')).not.toBeInTheDocument()
  }
  reads(); await client.invalidateQueries({ queryKey: harnessSettingsKeys.root })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Install plugin' })).toBeEnabled())
}, 20_000)
it('debounces rapid typing before starting another catalog read', async () => {
  reads()
  const queries: string[] = []
  server.use(http.get('/api/management/harnesses/codex/plugins', ({ request }) => {
    queries.push(new URL(request.url).searchParams.get('query') ?? '')
    return HttpResponse.json(listPayload())
  }))
  mount('/settings/harnesses?harness=codex&section=plugins&pluginView=available')
  await screen.findByRole('button', { name: 'View notes plugin, available' })
  await userEvent.setup().type(screen.getByRole('searchbox', { name: 'Search plugins' }), 'notes')
  await waitFor(() => expect(queries.at(-1)).toBe('notes'))
  expect(queries.filter(Boolean)).toEqual(['notes'])
})

it('shows a rejected change and refresh recovery inside the active plugin dialog', async () => {
  reads()
  server.use(http.post('/api/management/harnesses/codex/plugins/change', () => HttpResponse.json({
    error: { code: 'REVISION_CONFLICT', message: 'The plugin source changed. Review refreshed details.' },
  }, { status: 409 })))
  mount('/settings/harnesses?harness=codex&section=plugins&pluginView=available')
  const user = await openPlugin()
  await user.click(screen.getByRole('button', { name: 'Install plugin' }))
  const dialog = within(screen.getByRole('dialog', { name: 'notes plugin' }))
  expect(await dialog.findByRole('alert')).toHaveTextContent('The plugin source changed. Review refreshed details.')
  expect(dialog.getByRole('button', { name: 'Refresh list and details' })).toBeEnabled()
  expect(dialog.queryByRole('button', { name: 'Reconcile original request' })).not.toBeInTheDocument()
})

it('disables installation and explains an incomplete catalog inside the detail dialog', async () => {
  reads()
  server.use(http.get('/api/management/harnesses/codex/plugins', () =>
    HttpResponse.json({ ...listPayload(), catalogStatus: 'partial' })))
  mount('/settings/harnesses?harness=codex&section=plugins&pluginView=available&pluginId=notes%40trusted')
  const dialog = within(await screen.findByRole('dialog', { name: 'notes plugin' }))
  expect(await dialog.findByText('Installation unavailable')).toBeVisible()
  expect(dialog.getByRole('button', { name: 'Install plugin' })).toBeDisabled()
  expect(dialog.getByText(/The catalog is incomplete/)).toBeVisible()
})

it('awaits a fresh catalog on Refresh before updating the reviewed detail snapshot', async () => {
  reads()
  let fresh = false
  let refreshRequested = false
  const detailReads: boolean[] = []
  const changes: Array<Record<string, unknown>> = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const next = 'sha256:' + 'c'.repeat(64)
  server.use(
    http.get('/api/management/harnesses/codex/plugins', async ({ request }) => {
      if (new URL(request.url).searchParams.get('refresh') === 'true') {
        refreshRequested = true
        await gate
        fresh = true
      }
      return HttpResponse.json(listPayload(fresh, fresh ? next : revision))
    }),
    http.get('/api/management/harnesses/codex/plugins/operations', () => HttpResponse.json({ items: [] })),
    http.get('/api/management/harnesses/codex/plugins/:pluginId', () => {
      detailReads.push(fresh)
      return HttpResponse.json(detailPayload(fresh, fresh ? next : revision))
    }),
    http.post('/api/management/harnesses/codex/plugins/change', async ({ request }) => {
      changes.push(await request.json() as Record<string, unknown>)
      return HttpResponse.json({ pluginId: base.pluginId, action: 'remove', status: 'applied',
        message: 'Removed from Codex.' })
    }),
  )
  mount('/settings/harnesses?harness=codex&section=plugins&pluginView=available')
  const user = await openPlugin()
  const dialog = within(screen.getByRole('dialog', { name: 'notes plugin' }))
  const refresh = dialog.getByRole('button', { name: 'Refresh plugin' })
  await waitFor(() => expect(refresh).toBeEnabled())
  expect(detailReads).toEqual([false])
  try {
    await user.click(refresh)
    await waitFor(() => expect(refreshRequested).toBe(true))
    expect(refresh).toBeDisabled()
    expect(dialog.getByRole('button', { name: 'Install plugin' })).toBeDisabled()
    expect(detailReads).toEqual([false])
  } finally {
    release()
  }
  await waitFor(() => expect(dialog.getByRole('button', { name: 'Remove plugin' })).toBeEnabled())
  const remove = dialog.getByRole('button', { name: 'Remove plugin' })
  expect(dialog.getByText('summarize')).toBeVisible()
  expect(detailReads[0]).toBe(false)
  expect(detailReads.slice(1)).toContain(true)
  expect(detailReads.slice(1)).not.toContain(false)
  await user.click(remove)
  await waitFor(() => expect(changes).toEqual([expect.objectContaining({
    pluginId: base.pluginId, action: 'remove', expectedRevision: next, artifactIdentity,
  })]))
}, 20_000)
