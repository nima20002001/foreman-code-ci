import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it, vi } from 'vitest'
import type { HarnessDefaultsUpdateInputSchema } from '@foreman-code/contracts/management'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { server } from '../../mocks/server'
import { OperatorMcpStatus } from './OperatorMcpStatus'
import { savedClaudeConfiguration } from './claudeSettings.fixtures'

const revision = 'sha256:' + 'a'.repeat(64)
type DefaultsUpdate = ReturnType<typeof HarnessDefaultsUpdateInputSchema.parse>
const checkedAt = '2026-09-20T00:00:00.000Z'
const clients: QueryClient[] = []
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); vi.useRealTimers() })
function mount(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  const rendered = render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
  return { ...rendered, client, update: (next: React.ReactNode) => rendered.rerender(<QueryClientProvider client={client}>{next}</QueryClientProvider>) }
}

it('installs the Operator MCP on Codex in one click and shows the read-back state', async () => {
  let installed = false
  const inputs: unknown[] = []
  server.use(
    http.get('/api/management/harnesses/codex/mcp', () => HttpResponse.json({ harness: 'codex', revision, checkedAt, scope: 'native-user', servers: [],
      presets: { graphql: installed ? 'installed' : 'missing', linear: 'missing' } })),
    http.get('/api/management/harnesses/codex/mcp/plans', () => HttpResponse.json({ items: [] })),
    http.post('/api/management/harnesses/mcp/managed', async ({ request }) => {
      inputs.push(await request.json()); installed = true
      return HttpResponse.json({ id: crypto.randomUUID(), harness: 'codex', revision,
        change: { kind: 'add', name: 'graphql', connection: { transport: 'remote', url: 'http://127.0.0.1:3000/mcp' } },
        managedPreset: 'graphql', requestedBy: 'owner', status: 'applied', createdAt: checkedAt, expiresAt: checkedAt, error: null })
    }),
  )
  mount(<OperatorMcpStatus harness="codex" defaults={DEFAULT_HARNESS_DEFAULTS} revision={3} />)
  expect(await screen.findByText('Not installed')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Install' }))
  expect(await screen.findByText('Installed')).toBeVisible()
  expect(inputs).toMatchObject([{ harness: 'codex', preset: 'graphql', installed: true, expectedRevision: revision }])
  expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument()
})

it('adds this app MCP endpoint to the saved Claude preset in one click', async () => {
  const saved: Array<{ defaults: { claude?: { mcpServers: Record<string, unknown> } }; expectedRevision: number }> = []
  const endpoint = { type: 'http', url: 'http://127.0.0.1:3000/mcp' }
  const claude = { ...savedClaudeConfiguration, mcpServers: {} }
  server.use(
    http.get('/api/management/harnesses/claude/setup-options', () => HttpResponse.json({ graphqlMcp: endpoint })),
    http.put('/api/management/harnesses/defaults', async ({ request }) => {
      const body = await request.json() as typeof saved[number]; saved.push(body)
      return HttpResponse.json({ value: { defaults: body.defaults, revision: 4 }, replayed: false })
    }),
  )
  mount(<OperatorMcpStatus harness="claude" defaults={{ ...DEFAULT_HARNESS_DEFAULTS, claude }} revision={3} />)
  const install = await screen.findByRole('button', { name: 'Install' })
  await waitFor(() => expect(install).toBeEnabled())
  fireEvent.click(install)
  await waitFor(() => expect(saved).toHaveLength(1))
  expect(saved[0]!.expectedRevision).toBe(3)
  expect(Object.values(saved[0]!.defaults.claude!.mcpServers)).toEqual([endpoint])
})

it.each(['foreman-code', 'graphql'])('reports Claude as installed when %s matches the app MCP endpoint', async (name) => {
  const endpoint = { type: 'http' as const, url: 'http://127.0.0.1:3000/mcp' }
  server.use(http.get('/api/management/harnesses/claude/setup-options', () => HttpResponse.json({ graphqlMcp: endpoint })))
  mount(<OperatorMcpStatus harness="claude" revision={3}
    defaults={{ ...DEFAULT_HARNESS_DEFAULTS, claude: { ...savedClaudeConfiguration, mcpServers: { [name]: endpoint } } }} />)
  expect(await screen.findByText('Installed')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument()
})

it.each([
  ['foreman-code', 'http://127.0.0.1:3999/mcp'],
  ['graphql', 'https://example.com/mcp'],
])('repairs an outdated Claude %s endpoint only after Update is clicked', async (name, url) => {
  const inputs: DefaultsUpdate[] = []
  const endpoint = { type: 'http' as const, url: 'http://127.0.0.1:3000/mcp' }
  const defaults = {
    ...DEFAULT_HARNESS_DEFAULTS,
    claude: { ...savedClaudeConfiguration, mcpServers: { [name]: { type: 'http' as const, url } } },
  }
  server.use(
    http.get('/api/management/harnesses/claude/setup-options', () => HttpResponse.json({ graphqlMcp: endpoint })),
    http.put('/api/management/harnesses/defaults', async ({ request }) => {
      const input = await request.json() as DefaultsUpdate
      inputs.push(input)
      return HttpResponse.json({ value: { defaults: input.defaults, revision: 4 }, replayed: false })
    }),
  )
  const mounted = mount(<OperatorMcpStatus harness="claude" defaults={defaults} revision={3} />)
  expect(await screen.findByText('Outdated')).toBeVisible()
  expect(screen.queryByText('Installed')).not.toBeInTheDocument()
  expect(inputs).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Update' }))
  await waitFor(() => expect(inputs).toHaveLength(1))
  expect(inputs[0]).toMatchObject({
    expectedRevision: 3,
    defaults: { ...defaults, claude: { ...defaults.claude, mcpServers: { [name]: endpoint } } },
  })
  expect(Object.keys(inputs[0]!.defaults.claude!.mcpServers)).toEqual([name])
  mounted.update(<OperatorMcpStatus harness="claude" defaults={inputs[0]!.defaults} revision={4} />)
  expect(screen.getByText('Installed')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument()
})

it('uses a new Claude command after a completed install is removed in another session', async () => {
  const inputs: DefaultsUpdate[] = []
  const endpoint = { type: 'http' as const, url: 'http://127.0.0.1:3000/mcp' }
  const defaults = { ...DEFAULT_HARNESS_DEFAULTS, claude: { ...savedClaudeConfiguration, mcpServers: {} } }
  server.use(
    http.get('/api/management/harnesses/claude/setup-options', () => HttpResponse.json({ graphqlMcp: endpoint })),
    http.put('/api/management/harnesses/defaults', async ({ request }) => {
      const input = await request.json() as DefaultsUpdate
      inputs.push(input)
      return HttpResponse.json({ value: { defaults: input.defaults, revision: (input.expectedRevision ?? 0) + 1 }, replayed: false })
    }),
  )
  const mounted = mount(<OperatorMcpStatus harness="claude" defaults={defaults} revision={3} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Install' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Install' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Install' })).toBeEnabled())
  expect(inputs).toHaveLength(1)
  mounted.update(<OperatorMcpStatus harness="claude" defaults={{ ...defaults,
    claude: { ...defaults.claude, mcpServers: { 'foreman-code': endpoint } } }} revision={4} />)
  expect(screen.getByText('Installed')).toBeVisible()
  mounted.update(<OperatorMcpStatus harness="claude" defaults={defaults} revision={5} />)
  fireEvent.click(screen.getByRole('button', { name: 'Install' }))
  await waitFor(() => expect(inputs).toHaveLength(2))
  expect(inputs[1]!.expectedRevision).toBe(5)
  expect(inputs[1]!.commandId).not.toBe(inputs[0]!.commandId)
})

it.each([500, 502, 503, 'restart'] as const)('retries uncertain Claude installation with its original command and payload after defaults advance (%s)', async failure => {
  const inputs: DefaultsUpdate[] = []
  const defaults = { ...DEFAULT_HARNESS_DEFAULTS, claude: { ...savedClaudeConfiguration, mcpServers: {} } }
  server.use(
    http.get('/api/management/harnesses/claude/setup-options', () => HttpResponse.json({
      graphqlMcp: { type: 'http', url: 'http://127.0.0.1:3000/mcp' },
    })),
    http.put('/api/management/harnesses/defaults', async ({ request }) => {
      const input = await request.json() as DefaultsUpdate
      inputs.push(input)
      if (inputs.length === 1) return failure === 'restart' ? new HttpResponse(null, { status: 503 })
        : HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Response lost' } }, { status: failure })
      return HttpResponse.json({ value: { defaults: input.defaults, revision: 4 }, replayed: true })
    }),
  )
  const mounted = mount(<OperatorMcpStatus harness="claude" defaults={defaults} revision={3} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Install' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Install' }))
  const expectedMessage = failure === 'restart' ? 'Updating — reconnecting…' : 'Response lost'
  expect(await screen.findByRole('alert')).toHaveTextContent(expectedMessage)
  mounted.update(<OperatorMcpStatus harness="claude" defaults={defaults} revision={9} />)
  fireEvent.click(screen.getByRole('button', { name: 'Install' }))
  await waitFor(() => expect(inputs).toHaveLength(2))
  expect(inputs[1]).toEqual(inputs[0])
})

it('shows a definitive Codex rejection until the user refreshes setup', async () => {
  server.use(
    http.get('/api/management/harnesses/codex/mcp', () => HttpResponse.json({ harness: 'codex', revision, checkedAt,
      scope: 'native-user', servers: [], presets: { graphql: 'missing', linear: 'missing' } })),
    http.get('/api/management/harnesses/codex/mcp/plans', () => HttpResponse.json({ items: [] })),
    http.post('/api/management/harnesses/mcp/managed', () => HttpResponse.json({
      error: { code: 'MCP_REVISION_CONFLICT', message: 'Connection settings changed. Refresh before installing.' },
    }, { status: 409 })),
  )
  mount(<OperatorMcpStatus harness="codex" defaults={DEFAULT_HARNESS_DEFAULTS} revision={3} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Install' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Connection settings changed.')
  expect(screen.queryByRole('button', { name: 'Retry install' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh setup' }))
  expect(await screen.findByRole('button', { name: 'Install' })).toBeEnabled()
})

it('shows inherited disabled app MCP as disabled with source guidance', async () => {
  server.use(
    http.get('/api/management/harnesses/codex/mcp', () => HttpResponse.json({ harness: 'codex', revision, checkedAt,
      scope: 'native-user', servers: [{ name: 'foreman-code', transport: 'stdio', label: 'App launcher', enabled: false,
        origin: 'inherited', protected: true, editable: false }], presets: { graphql: 'inherited', linear: 'missing' } })),
    http.get('/api/management/harnesses/codex/mcp/plans', () => HttpResponse.json({ items: [] })),
  )
  mount(<OperatorMcpStatus harness="codex" defaults={DEFAULT_HARNESS_DEFAULTS} revision={3} />)
  expect(await screen.findByText('Disabled')).toBeVisible()
  expect(screen.getByText('From another Codex config layer. Change it at its source.')).toBeVisible()
  expect(screen.queryByText('Installed')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Enable' })).not.toBeInTheDocument()
})

it.each([500, 502, 503])('explains a failed Claude setup read and retries it without leaving the page (%s)', async status => {
  let unavailable = true
  server.use(http.get('/api/management/harnesses/claude/setup-options', () => unavailable
    ? HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Setup could not load' } }, { status })
    : HttpResponse.json({ graphqlMcp: { type: 'http', url: 'http://127.0.0.1:3000/mcp' } })))
  mount(<OperatorMcpStatus harness="claude" revision={3}
    defaults={{ ...DEFAULT_HARNESS_DEFAULTS, claude: { ...savedClaudeConfiguration, mcpServers: {} } }} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Setup could not load')
  expect(screen.getByText('Unavailable')).toBeVisible()
  unavailable = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry setup' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Install' })).toBeEnabled())
  expect(screen.queryByText('Unavailable')).not.toBeInTheDocument()
})

it('refreshes the mounted MCP badge in a second query client after another client installs it', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  let installed = false
  server.use(
    http.get('/api/management/harnesses/codex/mcp', () => HttpResponse.json({ harness: 'codex', revision, checkedAt,
      scope: 'native-user', servers: [], presets: { graphql: installed ? 'installed' : 'missing', linear: 'missing' } })),
    http.get('/api/management/harnesses/codex/mcp/plans', () => HttpResponse.json({ items: [] })),
    http.post('/api/management/harnesses/mcp/managed', () => {
      installed = true
      return HttpResponse.json({ id: crypto.randomUUID(), harness: 'codex', revision,
        change: { kind: 'add', name: 'foreman-code', connection: { transport: 'remote', url: 'http://127.0.0.1:3000/mcp' } },
        managedPreset: 'graphql', requestedBy: 'owner', status: 'applied', createdAt: checkedAt, expiresAt: checkedAt, error: null })
    }),
  )
  mount(<section aria-label="Browser A"><OperatorMcpStatus harness="codex" defaults={DEFAULT_HARNESS_DEFAULTS} revision={3} /></section>)
  mount(<section aria-label="Browser B"><OperatorMcpStatus harness="codex" defaults={DEFAULT_HARNESS_DEFAULTS} revision={3} /></section>)
  const browserA = within(screen.getByRole('region', { name: 'Browser A' }))
  const browserB = within(screen.getByRole('region', { name: 'Browser B' }))
  await act(async () => {
    await vi.waitFor(() => expect(browserA.getByRole('button', { name: 'Install' })).toBeEnabled())
    await vi.waitFor(() => expect(browserB.getByRole('button', { name: 'Install' })).toBeEnabled())
  })
  fireEvent.click(browserA.getByRole('button', { name: 'Install' }))
  await act(async () => { await vi.waitFor(() => expect(browserA.getByText('Installed')).toBeVisible()) })
  expect(browserB.getByText('Not installed')).toBeVisible()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.waitFor(() => expect(browserB.getByText('Installed')).toBeVisible())
  })
})
