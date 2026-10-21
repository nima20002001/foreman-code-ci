import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { configuredOperatorSetup, unconfiguredOperatorSetup } from '../../features/operator-chat/operatorSetupTestFixture'
import { OperatorSetupNotice } from '../../features/operator-chat/OperatorSetupNotice'
import { useOperatorChatSetup } from './operatorChatSetup'
import { beginSessionChange, finishSessionChange } from './sessionBoundary'

let client: QueryClient
afterEach(() => { cleanup(); client?.clear() })
function Setup({ revision = 1, harness = 'codex' }: { revision?: number; harness?: 'codex' | 'claude' }) {
  const query = useOperatorChatSetup(true, revision, { harness })
  return <OperatorSetupNotice data={query.data} checking={query.isFetching} failed={query.isError} onRetry={() => void query.refetch()} />
}

it('reuses verified installation across chat remounts and rechecks when configuration is invalidated', async () => {
  let checks = 0
  let configured = true
  server.use(http.get('/api/operator/setup', () => { checks++; return HttpResponse.json(configured ? configuredOperatorSetup('codex') : unconfiguredOperatorSetup('codex')) }))
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const mount = () => render(<QueryClientProvider client={client}><Setup /></QueryClientProvider>)
  mount()
  await waitFor(() => expect(client.getQueryCache().findAll({ queryKey: ['operator-chat', 'setup'] })[0]?.state.status).toBe('success'))
  expect(checks).toBe(1)
  cleanup(); mount()
  expect(screen.queryByText('Checking Foreman Code MCP installation…')).not.toBeInTheDocument()
  await waitFor(() => expect(checks).toBe(1))
  configured = false
  await client.invalidateQueries({ queryKey: ['operator-chat', 'setup'] })
  expect(await screen.findByText('Install Foreman Code MCP in Codex first')).toBeVisible()
  expect(checks).toBe(2)
})

it.each([403, 503])('retains a real setup failure (%s) and recovers only after authenticated readback succeeds', async (status) => {
  let available = false
  let calls = 0
  server.use(http.get('/api/operator/setup', ({ request }) => {
    const query = new URL(request.url).searchParams
    expect(query.get('harness')).toBe('claude')
    expect(query.get('expectedDefaultsRevision')).toBe('4')
    expect(query.has('conversationId')).toBe(false)
    calls++
    return available ? HttpResponse.json({ ...configuredOperatorSetup('claude'), configurationVersionId: 'qualified-claude-config' })
      : HttpResponse.json({ error: { code: status === 403 ? 'ACCESS_DENIED' : 'OPERATOR_SETUP_INSPECTION_UNAVAILABLE', message: 'Inspection unavailable' } }, { status })
  }))
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const mount = () => render(<QueryClientProvider client={client}><Setup revision={4} harness="claude" /></QueryClientProvider>)
  mount()
  expect(await screen.findByText('Tool connection check failed')).toBeVisible()
  expect(client.getQueryCache().findAll({ queryKey: ['operator-chat', 'setup'] })[0]?.state.data).toBeUndefined()
  fireEvent.click(screen.getByText('Tool connection check failed'))
  expect(screen.getByText('Check the tool connection before sending a message.')).toBeVisible()
  available = true
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
  await waitFor(() => expect(screen.queryByText('Tool connection check failed')).not.toBeInTheDocument())
  expect(calls).toBe(2)
  cleanup(); mount()
  expect(screen.queryByText('Checking Foreman Code MCP installation…')).not.toBeInTheDocument()
  expect(calls).toBe(2)
})

it('uses a fresh checked configuration after a Claude profile revision or browser authority changes', async () => {
  const calls: string[] = []
  server.use(http.get('/api/operator/setup', ({ request }) => {
    const revision = new URL(request.url).searchParams.get('expectedDefaultsRevision')
    calls.push(revision ?? '')
    return HttpResponse.json({ ...configuredOperatorSetup('claude'), configurationVersionId: `profile-config-${revision}` })
  }))
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const ui = (revision: number) => <QueryClientProvider client={client}><Setup revision={revision} harness="claude" /></QueryClientProvider>
  const view = render(ui(4))
  await waitFor(() => expect(calls).toEqual(['4']))
  view.rerender(ui(5))
  await waitFor(() => expect(calls).toEqual(['4', '5']))
  beginSessionChange(); finishSessionChange()
  view.rerender(ui(5))
  await waitFor(() => expect(calls).toEqual(['4', '5', '5']))
})

it('rechecks changed defaults and selected harness instead of inheriting another configuration success', async () => {
  const targets: string[] = []
  server.use(http.get('/api/operator/setup', ({ request }) => {
    const query = new URL(request.url).searchParams
    targets.push(`${query.get('harness')}:${query.get('expectedDefaultsRevision')}`)
    return HttpResponse.json(configuredOperatorSetup(query.get('harness') === 'claude' ? 'claude' : 'codex'))
  }))
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const ui = (revision: number, harness: 'codex' | 'claude') => <QueryClientProvider client={client}><Setup revision={revision} harness={harness} /></QueryClientProvider>
  const view = render(ui(1, 'codex'))
  await waitFor(() => expect(targets).toEqual(['codex:1']))
  view.rerender(ui(2, 'codex'))
  await waitFor(() => expect(targets).toEqual(['codex:1', 'codex:2']))
  view.rerender(ui(2, 'claude'))
  await waitFor(() => expect(targets).toEqual(['codex:1', 'codex:2', 'claude:2']))
})
