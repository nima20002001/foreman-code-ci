import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { queryKeys } from '../../shared/api/query'
import { UnsavedChangesProvider } from '../../shared/ui/UnsavedChangesProvider'
import { renderWithRouter } from '../../test/renderWithRouter'
import { HarnessDefaultsSettings } from './HarnessDefaultsSettings'
import { accountTarget, accountTargetInfo } from '../provider-accounts/providerAccounts.fixtures'

const revision = 'sha256:' + 'a'.repeat(64)
const checkedAt = '2026-09-20T00:00:00.000Z'
const catalog = [{ harness: 'codex', defaults: DEFAULT_HARNESS_DEFAULTS.codex, defaultsRevision: 4,
  capability: null, discoveryError: null }]
const clients: QueryClient[] = []
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
})

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const rendered = renderWithRouter(<QueryClientProvider client={client}>
    <UnsavedChangesProvider><HarnessDefaultsSettings selectedHarness="codex" section="connections" /></UnsavedChangesProvider>
  </QueryClientProvider>)
  clients.push(rendered.queryClient)
  return client
}

function nativeReaders() {
  server.use(
    http.get('/api/provider-accounts/targets', () => HttpResponse.json({ targets: [accountTargetInfo()] })),
    http.get('/api/provider-accounts', () => HttpResponse.json({ revision: 1, accounts: [] })),
    http.get('/api/provider-accounts/page', () => HttpResponse.json({ target: accountTarget,
      revision: 1, accounts: [], defaults: [], nextCursor: null })),
    http.get('/api/management/harnesses/codex/mcp', () => HttpResponse.json({
      harness: 'codex', revision, checkedAt, scope: 'native-user',
      servers: [{ name: 'private-tools', transport: 'stdio', label: 'tools', enabled: true,
        origin: 'user', protected: false, editable: true }], presets: { graphql: 'missing', linear: 'missing' },
    })),
    http.get('/api/management/harnesses/codex/mcp/plans', () => HttpResponse.json({ items: [] })),
    http.get('/api/management/harnesses/claude/setup-options', () => HttpResponse.json({
      graphqlMcp: { type: 'http', url: 'http://127.0.0.1:3000/mcp' },
    })),
  )
}

it('opens native connections while the unrelated harness catalog is still loading', async () => {
  let finish!: () => void
  const held = new Promise<void>((resolve) => { finish = resolve })
  server.use(http.get('/api/management/harnesses', async () => {
    await held
    return HttpResponse.json(catalog)
  }))
  nativeReaders()
  mount()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add server' })).toBeEnabled())
  expect(screen.getByText('Loading harness defaults…')).toBeInTheDocument()
  expect(screen.getByRole('region', { name: 'Codex accounts' })).toBeVisible()
  expect(screen.getByRole('region', { name: 'Claude accounts' })).toBeVisible()
  expect(screen.getByRole('dialog', { name: 'Codex connections' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
  expect(screen.getByRole('textbox', { name: 'Server name' })).toBeVisible()
  finish()
  await waitFor(() => expect(screen.queryByText('Loading harness defaults…')).not.toBeInTheDocument())
})

it('retains the edited connection and its close guard across a background catalog failure and recovery', async () => {
  let unavailable = false
  server.use(http.get('/api/management/harnesses', () => unavailable
    ? HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Catalog could not update' } }, { status: 503 })
    : HttpResponse.json(catalog)))
  nativeReaders()
  const client = mount()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add server' })).toBeEnabled())
  await screen.findByText('Harnesses')
  fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Server name' }), { target: { value: 'draft-tools' } })
  unavailable = true
  await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.managedHarnessCatalog }) })
  expect(await screen.findByText("Harness defaults couldn't update")).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Server name' })).toHaveValue('draft-tools')
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Add Codex MCP server' })).getByRole('button', { name: 'Close dialog' }))
  expect(await screen.findByRole('alertdialog', { name: 'Save changes before leaving?' })).toBeVisible()
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Close dialog' }))
  unavailable = false
  await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.managedHarnessCatalog }) })
  expect(screen.getByRole('textbox', { name: 'Server name' })).toHaveValue('draft-tools')
})

it('keeps the local connection draft after access loss while hiding cached server data until access returns', async () => {
  let outcome: 'ready' | 'denied' | 'unavailable' = 'ready'
  server.use(http.get('/api/management/harnesses', () => {
    if (outcome === 'ready') return HttpResponse.json(catalog)
    const denied = outcome === 'denied'
    return HttpResponse.json({ error: { code: denied ? 'ACCESS_DENIED' : 'UNAVAILABLE',
      message: denied ? 'Harness access was removed' : 'Catalog unavailable' } }, { status: denied ? 403 : 503 })
  }))
  nativeReaders()
  const client = mount()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add server' })).toBeEnabled())
  await screen.findByText('Harnesses')
  expect(screen.getByRole('button', { name: 'View details for private-tools, Enabled' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Server name' }), { target: { value: 'draft-tools' } })
  outcome = 'denied'
  await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.managedHarnessCatalog }) })
  await screen.findByText('Connection access is unavailable')
  expect(screen.queryByRole('button', { name: 'View details for private-tools, Enabled' })).not.toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Server name' })).toHaveValue('draft-tools')
  expect(screen.getByRole('button', { name: 'Review connection' })).toBeDisabled()
  outcome = 'unavailable'
  await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.managedHarnessCatalog }) })
  expect(screen.queryByRole('button', { name: 'View details for private-tools, Enabled' })).not.toBeInTheDocument()
  outcome = 'ready'
  await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.managedHarnessCatalog }) })
  expect(await screen.findByRole('button', { name: 'View details for private-tools, Enabled' })).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Server name' })).toHaveValue('draft-tools')
  expect(screen.getByRole('button', { name: 'Review connection' })).toBeEnabled()
})
