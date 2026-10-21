import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it, vi } from 'vitest'
import { server } from '../../mocks/server'
import { ClaudePluginSummary } from './ClaudePluginSummary'
import { CodexPluginManager } from './CodexPluginManager'

const navigation = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => ({ pluginView: 'available', pluginId: 'notes@trusted' }),
  useNavigate: () => navigation,
}))

const clients: QueryClient[] = []
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
})

it.each(['codex', 'claude'])('hides warm %s plugin facts immediately when the parent loses read access', async harness => {
  const revision = 'sha256:' + 'a'.repeat(64)
  const plugin = { pluginId: 'notes@trusted', name: 'notes', marketplaceName: 'trusted', version: '1',
    installed: false, enabled: false, sourceType: 'remote', installPolicy: 'AVAILABLE', authPolicy: 'ON_USE' }
  let reads = 0
  server.use(
    http.get('/api/management/harnesses/codex/plugins/operations', () => {
      reads++
      return HttpResponse.json({ items: [] })
    }),
    http.get('/api/management/harnesses/codex/plugins/:pluginId', () => {
      reads++
      return HttpResponse.json({ plugin, revision, artifactIdentity: revision, contents: { status: 'unknown' } })
    }),
    http.get('/api/management/harnesses/codex/plugins', () => {
      reads++
      return HttpResponse.json({ items: [plugin], total: 1, nextOffset: null, revision,
        checkedAt: new Date().toISOString(), catalogStatus: 'complete', inventoryStatus: 'unknown' })
    }),
    http.get('/api/management/harnesses/claude/plugins', () => {
      reads++
      return HttpResponse.json({ items: [{ pluginId: plugin.pluginId, name: 'notes', marketplaceName: 'trusted',
        version: '1', description: null, installed: false, enabled: false, installCount: null }],
      total: 1, nextOffset: null, revision: 'a'.repeat(64), checkedAt: new Date().toISOString(), marketplaces: [] })
    }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const show = (accessUnavailable: boolean) => <QueryClientProvider client={client}>
    {harness === 'codex' ? <CodexPluginManager accessUnavailable={accessUnavailable} />
      : <ClaudePluginSummary accessUnavailable={accessUnavailable} onClose={vi.fn()} />}
  </QueryClientProvider>
  const view = render(show(false))
  const cardName = harness === 'codex' ? 'View notes plugin, available' : 'Ask Operator to install notes'
  await screen.findByRole('button', { name: cardName })
  if (harness === 'codex') {
    await waitFor(() => expect(screen.getByRole('button', { name: 'Install plugin' })).toBeEnabled())
  }
  const initialReads = reads
  view.rerender(show(true))
  expect(screen.queryByRole('button', { name: cardName })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Install plugin' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled()
  await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh' }))
  if (harness === 'codex') {
    const dialog = within(screen.getByRole('dialog', { name: 'Plugin details' }))
    expect(dialog.getByRole('button', { name: 'Refresh plugin' })).toBeDisabled()
    expect(dialog.getByRole('alert')).toHaveTextContent('Plugin access unavailable')
    expect(dialog.queryByText('trusted')).not.toBeInTheDocument()
  } else {
    expect(screen.getByRole('alert')).toHaveTextContent('Plugin access unavailable')
  }
  expect(reads).toBe(initialReads)
})
